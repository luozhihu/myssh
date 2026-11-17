import type { Client, ClientChannel, TerminalModes } from "ssh2";
import type { Proxy, SSHServer } from "../config/types.js";
import { nullLogger, type Logger } from "../log.js";
import { PtyConn } from "../pty/pty_conn.js";
import type { PtyTransport } from "../pty/transport.js";
import { Dialer } from "./dialer.js";
import type { KnownHostsStore } from "./known_hosts.js";
import type { LoginTraceEntry } from "./types.js";

const OPEN_PTY_TIMEOUT_MS = 15_000;
const SFTP_PROBE_TIMEOUT_MS = 5_000;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** ssh2 channel → PtyTransport。负责数据/关闭事件与 sftp 可用性探测。 */
class SshChannelTransport implements PtyTransport {
  private readonly dataHandlers = new Set<(data: Buffer) => void>();
  private readonly closeHandlers = new Set<(err?: Error) => void>();
  private closeFired = false;

  constructor(
    private readonly client: Client,
    private readonly channel: ClientChannel,
    private readonly logger: Logger,
  ) {
    channel.on("data", (data: Buffer) => {
      for (const handler of this.dataHandlers) handler(data);
    });
    channel.on("end", () => this.fireClose());
    channel.on("close", () => this.fireClose());
    channel.on("error", (err: Error) => this.fireClose(err));
  }

  write(data: Buffer | string): void {
    this.channel.write(data);
  }

  onData(handler: (data: Buffer) => void): () => void {
    this.dataHandlers.add(handler);
    return () => this.dataHandlers.delete(handler);
  }

  onClose(handler: (err?: Error) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  probeSftp(): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => finish(false), SFTP_PROBE_TIMEOUT_MS);
      try {
        this.client.sftp((err, sftp) => {
          if (err || !sftp) {
            this.logger.debug("sftp channel unavailable", {
              err: err ? err.message : "no client",
            });
            finish(false);
            return;
          }
          try { sftp.end(); } catch { /* ignore */ }
          finish(true);
        });
      } catch (err) {
        this.logger.debug("sftp channel unavailable", { err: message(err) });
        finish(false);
      }
    });
  }

  close(): void {
    this.fireClose();
    try { this.channel.end(); } catch { /* ignore */ }
    try { this.client.end(); } catch { /* ignore */ }
  }

  private fireClose(err?: Error): void {
    if (this.closeFired) return;
    this.closeFired = true;
    for (const handler of this.closeHandlers) handler(err);
  }
}

/** 分配 PTY + 启动 shell；15s 硬超时（SSH 协议请求无 per-op 超时）。 */
export async function openPty(
  client: Client,
  sid: string,
  logger: Logger = nullLogger,
): Promise<PtyConn> {
  const term = process.env.TERM || "xterm-256color";
  // @types/ssh2 声明了命名 key，但运行时需要 numeric opcode：
  // ECHO=53, TTY_OP_ISPEED=128, TTY_OP_OSPEED=129。
  const modes = { 53: 0, 128: 14400, 129: 14400 } as unknown as TerminalModes;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const opened = new Promise<ClientChannel>((resolve, reject) => {
    try {
      client.shell({ term, rows: 100, cols: 120, modes }, {}, (err, channel) => {
        if (err) reject(new Error(`request pty: ${err.message}`));
        else resolve(channel);
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try { client.end(); } catch { /* ignore */ }
      reject(new Error(`open pty timed out after ${OPEN_PTY_TIMEOUT_MS / 1000}s`));
    }, OPEN_PTY_TIMEOUT_MS);
  });
  try {
    const channel = await Promise.race([opened, timedOut]);
    return new PtyConn(new SshChannelTransport(client, channel, logger), sid, { logger });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface DirectSetupResult {
  conn: PtyConn;
  loginTrace: LoginTraceEntry[];
  sftpAvailable: boolean;
}

/** 直连：dial → open pty → raw 标记或 detect+RC → sftp 探测。 */
export async function setupDirect(options: {
  server: SSHServer;
  proxy?: Proxy;
  sid: string;
  knownHosts: KnownHostsStore;
  logger?: Logger;
}): Promise<DirectSetupResult> {
  const logger = options.logger ?? nullLogger;
  const server = options.server;
  const dialer = new Dialer(options.knownHosts, logger);
  let client: Client;
  try {
    client = await dialer.dial({
      addr: server.addr,
      user: server.user,
      auth: server.auth,
      proxy: options.proxy,
      serverName: server.name,
      hostKeyVerify: server.host_key_verify !== false,
    });
  } catch (err) {
    throw new Error(`ssh connect to ${server.addr}: ${message(err)}`);
  }

  let conn: PtyConn;
  try {
    conn = await openPty(client, options.sid, logger);
  } catch (err) {
    try { client.end(); } catch { /* ignore */ }
    throw new Error(`setup pty: ${message(err)}`);
  }

  const loginTrace: LoginTraceEntry[] = [];
  try {
    if (server.raw) {
      conn.markRaw();
    } else {
      await conn.detectShell();
      loginTrace.push(await conn.injectRC());
    }
  } catch (err) {
    conn.close();
    throw err;
  }

  const sftpAvailable = await conn.probeSftp();
  return { conn, loginTrace, sftpAvailable };
}
