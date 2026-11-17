import type { Config, Jumphost, SSHServer } from "../config/types.js";
import { nullLogger } from "../log.js";
import { randomSID } from "../util/random.js";
import { KnownHostsStore } from "../ssh/known_hosts.js";
import { setupCliServer } from "../ssh/login.js";
import { SessionManager } from "../session/manager.js";
import type { Session } from "../session/session.js";
import { envOf, stderrTTY, type IO } from "./io.js";
import { knownHostsPathFor, loadConfigForCli } from "./config_util.js";
import { resolveServer } from "./resolve.js";

export function sftpUnavailableReason(server: SSHServer, jump?: Jumphost): string {
  if (jump && !jump.ssh_j) {
    return `server ${server.name} uses bastion mode (ssh_j=false); sftp lands on the jumphost, not the target — use a direct or ssh_j=true connection`;
  }
  return `sftp channel unavailable for ${server.name} (server may not support the sftp subsystem)`;
}

export interface FileLoginOptions {
  cfg: Config;
  configPath: string;
  name: string;
  allowPrompt: boolean;
  io: IO;
}

/**
 * Resolve + dial + enable sftp and register a session with idleTimeout=0.
 * Throws with the user-facing reason when sftp is unavailable (Pattern B).
 */
export async function loginFileSession(
  manager: SessionManager,
  options: FileLoginOptions,
): Promise<{ sid: string; server: SSHServer; session: Session }> {
  const { io } = options;
  const server = await resolveServer(options.cfg, options.name, options.allowPrompt, {
    err: io.err,
    readLine: async () => (io.readLine ? io.readLine() : null),
  });
  const jump = server.via
    ? options.cfg.jumphosts.find((item) => item.name === server.via)
    : undefined;
  if (server.via && !jump) {
    throw new Error(`jumphost ${JSON.stringify(server.via)} not found`);
  }
  const serverProxy = server.proxy
    ? options.cfg.proxies.find((proxy) => proxy.name === server.proxy)
    : undefined;
  const jumpProxy = jump?.proxy
    ? options.cfg.proxies.find((proxy) => proxy.name === jump.proxy)
    : undefined;

  const sid = randomSID();
  const tty = stderrTTY(io);
  if (tty) io.err(`connecting to ${server.name}...\r`);
  let result;
  try {
    result = await setupCliServer({
      sid,
      knownHosts: new KnownHostsStore(knownHostsPathFor(options.configPath)),
      server,
      jump,
      serverProxy,
      jumpProxy,
      needShell: false,
      needSftp: true,
      logger: nullLogger,
    });
  } finally {
    if (tty) io.err("\r\x1b[J");
  }

  if (!result.sftpAvailable || !result.sftp) {
    result.conn.close();
    throw new Error(sftpUnavailableReason(server, jump));
  }
  const session = manager.newSession(sid, server.name, result.conn, 0, {
    sftp: result.sftp,
    sftpAvailable: true,
    tags: server.tags,
    loginFlowTrace: result.loginTrace,
  });
  return { sid, server, session };
}

/** Load config, create a manager, and run fn inside one file session. */
export async function withFileSession(
  parsed: { config?: string; name: string },
  io: IO,
  fn: (ctx: {
    cfg: Config;
    configPath: string;
    manager: SessionManager;
    session: Session;
    server: SSHServer;
  }) => Promise<number>,
): Promise<number> {
  let loaded: { path: string; cfg: Config };
  try {
    loaded = await loadConfigForCli(parsed.config, envOf(io));
  } catch (err) {
    io.out(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  const manager = new SessionManager();
  try {
    const login = await loginFileSession(manager, {
      cfg: loaded.cfg,
      configPath: loaded.path,
      name: parsed.name,
      allowPrompt: true,
      io,
    });
    return await fn({
      cfg: loaded.cfg,
      configPath: loaded.path,
      manager,
      session: login.session,
      server: login.server,
    });
  } catch (err) {
    io.out(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  } finally {
    manager.closeAll();
  }
}
