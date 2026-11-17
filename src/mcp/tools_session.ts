import type { Jumphost, Proxy } from "../config/types.js";
import { setupServer } from "../ssh/login.js";
import { LoginFlowError } from "../ssh/types.js";
import { randomSID } from "../util/random.js";
import type { Service } from "./service.js";
import { errorResult, textResult } from "./result.js";

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function loginTool(
  svc: Service,
  args: { name: string },
) {
  try {
    const cfg = await svc.store.load();
    const server = cfg.servers.find((item) => item.name === args.name);
    if (!server) return errorResult(`ssh server ${JSON.stringify(args.name)} not found`);

    let jump: Jumphost | undefined;
    if (server.via) {
      jump = cfg.jumphosts.find((item) => item.name === server.via);
      if (!jump) return errorResult(`jumphost ${JSON.stringify(server.via)} not found`);
    }

    let serverProxy: Proxy | undefined;
    if (server.proxy) {
      serverProxy = cfg.proxies.find((item) => item.name === server.proxy);
      if (!serverProxy) return errorResult(`proxy ${JSON.stringify(server.proxy)} not found`);
    }
    let jumpProxy: Proxy | undefined;
    if (jump?.proxy) {
      jumpProxy = cfg.proxies.find((item) => item.name === jump!.proxy);
      if (!jumpProxy) return errorResult(`proxy ${JSON.stringify(jump.proxy)} not found`);
    }

    const sid = randomSID();
    const setup = await setupServer({
      server,
      jump,
      serverProxy,
      jumpProxy,
      sid,
      knownHosts: svc.knownHosts,
      logger: svc.logger,
    });
    const idleSeconds = cfg.idle_timeout_s || 300;
    svc.manager.newSession(sid, server.name, setup.conn, idleSeconds * 1000, {
      tags: server.tags ?? [],
      raw: !!server.raw,
      sftpAvailable: setup.sftpAvailable,
      loginFlowTrace: setup.loginTrace,
    });
    const tags = server.tags ?? [];
    return textResult({
      sid,
      server_name: server.name,
      sftp_available: setup.sftpAvailable,
      mode: server.raw ? "raw" : "shell",
      tags,
    });
  } catch (err) {
    if (err instanceof LoginFlowError) {
      return errorResult(JSON.stringify({
        error: err.message,
        login_trace: err.trace,
      }, null, 2));
    }
    return errorResult(message(err));
  }
}

export async function runInSessionTool(
  svc: Service,
  args: { sid: string; cmd: string; timeout_ms?: number; max_output_bytes?: number },
) {
  try {
    const session = svc.manager.get(args.sid);
    const result = await session.run(args.cmd, args.timeout_ms ?? 0, args.max_output_bytes ?? 0);
    return textResult(result);
  } catch (err) {
    return errorResult(message(err));
  }
}

export async function closeSessionTool(svc: Service, args: { sid: string }) {
  try {
    const session = svc.manager.get(args.sid);
    session.close();
    return textResult({ sid: args.sid, closed: true });
  } catch (err) {
    return errorResult(message(err));
  }
}

export async function statTool(svc: Service) {
  return textResult(svc.manager.stat());
}

export async function getTraceTool(
  svc: Service,
  args: { sid: string; last_n?: number; trunc_output?: number },
) {
  try {
    const commands = svc.manager.getTrace(args.sid, args.last_n ?? 0, args.trunc_output ?? 0);
    const alive = svc.manager.find(args.sid);
    return textResult({
      commands,
      login_flow: alive ? alive.loginFlowTrace() : null,
    });
  } catch (err) {
    return errorResult(message(err));
  }
}
