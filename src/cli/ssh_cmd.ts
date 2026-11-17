import type { Config, Jumphost, Proxy, SSHServer } from "../config/types.js";
import { nullLogger } from "../log.js";
import { randomSID } from "../util/random.js";
import { KnownHostsStore } from "../ssh/known_hosts.js";
import { setupCliJumphost, setupCliServer } from "../ssh/login.js";
import { relayTerminal } from "../pty/relay_terminal.js";
import { envOf, readLineOf, terminalOf, type IO } from "./io.js";
import { takeConfigFlag } from "./flags.js";
import { loadConfigForCli, knownHostsPathFor } from "./config_util.js";
import { resolveTarget, type SSHTarget } from "./resolve.js";

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function findProxy(cfg: Config, name: string | undefined): Proxy | undefined {
  return name ? cfg.proxies.find((proxy) => proxy.name === name) : undefined;
}

function findJump(cfg: Config, server: SSHServer): Jumphost | undefined {
  return server.via
    ? cfg.jumphosts.find((jump) => jump.name === server.via)
    : undefined;
}

export async function runSSHCmd(args: string[], io: IO): Promise<number> {
  let parsed: { config?: string; rest: string[] };
  try {
    parsed = takeConfigFlag(args);
  } catch (err) {
    io.out(`Error: ${message(err)}\n`);
    return 2;
  }
  if (parsed.rest.length === 0 || parsed.rest.length > 2) {
    io.out("Usage: myssh ssh <name> [command]\n");
    if (parsed.rest.length > 2) {
      io.out(
        `Error: expected 1 or 2 positional args, got ${parsed.rest.length} ([${parsed.rest.join(" ")}])\n`,
      );
    }
    return 2;
  }
  const name = parsed.rest[0]!;
  const command = parsed.rest[1] ?? "";
  const env = envOf(io);

  let cfg: Config;
  let configPath: string;
  try {
    const loaded = await loadConfigForCli(parsed.config, env);
    cfg = loaded.cfg;
    configPath = loaded.path;
  } catch (err) {
    io.out(`Error: ${message(err)}\n`);
    return 1;
  }

  let target: SSHTarget;
  try {
    target = await resolveTarget(cfg, name, command === "", {
      err: io.err,
      readLine: () => readLineOf(io),
    });
  } catch (err) {
    io.out(`Error: ${message(err)}\n`);
    return 1;
  }

  if (target.kind === "server" && command !== "" && target.server.raw) {
    io.out(
      "Error: raw device: no unix shell, non-interactive mode not supported; use interactive mode\n",
    );
    return 1;
  }
  if (target.kind === "jumphost" && command !== "" && !target.jump.ssh_j) {
    io.out(
      `Error: non-interactive command not supported for bastion ${JSON.stringify(target.jump.name)} (ssh_j=false lands on an interactive menu, not a shell); use interactive mode: sshmng ssh ${target.jump.name}\n`,
    );
    return 1;
  }

  const sid = randomSID();
  const knownHosts = new KnownHostsStore(knownHostsPathFor(configPath));
  let login;
  try {
    if (target.kind === "server") {
      const server = target.server;
      const jump = findJump(cfg, server);
      login = await setupCliServer({
        sid,
        knownHosts,
        server,
        jump,
        serverProxy: findProxy(cfg, server.proxy),
        jumpProxy: findProxy(cfg, jump?.proxy),
        needShell: command !== "",
        needSftp: false,
        logger: nullLogger,
      });
    } else {
      login = await setupCliJumphost({
        sid,
        knownHosts,
        jump: target.jump,
        proxy: findProxy(cfg, target.jump.proxy),
        needShell: command !== "",
        logger: nullLogger,
      });
    }
  } catch (err) {
    io.out(`Error: ${message(err)}\n`);
    return 1;
  }

  if (command !== "") {
    try {
      const outcome = await login.conn.run(command);
      io.out(outcome.output);
      return outcome.exitCode > 0 ? outcome.exitCode : 0;
    } catch (err) {
      io.out(`Error: ${message(err)}\n`);
      return 1;
    } finally {
      login.conn.close();
    }
  }

  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  process.once("SIGTERM", onSignal);
  process.once("SIGHUP", onSignal);
  try {
    await relayTerminal(login.conn, terminalOf(io), { signal: controller.signal });
    return 0;
  } catch (err) {
    io.out(`\nError: ${message(err)}\n`);
    return 1;
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGHUP", onSignal);
    login.conn.close();
  }
}
