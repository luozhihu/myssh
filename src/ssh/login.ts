import type { Client, ClientChannel, TerminalModes } from "ssh2";
import type { Jumphost, LoginAction, Proxy, SSHServer } from "../config/types.js";
import { nullLogger, type Logger } from "../log.js";
import { PtyConn } from "../pty/pty_conn.js";
import type { PtyTransport } from "../pty/transport.js";
import { openSftp, type SftpClient } from "../sftp/client.js";
import { Dialer } from "./dialer.js";
import type { KnownHostsStore } from "./known_hosts.js";
import { LoginFlowError, type LoginTraceEntry } from "./types.js";

const OPEN_PTY_TIMEOUT_MS = 15_000;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function hasFlow(flow: Record<string, LoginAction> | undefined): boolean {
  return !!flow && Object.keys(flow).length > 0;
}

/** ssh2 channel → PtyTransport。负责数据与关闭事件。 */
class SshChannelTransport implements PtyTransport {
  private readonly dataHandlers = new Set<(data: Buffer) => void>();
  private readonly closeHandlers = new Set<(err?: Error) => void>();
  private closeFired = false;

  constructor(
    private readonly client: Client,
    private readonly channel: ClientChannel,
    private readonly jumpClient?: Client,
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

  setWindow(rows: number, cols: number): void {
    try {
      this.channel.setWindow(rows, cols, 0, 0);
    } catch {
      /* channel already gone */
    }
  }

  close(): void {
    this.fireClose();
    try { this.channel.end(); } catch { /* ignore */ }
    try { this.client.end(); } catch { /* ignore */ }
    if (this.jumpClient) {
      try { this.jumpClient.end(); } catch { /* ignore */ }
    }
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
  jumpClient?: Client,
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
    return new PtyConn(
      new SshChannelTransport(client, channel, jumpClient),
      sid,
      { logger },
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface SetupResult {
  conn: PtyConn;
  loginTrace: LoginTraceEntry[];
  sftpAvailable: boolean;
  sftp: SftpClient | null;
}

/** 兼容 M2 命名。 */
export type DirectSetupResult = SetupResult;

/** What the caller needs from the login; MCP sessions need both. */
export interface SetupBehavior {
  needShell: boolean;
  needSftp: boolean;
}

const MCP_BEHAVIOR: SetupBehavior = { needShell: true, needSftp: true };

interface SetupOptions {
  sid: string;
  knownHosts: KnownHostsStore;
  logger?: Logger;
}

async function runFlow(
  conn: PtyConn,
  flow: Record<string, LoginAction> | undefined,
  entry: string | undefined,
  maxSteps: number | undefined,
  globalTimeoutMs: number | undefined,
  stage: string,
): Promise<LoginTraceEntry[]> {
  if (!hasFlow(flow)) return [];
  const result = await conn.runLoginFlow(flow!, entry ?? "", {
    maxSteps,
    globalTimeoutMs,
  });
  if (result.error) {
    throw new LoginFlowError(stage, result.trace, `${stage}: ${result.error.message}`);
  }
  return result.trace;
}

/** 所有 LoginFlow 之后的公共尾部：raw 标记或 DetectShell + RC 注入。 */
async function finishLogin(
  conn: PtyConn,
  target: { raw?: boolean },
  trace: LoginTraceEntry[],
  stage: string,
  behavior: SetupBehavior,
): Promise<void> {
  if (target.raw) {
    conn.markRaw();
    return;
  }
  if (!behavior.needShell) return;
  await conn.detectShell();
  try {
    trace.push(await conn.injectRC());
  } catch (err) {
    if (err instanceof LoginFlowError) {
      throw new LoginFlowError(
        "rc_inject",
        [...trace, ...err.trace],
        `${stage}: ${err.message}`,
      );
    }
    throw err;
  }
}

/** 直连：dial → open pty → LoginFlow（可选）→ raw 或 detect+RC → 持久 sftp。 */
export async function setupDirect(
  options: SetupOptions & { server: SSHServer; proxy?: Proxy },
  behavior: SetupBehavior = MCP_BEHAVIOR,
): Promise<SetupResult> {
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
    loginTrace.push(...await runFlow(
      conn, server.login_flow, server.login_entry,
      server.max_steps, server.global_timeout_ms, "direct",
    ));
    await finishLogin(conn, server, loginTrace, "direct", behavior);
  } catch (err) {
    conn.close();
    throw err;
  }

  if (!behavior.needSftp) {
    return { conn, loginTrace, sftpAvailable: false, sftp: null };
  }
  const sftp = await openSftp(client, logger);
  return { conn, loginTrace, sftpAvailable: sftp !== null, sftp };
}

/**
 * Pattern A：jumphost dial → forwardOut direct-tcpip → target dial →
 * open pty（绑定 jump 生命周期）→ 可选 target LoginFlow → detect+RC → sftp。
 */
export async function setupPatternA(
  options: SetupOptions & {
    server: SSHServer;
    jump: Jumphost;
    jumpProxy?: Proxy;
  },
  behavior: SetupBehavior = MCP_BEHAVIOR,
): Promise<SetupResult> {
  const logger = options.logger ?? nullLogger;
  const server = options.server;
  const jump = options.jump;
  const dialer = new Dialer(options.knownHosts, logger);

  let jumpClient: Client;
  try {
    jumpClient = await dialer.dial({
      addr: jump.addr,
      user: jump.user,
      auth: jump.auth,
      proxy: options.jumpProxy,
      serverName: jump.name,
      hostKeyVerify: jump.host_key_verify !== false,
    });
  } catch (err) {
    throw new Error(`ssh connect to jumphost ${jump.addr}: ${message(err)}`);
  }

  let targetClient: Client;
  try {
    targetClient = await dialer.dialThrough(jumpClient, {
      addr: server.addr,
      user: server.user,
      auth: server.auth,
      serverName: server.name,
      hostKeyVerify: server.host_key_verify !== false,
    });
  } catch (err) {
    try { jumpClient.end(); } catch { /* ignore */ }
    throw new Error(
      `ssh connect to target ${server.addr} through jumphost: ${message(err)}`,
    );
  }

  let conn: PtyConn;
  try {
    conn = await openPty(targetClient, options.sid, logger, jumpClient);
  } catch (err) {
    try { targetClient.end(); } catch { /* ignore */ }
    try { jumpClient.end(); } catch { /* ignore */ }
    throw new Error(`setup pty: ${message(err)}`);
  }

  const loginTrace: LoginTraceEntry[] = [];
  try {
    loginTrace.push(...await runFlow(
      conn, server.login_flow, server.login_entry,
      server.max_steps, server.global_timeout_ms, "patternA",
    ));
    await finishLogin(conn, server, loginTrace, "patternA", behavior);
  } catch (err) {
    conn.close();
    throw err;
  }

  if (!behavior.needSftp) {
    return { conn, loginTrace, sftpAvailable: false, sftp: null };
  }
  // Pattern A 的 SFTP 通道经 direct-tcpip 落在 target 上。
  const sftp = await openSftp(targetClient, logger);
  return { conn, loginTrace, sftpAvailable: sftp !== null, sftp };
}

/**
 * Pattern B：dial bastion → open pty → jumphost LoginFlow → target LoginFlow
 * → detect+RC。两段 flow 共用同一 PTY；sftp 恒不可用（通道落在 bastion）。
 */
export async function setupPatternB(
  options: SetupOptions & {
    server: SSHServer;
    jump: Jumphost;
    jumpProxy?: Proxy;
  },
  behavior: SetupBehavior = MCP_BEHAVIOR,
): Promise<SetupResult> {
  const logger = options.logger ?? nullLogger;
  const server = options.server;
  const jump = options.jump;
  const dialer = new Dialer(options.knownHosts, logger);

  let client: Client;
  try {
    client = await dialer.dial({
      addr: jump.addr,
      user: jump.user,
      auth: jump.auth,
      proxy: options.jumpProxy,
      serverName: jump.name,
      hostKeyVerify: jump.host_key_verify !== false,
    });
  } catch (err) {
    throw new Error(`ssh connect to jumphost ${jump.addr}: ${message(err)}`);
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
    loginTrace.push(...await runFlow(
      conn, jump.login_flow, jump.login_entry,
      jump.max_steps, jump.global_timeout_ms, "jumphost",
    ));
    loginTrace.push(...await runFlow(
      conn, server.login_flow, server.login_entry,
      server.max_steps, server.global_timeout_ms, "target",
    ));
    await finishLogin(conn, server, loginTrace, "patternB", behavior);
  } catch (err) {
    conn.close();
    throw err;
  }

  // SSH client 是到 bastion 的：SFTP 成功也会误导（文件落到 bastion）。
  return { conn, loginTrace, sftpAvailable: false, sftp: null };
}

/** 按 server.via 选择直连 / Pattern A / Pattern B。 */
export async function setupServer(
  options: SetupOptions & {
    server: SSHServer;
    jump?: Jumphost;
    serverProxy?: Proxy;
    jumpProxy?: Proxy;
    behavior?: SetupBehavior;
  },
): Promise<SetupResult> {
  const behavior = options.behavior ?? MCP_BEHAVIOR;
  if (!options.jump) {
    return setupDirect(options, behavior);
  }
  if (options.jump.ssh_j) {
    return setupPatternA({ ...options, jump: options.jump }, behavior);
  }
  return setupPatternB({ ...options, jump: options.jump }, behavior);
}

/** `myssh ssh` / `myssh file` login: direct, Pattern A, or Pattern B. */
export async function setupCliServer(options: {
  sid: string;
  knownHosts: KnownHostsStore;
  server: SSHServer;
  jump?: Jumphost;
  serverProxy?: Proxy;
  jumpProxy?: Proxy;
  needShell: boolean;
  needSftp: boolean;
  logger?: Logger;
}): Promise<SetupResult> {
  return setupServer({
    sid: options.sid,
    knownHosts: options.knownHosts,
    logger: options.logger,
    server: options.server,
    jump: options.jump,
    serverProxy: options.serverProxy,
    jumpProxy: options.jumpProxy,
    behavior: { needShell: options.needShell, needSftp: options.needSftp },
  });
}

/** Direct jumphost login (`myssh ssh <jumphost>`). */
export async function setupCliJumphost(options: {
  sid: string;
  knownHosts: KnownHostsStore;
  jump: Jumphost;
  proxy?: Proxy;
  needShell: boolean;
  logger?: Logger;
}): Promise<SetupResult> {
  const logger = options.logger ?? nullLogger;
  const jump = options.jump;
  const dialer = new Dialer(options.knownHosts, logger);

  let client: Client;
  try {
    client = await dialer.dial({
      addr: jump.addr,
      user: jump.user,
      auth: jump.auth,
      proxy: options.proxy,
      serverName: jump.name,
      hostKeyVerify: jump.host_key_verify !== false,
    });
  } catch (err) {
    throw new Error(`ssh connect to jumphost ${jump.addr}: ${message(err)}`);
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
    loginTrace.push(...await runFlow(
      conn, jump.login_flow, jump.login_entry,
      jump.max_steps, jump.global_timeout_ms, "jumphost",
    ));
    await finishLogin(
      conn,
      { raw: false },
      loginTrace,
      "jumphost",
      { needShell: options.needShell, needSftp: false },
    );
  } catch (err) {
    conn.close();
    throw err;
  }
  return { conn, loginTrace, sftpAvailable: false, sftp: null };
}
