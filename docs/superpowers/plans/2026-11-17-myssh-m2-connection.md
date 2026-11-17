# myssh M2：SSH 连接、代理、known_hosts、PTY、session 与 run_in_session

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立可用的直连 SSH 会话能力：拨号（密码/私钥）、SOCKS5/HTTP CONNECT 代理、TOFU known_hosts、PTY sentinel 协议、session 状态机，并注册 `login` / `run_in_session` / `close_session` / `stat` / `get_trace` / `send_in_session` / `read_in_session` 七个 MCP 工具。

**Architecture:** 传输层用 `ssh2`（CJS 默认导入），底层 TCP 自行建立后通过 `sock` 注入，从而统一实现直连、SOCKS5、HTTP CONNECT 与 Windows WSAEACCES 重试。known_hosts 用同步 fs，便于 ssh2 的同步 `hostVerifier` 返回精确错误。PTY 层把字节流抽象为 `PtyTransport`，核心的 sentinel 状态机、超时、Ctrl-C、原始读写全部可在无 SSH 的单元测试中验证。session 层只做状态机与 trace，登录装配放在 `src/ssh/login.ts`。

**Tech Stack:** TypeScript 7 strict + ESM、Node ≥ 22、vitest、`ssh2` 1.17（含 `ssh2.Server` 测试替身）、`@modelcontextprotocol/sdk` 1.x、zod 4。

**参考文档：**
- 设计 spec：`docs/superpowers/specs/2026-11-17-myssh-ts-rewrite-design.md`
- 原项目：`/Users/luozhihu/workspace/sshmng`
- M1 计划：`docs/superpowers/plans/2026-11-17-myssh-m1-foundation.md`

**M2 范围边界：**
- 只实现直连（`server.via` 为空且 `login_flow` 为空）。配置了 `via` 或 `login_flow` 时返回 `via jumphosts not implemented yet (M3)` / `login_flow not implemented yet (M3)`，M3 补上。
- 文件传输（upload/download/relay）不在 M2；`sftp_available` 仍会探测（直连时可用）。
- raw 设备（`server.raw=true`）在 M2 已完整支持 `send_in_session` / `read_in_session`。

---

## 文件结构（M2）

```
src/
├── log.ts                     # Logger 接口 + nullLogger
├── util/
│   ├── random.ts              # randomSID（8 字节 hex）
│   └── time.ts                # goDuration / goTimestamp / traceTimestamp
├── ssh/
│   ├── errors.ts              # ConnLostError / isConnLost
│   ├── known_hosts.ts         # TOFU store（同步、原子、0600）
│   ├── proxy.ts               # TCP 重试 / SOCKS5 / HTTP CONNECT / SocketReader
│   ├── dialer.ts              # 私钥加载、auth 装配、hostVerifier、ssh2 connect
│   ├── login.ts               # 直连装配：dial → open pty → RC → sftp 探测
│   └── types.ts               # Conn / RawConn / RunResult / isRawConn
├── pty/
│   ├── normalize.ts           # stripANSI / cleanOutput
│   ├── sentinel.ts            # detectShellReady / extractExitCode / truncateOutput
│   ├── shell_detect.ts        # parseShellDetect / classifyShell / buildRC
│   ├── queue.ts               # ByteQueue（字节队列 + 等待）
│   ├── transport.ts           # PtyTransport 接口
│   └── pty_conn.ts            # PtyConn：detect/RC/run/raw/close/sftp
├── session/
│   ├── trace.ts               # CommandTrace / 截断 / graveyard 常量
│   ├── session.ts             # Session 状态机 + raw 原语
│   └── manager.ts             # Manager / stat / getTrace / graveyard
└── mcp/
    ├── service.ts             # 扩展 manager / known_hosts / logger
    ├── tools_session.ts       # 7 个 session 工具中的 5 个 + login 装配
    ├── tools_raw.ts           # send_in_session / read_in_session + 转义
    └── server.ts              # 注册 16 个工具，更新 instructions

tests/
├── helpers/
│   ├── config.ts              # 已有
│   ├── fake_pty.ts            # FakePtyTransport
│   └── fake_ssh.ts            # FakeSshServer + bash 协议仿真
├── util/time.test.ts
├── ssh/known_hosts.test.ts
├── ssh/proxy.test.ts
├── ssh/dialer.test.ts
├── pty/normalize.test.ts
├── pty/sentinel.test.ts
├── pty/shell_detect.test.ts
├── pty/pty_conn.test.ts
├── session/session.test.ts
├── session/manager.test.ts
└── mcp/session_tools.test.ts
```

---

### Task 1: 基础工具与 known_hosts

**Files:**
- Create: `src/log.ts`, `src/util/random.ts`, `src/util/time.ts`, `src/ssh/errors.ts`, `src/ssh/known_hosts.ts`
- Test: `tests/util/time.test.ts`, `tests/ssh/known_hosts.test.ts`

- [x] **Step 1: 写失败的时间工具测试**

`tests/util/time.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { goDuration, goTimestamp, traceTimestamp } from "../../src/util/time.js";

describe("goDuration", () => {
  it("formats durations like Go", () => {
    expect(goDuration(0)).toBe("0s");
    expect(goDuration(400)).toBe("400ms");
    expect(goDuration(2000)).toBe("2s");
    expect(goDuration(30000)).toBe("30s");
    expect(goDuration(300000)).toBe("5m0s");
  });
});

describe("traceTimestamp", () => {
  it("formats local time with millisecond precision", () => {
    const d = new Date(2026, 0, 2, 3, 4, 5, 6);
    expect(traceTimestamp(d)).toBe("2026-01-02 03:04:05.006");
  });
});

describe("goTimestamp", () => {
  it("uses RFC3339 with the local offset and trims trailing zeroes", () => {
    const d = new Date(2026, 0, 2, 3, 4, 5, 60);
    expect(goTimestamp(d)).toMatch(
      /^2026-01-02T03:04:05\.06(?:[+-]\d{2}:\d{2}|Z)$/,
    );
  });
});
```

- [x] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/util/time.test.ts`
Expected: FAIL，`Failed to resolve import "../../src/util/time.js"`。

- [x] **Step 3: 实现时间工具**

`src/util/time.ts`：

```ts
function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/** 按 Go time.Duration.String() 的常用形态格式化毫秒。 */
export function goDuration(ms: number): string {
  if (ms < 0) return `-${goDuration(-ms)}`;
  if (ms === 0) return "0s";
  if (ms < 1000) return `${ms}ms`;
  const totalSec = Math.floor(ms / 1000);
  const fracMs = ms % 1000;
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  const sec = fracMs
    ? `${seconds}.${pad(fracMs, 3).replace(/0+$/, "")}`
    : String(seconds);
  if (hours > 0) return `${hours}h${minutes}m${sec}s`;
  if (minutes > 0) return `${minutes}m${sec}s`;
  return `${sec}s`;
}

/** Go time.Time JSON 编码（RFC3339Nano，本地时区，去掉小数末尾的 0）。 */
export function goTimestamp(date: Date): string {
  const base =
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  const fraction = `${pad(date.getMilliseconds(), 3)}000000`.replace(/0+$/, "");
  const offset = -date.getTimezoneOffset();
  let zone = "Z";
  if (offset !== 0) {
    const sign = offset > 0 ? "+" : "-";
    const abs = Math.abs(offset);
    zone = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  }
  return fraction ? `${base}.${fraction}${zone}` : `${base}${zone}`;
}

/** LoginFlow / RC trace 使用的时间格式：2006-01-02 15:04:05.000。 */
export function traceTimestamp(date: Date): string {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.` +
    pad(date.getMilliseconds(), 3)
  );
}
```

- [x] **Step 4: 写失败的 known_hosts 测试**

`tests/ssh/known_hosts.test.ts`：

```ts
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { KnownHostsStore } from "../../src/ssh/known_hosts.js";
import { tempDir } from "../helpers/config.js";

const KEY_A = Buffer.from("ssh-ed25519-aaaa");
const KEY_B = Buffer.from("ssh-ed25519-bbbb");

async function withStore(
  fn: (file: string, store: KnownHostsStore) => void | Promise<void>,
): Promise<void> {
  const { dir, cleanup } = await tempDir();
  try {
    const file = path.join(dir, "known_hosts");
    await fn(file, new KnownHostsStore(file));
  } finally {
    await cleanup();
  }
}

describe("KnownHostsStore", () => {
  it("records a new host key and matches it later", async () => {
    await withStore(async (file, store) => {
      expect(store.check("1.2.3.4:22", KEY_A)).toBe("new");
      expect(readFileSync(file, "utf8")).toBe(
        `1.2.3.4:22 ${KEY_A.toString("base64")}\n`,
      );
      expect(store.check("1.2.3.4:22", KEY_A)).toBe("match");
      if (process.platform !== "win32") {
        expect(statSync(file).mode & 0o777).toBe(0o600);
      }
    });
  });

  it("rejects a changed host key with the MITM warning", async () => {
    await withStore(async (file, store) => {
      store.check("1.2.3.4:22", KEY_A);
      expect(() => store.check("1.2.3.4:22", KEY_B)).toThrow(
        `host key changed for 1.2.3.4:22: possible MITM attack; if this is intentional, remove the entry manually from ${file}`,
      );
      expect(readFileSync(file, "utf8")).toContain(KEY_A.toString("base64"));
    });
  });

  it("skips comments and blank lines and rejects malformed lines", async () => {
    await withStore(async (file, store) => {
      writeFileSync(file, `# comment\n\n1.2.3.4:22 ${KEY_A.toString("base64")}\n`, {
        mode: 0o600,
      });
      expect(store.check("1.2.3.4:22", KEY_A)).toBe("match");
      writeFileSync(file, "bad line with spaces\n", { mode: 0o600 });
      expect(() => store.check("1.2.3.4:22", KEY_A)).toThrow(
        'known_hosts:1: expected \'addr base64-key\', got "bad line with spaces"',
      );
    });
  });

  it("rejects a group/other-readable known_hosts file", async () => {
    if (process.platform === "win32") return;
    await withStore(async (file, store) => {
      writeFileSync(file, `1.2.3.4:22 ${KEY_A.toString("base64")}\n`);
      chmodSync(file, 0o644);
      expect(() => store.check("1.2.3.4:22", KEY_A)).toThrow(
        "known_hosts permissions too open: 644, want 0600 (no group/other access)",
      );
    });
  });

  it("creates missing parent directories and appends new hosts", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const file = path.join(dir, "nested", "deeper", "known_hosts");
      const store = new KnownHostsStore(file);
      store.check("a:22", KEY_A);
      store.check("b:22", KEY_B);
      expect(readFileSync(file, "utf8")).toBe(
        `a:22 ${KEY_A.toString("base64")}\nb:22 ${KEY_B.toString("base64")}\n`,
      );
      expect(mkdirSync).toBeTruthy();
    } finally {
      await cleanup();
    }
  });
});
```

- [x] **Step 5: 运行确认失败**

Run: `npm test -- tests/ssh/known_hosts.test.ts`
Expected: FAIL，`Failed to resolve import "../../src/ssh/known_hosts.js"`。

- [x] **Step 6: 实现基础工具与 known_hosts**

`src/log.ts`：

```ts
export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export const nullLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};
```

`src/util/random.ts`：

```ts
import { randomBytes } from "node:crypto";

/** 8 字节十六进制 session ID / sentinel token。 */
export function randomSID(): string {
  return randomBytes(8).toString("hex");
}
```

`src/ssh/errors.ts`：

```ts
/** PTY 输出通道已关闭（SSH channel EOF / 连接断开）。 */
export class ConnLostError extends Error {
  constructor() {
    super("connection lost");
    this.name = "ConnLostError";
  }
}

export function isConnLost(err: unknown): boolean {
  return err instanceof Error && err.message === "connection lost";
}
```

`src/ssh/known_hosts.ts`：

```ts
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export type HostKeyStatus = "new" | "match";

interface Entry {
  addr: string;
  keyB64: string;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * TOFU known_hosts：每行 `host:port base64-pubkey`，权限 0600，原子写。
 * 所有方法同步执行，便于 ssh2 的同步 hostVerifier 直接返回精确错误。
 */
export class KnownHostsStore {
  constructor(readonly path: string) {}

  /** 首次记录返回 "new"；匹配返回 "match"；变更抛出 MITM 错误。 */
  check(addr: string, key: Buffer): HostKeyStatus {
    const entries = this.load();
    const marshaled = key.toString("base64");
    for (const entry of entries) {
      if (entry.addr !== addr) continue;
      if (entry.keyB64 === marshaled) return "match";
      throw new Error(
        `host key changed for ${addr}: possible MITM attack; if this is intentional, remove the entry manually from ${this.path}`,
      );
    }
    entries.push({ addr, keyB64: marshaled });
    try {
      this.save(entries);
    } catch (err) {
      throw new Error(`record host key: ${message(err)}`);
    }
    return "new";
  }

  private load(): Entry[] {
    let info;
    try {
      info = statSync(this.path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new Error(`stat known_hosts: ${message(err)}`);
    }
    // Windows 用 NTFS ACL，Unix rwx 位无意义，跳过检查。
    if (process.platform !== "win32") {
      const perm = info.mode & 0o777;
      if ((perm & 0o077) !== 0) {
        throw new Error(
          `known_hosts permissions too open: ${perm.toString(8)}, want 0600 (no group/other access)`,
        );
      }
    }
    let data: string;
    try {
      data = readFileSync(this.path, "utf8");
    } catch (err) {
      throw new Error(`read known_hosts: ${message(err)}`);
    }
    const entries: Entry[] = [];
    data.split("\n").forEach((rawLine, index) => {
      const line = rawLine.trim();
      if (line === "" || line.startsWith("#")) return;
      const parts = line.split(/\s+/);
      if (parts.length !== 2) {
        throw new Error(
          `known_hosts:${index + 1}: expected 'addr base64-key', got ${JSON.stringify(line)}`,
        );
      }
      entries.push({ addr: parts[0]!, keyB64: parts[1]! });
    });
    return entries;
  }

  private save(entries: Entry[]): void {
    const dir = path.dirname(this.path);
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch (err) {
      throw new Error(`mkdir known_hosts dir: ${message(err)}`);
    }
    const body = entries.map((e) => `${e.addr} ${e.keyB64}\n`).join("");
    const tmp = path.join(
      dir,
      `.known_hosts.tmp.${process.pid}.${randomBytes(4).toString("hex")}`,
    );
    try {
      writeFileSync(tmp, body, { mode: 0o600 });
    } catch (err) {
      throw new Error(`write temp: ${message(err)}`);
    }
    try {
      chmodSync(tmp, 0o600);
    } catch (err) {
      try { unlinkSync(tmp); } catch { /* ignore */ }
      throw new Error(`chmod temp: ${message(err)}`);
    }
    try {
      renameSync(tmp, this.path);
    } catch (err) {
      // Windows 的 rename 不能覆盖已存在文件。
      try {
        unlinkSync(this.path);
        renameSync(tmp, this.path);
      } catch (retryErr) {
        try { unlinkSync(tmp); } catch { /* ignore */ }
        throw new Error(`rename temp to known_hosts: ${message(retryErr)}`);
      }
    }
  }
}
```

- [x] **Step 7: 运行测试**

Run: `npm test -- tests/util/time.test.ts tests/ssh/known_hosts.test.ts`
Expected: PASS（time 3 个用例，known_hosts 5 个用例）。

- [x] **Step 8: 类型检查并提交**

Run: `npm run typecheck`
Expected: 无输出，退出码 0。

```bash
git add src/log.ts src/util src/ssh/errors.ts src/ssh/known_hosts.ts \
  tests/util/time.test.ts tests/ssh/known_hosts.test.ts
git commit -m "feat: add logging, time helpers, and TOFU known_hosts store"
```

---

### Task 2: 代理层（SOCKS5、HTTP CONNECT、EDR 重试）

**Files:**
- Create: `src/ssh/proxy.ts`
- Test: `tests/ssh/proxy.test.ts`

- [x] **Step 1: 写失败的代理测试**

`tests/ssh/proxy.test.ts`：

```ts
import net from "node:net";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { connectUnderlying, splitHostPort } from "../../src/ssh/proxy.js";

async function listen(
  onSocket: (socket: net.Socket) => void,
): Promise<{ addr: string; port: number; close: () => Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    onSocket(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    addr: `127.0.0.1:${port}`,
    port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function startHttpProxy(respond: string, banner = "") {
  const requests: string[] = [];
  return listen((socket) => {
    let data = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      const end = data.indexOf("\r\n\r\n");
      if (end < 0) return;
      socket.off("data", onData);
      requests.push(data.subarray(0, end + 4).toString("latin1"));
      socket.write(respond + banner);
      socket.on("data", (rest) => socket.write(rest));
    };
    socket.on("data", onData);
  }).then((server) => ({ ...server, requests }));
}

function startSocks5(opts: { user?: string; password?: string } = {}) {
  return listen((socket) => {
    let buf = Buffer.alloc(0);
    let stage: "greeting" | "auth" | "request" | "done" = "greeting";
    socket.on("data", (data) => {
      buf = Buffer.concat([buf, data]);
      for (;;) {
        if (stage === "greeting") {
          if (buf.length < 2) return;
          const count = buf[1]!;
          if (buf.length < 2 + count) return;
          const methods = buf.subarray(2, 2 + count);
          buf = buf.subarray(2 + count);
          if (opts.user) {
            if (!methods.includes(2)) {
              socket.end(Buffer.from([5, 0xff]));
              return;
            }
            socket.write(Buffer.from([5, 2]));
            stage = "auth";
          } else {
            socket.write(Buffer.from([5, 0]));
            stage = "request";
          }
          continue;
        }
        if (stage === "auth") {
          if (buf.length < 2) return;
          const ulen = buf[1]!;
          if (buf.length < 2 + ulen + 1) return;
          const plen = buf[2 + ulen]!;
          if (buf.length < 3 + ulen + plen) return;
          const user = buf.subarray(2, 2 + ulen).toString("utf8");
          const pass = buf.subarray(3 + ulen, 3 + ulen + plen).toString("utf8");
          buf = buf.subarray(3 + ulen + plen);
          const ok = user === opts.user && pass === opts.password;
          socket.write(Buffer.from([1, ok ? 0 : 1]));
          if (!ok) {
            socket.end();
            return;
          }
          stage = "request";
          continue;
        }
        if (stage === "request") {
          if (buf.length < 5) return;
          const atyp = buf[3]!;
          let need: number;
          if (atyp === 1) need = 4 + 2;
          else if (atyp === 4) need = 16 + 2;
          else if (atyp === 3) need = 1 + buf[4]! + 2;
          else {
            socket.end();
            return;
          }
          if (buf.length < 4 + need) return;
          buf = buf.subarray(4 + need);
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 22]));
          stage = "done";
          continue;
        }
        if (stage === "done" && buf.length > 0) {
          socket.write(buf);
          buf = Buffer.alloc(0);
        }
        return;
      }
    });
  });
}

function readOnce(socket: net.Socket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("read timeout")), 1000);
    socket.once("data", (data: Buffer) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

describe("splitHostPort", () => {
  it("parses hostname, IPv4 and bracketed IPv6", () => {
    expect(splitHostPort("example.com:22")).toEqual({ host: "example.com", port: 22 });
    expect(splitHostPort("1.2.3.4:2222")).toEqual({ host: "1.2.3.4", port: 2222 });
    expect(splitHostPort("[::1]:22")).toEqual({ host: "::1", port: 22 });
    expect(() => splitHostPort("nope")).toThrow();
  });
});

describe("HTTP CONNECT proxy", () => {
  it("sends the exact CONNECT request and forwards trailing bytes", async () => {
    const proxy = await startHttpProxy(
      "HTTP/1.1 200 Connection established\r\n\r\n",
      "SSH-2.0-fake\r\n",
    );
    try {
      const socket = await connectUnderlying("203.0.113.9:22", {
        name: "p", type: "HTTP", addr: proxy.addr,
        auth: { user: "u", password: "p" },
      });
      expect(proxy.requests[0]).toBe(
        "CONNECT 203.0.113.9:22 HTTP/1.1\r\n" +
        "Host: 203.0.113.9:22\r\n" +
        "Proxy-Authorization: Basic dTpw\r\n" +
        "\r\n",
      );
      expect((await readOnce(socket)).toString()).toBe("SSH-2.0-fake\r\n");
      socket.destroy();
    } finally {
      await proxy.close();
    }
  });

  it("reports the proxy status line on failure", async () => {
    const proxy = await startHttpProxy(
      "HTTP/1.1 407 Proxy Authentication Required\r\n\r\n",
    );
    try {
      await expect(connectUnderlying("203.0.113.9:22", {
        name: "p", type: "HTTP", addr: proxy.addr,
      })).rejects.toThrow(
        "proxy CONNECT failed: HTTP/1.1 407 Proxy Authentication Required",
      );
    } finally {
      await proxy.close();
    }
  });
});

describe("SOCKS5 proxy", () => {
  it("connects without auth and forwards bytes", async () => {
    const proxy = await startSocks5();
    try {
      const socket = await connectUnderlying("203.0.113.9:22", {
        name: "p", type: "SOCKS5", addr: proxy.addr,
      });
      socket.write(Buffer.from("ping"));
      expect((await readOnce(socket)).toString()).toBe("ping");
      socket.destroy();
    } finally {
      await proxy.close();
    }
  });

  it("authenticates with username/password", async () => {
    const proxy = await startSocks5({ user: "u", password: "p" });
    try {
      const socket = await connectUnderlying("203.0.113.9:22", {
        name: "p", type: "SOCKS5", addr: proxy.addr,
        auth: { user: "u", password: "p" },
      });
      socket.destroy();
    } finally {
      await proxy.close();
    }
  });

  it("rejects wrong credentials", async () => {
    const proxy = await startSocks5({ user: "u", password: "p" });
    try {
      await expect(connectUnderlying("203.0.113.9:22", {
        name: "p", type: "SOCKS5", addr: proxy.addr,
        auth: { user: "u", password: "wrong" },
      })).rejects.toThrow("socks5: authentication failed");
    } finally {
      await proxy.close();
    }
  });

  it("rejects an unknown proxy type", async () => {
    await expect(connectUnderlying("203.0.113.9:22", {
      name: "p", type: "FTP" as "HTTP", addr: "127.0.0.1:1",
    })).rejects.toThrow('unknown proxy type "FTP"');
  });
});
```

- [x] **Step 2: 运行确认失败**

Run: `npm test -- tests/ssh/proxy.test.ts`
Expected: FAIL，无法解析 `../../src/ssh/proxy.js`。

- [x] **Step 3: 实现代理层**

`src/ssh/proxy.ts`：

```ts
import net, { isIP } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import type { Proxy, ProxyAuth } from "../config/types.js";
import { nullLogger, type Logger } from "../log.js";

export const TCP_DIAL_TIMEOUT_MS = 10_000;
export const EDR_MAX_RETRIES = 2;
export const EDR_RETRY_DELAY_MS = 100;
const WSA_EACCES = 10013;

export type TcpDialer = (
  host: string,
  port: number,
  timeoutMs: number,
) => Promise<net.Socket>;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function splitHostPort(addr: string): { host: string; port: number } {
  const index = addr.lastIndexOf(":");
  if (index < 0) throw new Error(`address ${addr}: missing port in address`);
  let host = addr.slice(0, index);
  const portText = addr.slice(index + 1);
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`address ${addr}: invalid port ${JSON.stringify(portText)}`);
  }
  return { host, port };
}

export function netDial(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`dial tcp ${host}:${port}: i/o timeout`));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** 奇安信天擎等 EDR 的 WFP filter 偶发本地拒绝 connect（WSAEACCES / 10013）。 */
export function isLocalPolicyReject(err: unknown): boolean {
  const e = err as NodeJS.ErrnoException;
  return e?.errno === WSA_EACCES || (process.platform === "win32" && e?.code === "EACCES");
}

export async function dialTcpWithRetry(
  dial: TcpDialer,
  host: string,
  port: number,
  timeoutMs: number,
  logger: Logger = nullLogger,
): Promise<net.Socket> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= EDR_MAX_RETRIES; attempt += 1) {
    try {
      return await dial(host, port, timeoutMs);
    } catch (err) {
      lastError = err;
      if (!isLocalPolicyReject(err) || attempt === EDR_MAX_RETRIES) break;
      logger.warn("tcp dial rejected locally by policy (WSAEACCES), retrying", {
        addr: `${host}:${port}`,
        attempt: attempt + 1,
        max_retries: EDR_MAX_RETRIES,
      });
      await sleep(EDR_RETRY_DELAY_MS);
    }
  }
  throw lastError;
}

/** 在代理握手阶段按字节读取，并保留握手后的剩余字节。 */
export class SocketReader {
  private buf = Buffer.alloc(0);
  private waiters: Array<() => void> = [];
  private error: Error | undefined;
  private ended = false;
  private readonly onData = (data: Buffer): void => {
    this.buf = Buffer.concat([this.buf, data]);
    this.notify();
  };
  private readonly onError = (err: Error): void => {
    this.error = err;
    this.notify();
  };
  private readonly onEnd = (): void => {
    this.ended = true;
    this.notify();
  };

  attach(socket: net.Socket): void {
    socket.on("data", this.onData);
    socket.on("error", this.onError);
    socket.on("end", this.onEnd);
    socket.on("close", this.onEnd);
  }

  detach(socket: net.Socket): void {
    socket.off("data", this.onData);
    socket.off("error", this.onError);
    socket.off("end", this.onEnd);
    socket.off("close", this.onEnd);
  }

  leftover(): Buffer {
    return this.buf;
  }

  private notify(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter();
  }

  private wait(): Promise<void> {
    if (this.buf.length > 0 || this.error || this.ended) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private take(count: number): Buffer {
    const out = this.buf.subarray(0, count);
    this.buf = this.buf.subarray(count);
    return out;
  }

  async read(count: number): Promise<Buffer> {
    while (this.buf.length < count) {
      if (this.error) throw this.error;
      if (this.ended) throw new Error("connection closed");
      await this.wait();
    }
    return this.take(count);
  }

  async readUntil(needle: string, maxBytes: number): Promise<Buffer> {
    const marker = Buffer.from(needle, "latin1");
    for (;;) {
      const index = this.buf.indexOf(marker);
      if (index >= 0) return this.take(index + marker.length);
      if (this.buf.length > maxBytes) throw new Error("response too large");
      if (this.error) throw this.error;
      if (this.ended) throw new Error("connection closed");
      await this.wait();
    }
  }
}

async function socks5Handshake(
  socket: net.Socket,
  target: string,
  auth: ProxyAuth | undefined,
): Promise<void> {
  const reader = new SocketReader();
  reader.attach(socket);
  const { host, port } = splitHostPort(target);

  const methods = auth?.user ? [0x00, 0x02] : [0x00];
  socket.write(Buffer.from([0x05, methods.length, ...methods]));
  const greeting = await reader.read(2);
  if (greeting[0] !== 0x05) throw new Error("socks5: bad version");
  const method = greeting[1]!;
  if (method === 0xff) throw new Error("socks5: no acceptable authentication methods");
  if (method === 0x02) {
    if (!auth?.user) throw new Error("socks5: server requires authentication");
    const user = Buffer.from(auth.user, "utf8");
    const pass = Buffer.from(auth.password ?? "", "utf8");
    socket.write(Buffer.concat([
      Buffer.from([0x01, user.length]), user,
      Buffer.from([pass.length]), pass,
    ]));
    const reply = await reader.read(2);
    if (reply[0] !== 0x01 || reply[1] !== 0x00) {
      throw new Error("socks5: authentication failed");
    }
  } else if (method !== 0x00) {
    throw new Error(`socks5: unsupported auth method ${method}`);
  }

  const ipVersion = isIP(host);
  let atyp: number;
  let address: Buffer;
  if (ipVersion === 4) {
    atyp = 0x01;
    address = Buffer.from(host.split(".").map((part) => Number(part)));
  } else if (ipVersion === 6) {
    atyp = 0x04;
    address = ipv6Bytes(host);
  } else {
    atyp = 0x03;
    const name = Buffer.from(host, "utf8");
    address = Buffer.concat([Buffer.from([name.length]), name]);
  }
  const portBytes = Buffer.alloc(2);
  portBytes.writeUInt16BE(port, 0);
  socket.write(Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, atyp]), address, portBytes,
  ]));

  const head = await reader.read(4);
  if (head[0] !== 0x05) throw new Error("socks5: bad reply version");
  if (head[1] !== 0x00) throw new Error(`socks5 connect failed: reply code ${head[1]}`);
  const boundType = head[3]!;
  if (boundType === 0x01) await reader.read(4 + 2);
  else if (boundType === 0x04) await reader.read(16 + 2);
  else if (boundType === 0x03) {
    const length = (await reader.read(1))[0]!;
    await reader.read(length + 2);
  } else {
    throw new Error(`socks5: bad address type ${boundType}`);
  }

  const leftover = reader.leftover();
  reader.detach(socket);
  if (leftover.length > 0) socket.unshift(leftover);
}

function ipv6Bytes(host: string): Buffer {
  const [head, tail] = host.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = host.includes("::")
    ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
    : left;
  const out = Buffer.alloc(16);
  groups.forEach((group, index) => {
    out.writeUInt16BE(Number.parseInt(group || "0", 16), index * 2);
  });
  return out;
}

async function httpConnect(
  proxyAddr: string,
  auth: ProxyAuth | undefined,
  target: string,
  timeoutMs: number,
  logger: Logger,
): Promise<net.Socket> {
  const { host, port } = splitHostPort(proxyAddr);
  const socket = await dialTcpWithRetry(netDial, host, port, timeoutMs, logger);
  socket.setTimeout(timeoutMs, () => socket.destroy(new Error("proxy handshake timed out")));
  const reader = new SocketReader();
  reader.attach(socket);
  let request = `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n`;
  if (auth?.user) {
    const credentials = Buffer.from(`${auth.user}:${auth.password ?? ""}`).toString("base64");
    request += `Proxy-Authorization: Basic ${credentials}\r\n`;
  }
  request += "\r\n";
  socket.write(Buffer.from(request, "latin1"));
  let response: Buffer;
  try {
    response = await reader.readUntil("\r\n\r\n", 8192);
  } catch (err) {
    reader.detach(socket);
    socket.destroy();
    throw err;
  }
  const statusLine = response.toString("latin1").split("\r\n", 1)[0] ?? "";
  if (!statusLine.startsWith("HTTP/1.1 200") && !statusLine.startsWith("HTTP/1.0 200")) {
    reader.detach(socket);
    socket.destroy();
    throw new Error(`proxy CONNECT failed: ${statusLine}`);
  }
  const leftover = reader.leftover();
  reader.detach(socket);
  socket.setTimeout(0);
  if (leftover.length > 0) socket.unshift(leftover);
  return socket;
}

export async function connectUnderlying(
  addr: string,
  proxy: Proxy | undefined,
  logger: Logger = nullLogger,
): Promise<net.Socket> {
  if (!proxy) {
    const { host, port } = splitHostPort(addr);
    return dialTcpWithRetry(netDial, host, port, TCP_DIAL_TIMEOUT_MS, logger);
  }
  switch (proxy.type) {
    case "SOCKS5": {
      const { host, port } = splitHostPort(proxy.addr);
      const socket = await dialTcpWithRetry(
        netDial, host, port, TCP_DIAL_TIMEOUT_MS, logger,
      );
      socket.setTimeout(TCP_DIAL_TIMEOUT_MS, () => {
        socket.destroy(new Error("proxy handshake timed out"));
      });
      try {
        await socks5Handshake(socket, addr, proxy.auth);
      } catch (err) {
        socket.destroy();
        throw new Error(`socks5 dialer: ${message(err)}`);
      }
      socket.setTimeout(0);
      return socket;
    }
    case "HTTP":
      return httpConnect(proxy.addr, proxy.auth, addr, TCP_DIAL_TIMEOUT_MS, logger);
    default:
      throw new Error(`unknown proxy type ${JSON.stringify((proxy as Proxy).type)}`);
  }
}
```

- [x] **Step 4: 运行测试**

Run: `npm test -- tests/ssh/proxy.test.ts`
Expected: PASS（8 个用例）。

- [x] **Step 5: 类型检查并提交**

Run: `npm run typecheck`
Expected: 退出码 0。

```bash
git add src/ssh/proxy.ts tests/ssh/proxy.test.ts
git commit -m "feat: add SOCKS5/HTTP CONNECT proxy transport with EDR retry"
```

---

### Task 3: 假 SSH 服务器与 Dialer

**Files:**
- Create: `tests/helpers/fake_ssh.ts`, `src/ssh/dialer.ts`
- Test: `tests/ssh/dialer.test.ts`

- [x] **Step 1: 写假 SSH 服务器测试替身**

`tests/helpers/fake_ssh.ts`：

```ts
import net from "node:net";
import type { AddressInfo } from "node:net";
import ssh2 from "ssh2";
import type { Connection, Server as SshServer } from "ssh2";

const { Server, utils } = ssh2;

export interface FakeSshOptions {
  user?: string;
  password?: string;
  raw?: boolean;
  allowSftp?: boolean;
  allowPublicKey?: boolean;
}

class FakeShell {
  private line = "";
  private sid = "";
  private token = "";
  private commandActive = false;
  private sleepTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly send: (text: string) => void,
    private readonly raw: boolean,
  ) {}

  input(chunk: Buffer): void {
    if (this.raw) {
      this.send(chunk.toString("latin1"));
      return;
    }
    for (const byte of chunk) {
      if (byte === 0x03) {
        this.cancelSleep();
        if (this.commandActive) {
          this.commandActive = false;
          this.prompt(130);
        }
        this.line = "";
        continue;
      }
      if (byte === 0x0a) {
        const line = this.line.replace(/\r$/, "");
        this.line = "";
        this.handleLine(line);
      } else {
        this.line += String.fromCharCode(byte);
      }
    }
  }

  cancel(): void {
    this.cancelSleep();
  }

  private cancelSleep(): void {
    if (this.sleepTimer) {
      clearTimeout(this.sleepTimer);
      this.sleepTimer = null;
    }
  }

  private prompt(code: number): void {
    if (this.token) this.send(`_${code}__${this.sid}_${this.token}__]# `);
    else this.send(`_${code}__${this.sid}___]# `);
  }

  private handleLine(line: string): void {
    const detect = /^__sshmng_dr=([0-9a-f]+);/.exec(line);
    if (detect) {
      this.send(
        `__SHELL_DETECT__:/bin/bash:5.2.15(1)-release:\r\n__DETECT_END_${detect[1]!}__\r\n`,
      );
      return;
    }
    const initial = /^export PS1='\$\(echo _\$\?\)__([0-9a-f]+)___\]# '$/.exec(line);
    if (initial) {
      this.sid = initial[1]!;
      this.token = "";
      this.prompt(0);
      return;
    }
    const setup = /^PS1='\$\(echo _\$\?\)__([0-9a-f]+)_([0-9a-f]+)__\]# '$/.exec(line);
    if (setup) {
      this.sid = setup[1]!;
      this.token = setup[2]!;
      this.prompt(0);
      return;
    }
    // RC 注入的 export/set/stty 等按真实 shell 行为静默执行。
    if (/^(export|set|setopt|unset|stty|umask)\b/.test(line)) return;
    if (!this.commandActive) this.runCommand(line);
  }

  private runCommand(line: string): void {
    this.commandActive = true;
    let match: RegExpExecArray | null;
    if ((match = /^echo (.*)$/.exec(line))) {
      this.finish(`${match[1]!}\r\n`, 0);
    } else if (line === "false") {
      this.finish("", 1);
    } else if (line === "true") {
      this.finish("", 0);
    } else if ((match = /^sleep ([0-9.]+)$/.exec(line))) {
      this.sleepTimer = setTimeout(() => this.finish("", 0), Number(match![1]) * 1000);
    } else if (line === "pwd") {
      this.finish("/home/test\r\n", 0);
    } else if ((match = /^seq (\d+)$/.exec(line))) {
      const count = Number(match[1]);
      const lines: string[] = [];
      for (let i = 1; i <= count; i += 1) lines.push(String(i));
      this.finish(`${lines.join("\r\n")}\r\n`, 0);
    } else {
      this.finish(`sh: ${line}: command not found\r\n`, 127);
    }
  }

  private finish(output: string, code: number): void {
    this.commandActive = false;
    if (output) this.send(output);
    this.prompt(code);
  }
}

export class FakeSshServer {
  private constructor(
    readonly port: number,
    readonly hostKeyBase64: string,
    private readonly server: SshServer,
    private readonly clients: Connection[],
  ) {}

  static async start(opts: FakeSshOptions = {}): Promise<FakeSshServer> {
    const { private: hostKey } = utils.generateKeyPairSync("ed25519");
    const parsedHostKey = utils.parseKey(hostKey);
    if (parsedHostKey instanceof Error) throw parsedHostKey;
    const hostKeyBase64 = parsedHostKey.getPublicSSH().toString("base64");
    const clients: Connection[] = [];
    const server = new Server({ hostKeys: [hostKey] }, (client) => {
      clients.push(client);
      client.on("authentication", (ctx) => {
        if (
          ctx.method === "password"
          && ctx.username === (opts.user ?? "test")
          && ctx.password === (opts.password ?? "secret")
        ) {
          ctx.accept();
        } else if (ctx.method === "publickey" && opts.allowPublicKey) {
          ctx.accept();
        } else {
          ctx.reject();
        }
      });
      client.on("session", (accept) => {
        const session = accept();
        session.on("pty", (acceptPty) => acceptPty());
        session.on("shell", (acceptShell) => {
          const stream = acceptShell();
          const shell = new FakeShell((text) => stream.write(text), !!opts.raw);
          stream.on("data", (data: Buffer) => shell.input(data));
          stream.on("close", () => shell.cancel());
        });
        session.on("sftp", (acceptSftp, rejectSftp) => {
          if (opts.allowSftp) acceptSftp();
          else rejectSftp();
        });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    return new FakeSshServer(port, hostKeyBase64, server, clients);
  }

  get addr(): string {
    return `127.0.0.1:${this.port}`;
  }

  async close(): Promise<void> {
    for (const client of this.clients) {
      try { client.end(); } catch { /* ignore */ }
    }
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
```

- [x] **Step 2: 写失败的 Dialer 测试**

`tests/ssh/dialer.test.ts`：

```ts
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import ssh2 from "ssh2";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Dialer, loadAuth } from "../../src/ssh/dialer.js";
import { KnownHostsStore } from "../../src/ssh/known_hosts.js";
import { tempDir, writeConfig } from "../helpers/config.js";
import { FakeSshServer } from "../helpers/fake_ssh.js";

const { utils } = ssh2;

describe("loadAuth", () => {
  it("requires password or private key", () => {
    expect(() => loadAuth({})).toThrow(
      "no auth method available (need password or private_key)",
    );
  });

  it("prefers the private key over the password without falling back", () => {
    expect(() =>
      loadAuth({ password: "ignored", private_key: "/nonexistent" }),
    ).toThrow("stat private key /nonexistent:");
  });

  it("rejects a world-readable private key", () => {
    if (process.platform === "win32") return;
    const dir = process.env.TMPDIR ?? "/tmp";
    const file = path.join(dir, `myssh-key-${process.pid}-${Date.now()}`);
    const { private: key } = utils.generateKeyPairSync("ed25519");
    writeFileSync(file, key);
    chmodSync(file, 0o644);
    try {
      expect(() => loadAuth({ private_key: file })).toThrow(
        `private key ${file} permissions too open: 644, want 0600 or stricter (no group/other access)`,
      );
    } finally {
      chmodSync(file, 0o600);
      require("node:fs").unlinkSync(file);
    }
  });
});

describe("Dialer", () => {
  let server: FakeSshServer;
  let dir: string;
  let cleanup: () => Promise<void>;
  let knownHosts: KnownHostsStore;
  let knownHostsFile: string;

  beforeEach(async () => {
    server = await FakeSshServer.start();
    const temp = await tempDir();
    dir = temp.dir;
    cleanup = temp.cleanup;
    knownHostsFile = path.join(dir, "known_hosts");
    knownHosts = new KnownHostsStore(knownHostsFile);
  });

  afterEach(async () => {
    await server.close();
    await cleanup();
  });

  const options = (extra: Record<string, unknown> = {}) => ({
    addr: server.addr,
    user: "test",
    auth: { password: "secret" },
    hostKeyVerify: true,
    ...extra,
  });

  it("connects with a password and records the host key (TOFU)", async () => {
    const first = await new Dialer(knownHosts).dial(options());
    first.end();
    const lines = readFileSync(knownHostsFile, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.startsWith(`${server.addr} `)).toBe(true);
    const second = await new Dialer(knownHosts).dial(options());
    second.end();
    expect(readFileSync(knownHostsFile, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("rejects a changed host key", async () => {
    await new Dialer(knownHosts).dial(options()).then((client) => client.end());
    writeFileSync(
      knownHostsFile,
      `${server.addr} ${Buffer.from("different-key").toString("base64")}\n`,
      { mode: 0o600 },
    );
    await expect(new Dialer(knownHosts).dial(options())).rejects.toThrow(
      `host key changed for ${server.addr}: possible MITM attack`,
    );
  });

  it("skips known_hosts entirely when verification is disabled", async () => {
    const client = await new Dialer(knownHosts).dial(
      options({ hostKeyVerify: false }),
    );
    client.end();
    expect(existsSync(knownHostsFile)).toBe(false);
  });

  it("surfaces authentication failures", async () => {
    await expect(
      new Dialer(knownHosts).dial(options({ auth: { password: "wrong" } })),
    ).rejects.toThrow(`ssh connect to ${server.addr}:`);
  });

  it("authenticates with a private key", async () => {
    const keyPath = path.join(dir, "id_ed25519");
    const { private: key } = utils.generateKeyPairSync("ed25519");
    writeFileSync(keyPath, key, { mode: 0o600 });
    chmodSync(keyPath, 0o600);
    await server.close();
    server = await FakeSshServer.start({ allowPublicKey: true });
    const client = await new Dialer(knownHosts).dial(
      options({ addr: server.addr, auth: { private_key: keyPath } }),
    );
    client.end();
  });

  it("probes a proxy and connects through it", async () => {
    const net = await import("node:net");
    const proxy = net.createServer((socket) => {
      let data = Buffer.alloc(0);
      const onData = (chunk: Buffer) => {
        data = Buffer.concat([data, chunk]);
        if (data.indexOf("\r\n\r\n") < 0) return;
        socket.off("data", onData);
        socket.write("HTTP/1.1 200 OK\r\n\r\n");
        const upstream = net.connect(server.port, "127.0.0.1");
        socket.pipe(upstream).pipe(socket);
      };
      socket.on("data", onData);
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const port = (proxy.address() as import("node:net").AddressInfo).port;
    try {
      const client = await new Dialer(knownHosts).dial(
        options({ proxy: { name: "p", type: "HTTP", addr: `127.0.0.1:${port}` } }),
      );
      client.end();
    } finally {
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });
});
```

> 说明：`writeConfig` 在上面未使用；若 lint/类型检查报未使用导入，删除该导入。

- [x] **Step 3: 运行确认失败**

Run: `npm test -- tests/ssh/dialer.test.ts`
Expected: FAIL，无法解析 `../../src/ssh/dialer.js`。

- [x] **Step 4: 实现 Dialer**

`src/ssh/dialer.ts`：

```ts
import { readFileSync, statSync } from "node:fs";
import type net from "node:net";
import ssh2 from "ssh2";
import type { Client, ConnectConfig, ParsedKey } from "ssh2";
import type { Proxy, SSHAuth } from "../config/types.js";
import { nullLogger, type Logger } from "../log.js";
import { KnownHostsStore } from "./known_hosts.js";
import { connectUnderlying, splitHostPort } from "./proxy.js";

const { Client, utils } = ssh2;

export interface DialOptions {
  addr: string;
  user: string;
  auth: SSHAuth;
  proxy?: Proxy;
  serverName?: string;
  hostKeyVerify: boolean;
}

export interface AuthConfig {
  password?: string;
  privateKey?: Buffer;
  passphrase?: string;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 装配认证信息。private_key 优先，即使同时配置 password 也不回退。
 * 私钥权限必须 0600 或更严（Windows 跳过，交给 NTFS ACL）。
 */
export function loadAuth(auth: SSHAuth): AuthConfig {
  if (auth.private_key) {
    return {
      privateKey: loadPrivateKey(auth.private_key, auth.passphrase),
      passphrase: auth.passphrase,
    };
  }
  if (auth.password) return { password: auth.password };
  throw new Error("no auth method available (need password or private_key)");
}

export function loadPrivateKey(keyPath: string, passphrase?: string): Buffer {
  let info;
  try {
    info = statSync(keyPath);
  } catch (err) {
    throw new Error(`stat private key ${keyPath}: ${message(err)}`);
  }
  if (process.platform !== "win32") {
    const perm = info.mode & 0o777;
    if ((perm & 0o077) !== 0) {
      throw new Error(
        `private key ${keyPath} permissions too open: ${perm.toString(8)}, want 0600 or stricter (no group/other access)`,
      );
    }
  }
  let data: Buffer;
  try {
    data = readFileSync(keyPath);
  } catch (err) {
    throw new Error(`read private key ${keyPath}: ${message(err)}`);
  }
  const parsed = utils.parseKey(data, passphrase || undefined);
  if (parsed instanceof Error) {
    throw new Error(`parse private key ${keyPath}: ${parsed.message}`);
  }
  return data;
}

export class Dialer {
  constructor(
    private readonly knownHosts: KnownHostsStore,
    private readonly logger: Logger = nullLogger,
  ) {}

  async dial(opts: DialOptions): Promise<Client> {
    this.logger.debug("dialing", {
      server: opts.serverName,
      addr: opts.addr,
      user: opts.user,
      auth_method: opts.auth.private_key ? "private_key" : "password",
      via_proxy: !!opts.proxy,
    });
    const auth = loadAuth(opts.auth);

    let socket: net.Socket;
    try {
      socket = await connectUnderlying(opts.addr, opts.proxy, this.logger);
    } catch (err) {
      throw new Error(`dial ${opts.addr}: ${message(err)}`);
    }

    let hostKeyError: Error | undefined;
    const config: ConnectConfig = {
      host: splitHostPort(opts.addr).host,
      port: splitHostPort(opts.addr).port,
      username: opts.user,
      sock: socket,
      readyTimeout: 10_000,
      hostVerifier: (key: Buffer): boolean => {
        if (!opts.hostKeyVerify) {
          this.logger.debug("host key verification disabled", {
            server: opts.serverName,
            addr: opts.addr,
          });
          return true;
        }
        try {
          const status = this.knownHosts.check(opts.addr, key);
          this.logger.debug("host key verified", {
            server: opts.serverName,
            addr: opts.addr,
            fingerprint: status,
          });
          return true;
        } catch (err) {
          hostKeyError = err instanceof Error ? err : new Error(String(err));
          this.logger.warn("host key check failed", {
            server: opts.serverName,
            addr: opts.addr,
            err: hostKeyError.message,
          });
          return false;
        }
      },
    };
    if (auth.password !== undefined) config.password = auth.password;
    if (auth.privateKey !== undefined) config.privateKey = auth.privateKey;
    if (auth.passphrase !== undefined) config.passphrase = auth.passphrase;

    const client = new Client();
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const fail = (err: Error): void => {
          if (settled) return;
          settled = true;
          socket.destroy();
          reject(err);
        };
        client.once("ready", () => {
          if (settled) return;
          settled = true;
          resolve();
        });
        client.once("error", fail);
        client.once("close", () => fail(new Error("connection closed")));
        client.connect(config);
      });
    } catch (err) {
      if (hostKeyError) throw hostKeyError;
      throw new Error(`ssh connect to ${opts.addr}: ${message(err)}`);
    }
    client.on("error", (err: Error) => {
      this.logger.warn("ssh client error", {
        server: opts.serverName,
        addr: opts.addr,
        err: err.message,
      });
    });
    this.logger.debug("ssh connected", {
      server: opts.serverName,
      addr: opts.addr,
    });
    return client;
  }
}
```

- [x] **Step 5: 运行 Dialer 测试**

Run: `npm test -- tests/ssh/dialer.test.ts`
Expected: PASS（10 个用例）。

若私钥测试因 ssh2 server 拒绝而失败，检查 `FakeSshServer` 的 `allowPublicKey` 分支；不改变实现。

- [x] **Step 6: 类型检查并提交**

Run: `npm run typecheck`
Expected: 退出码 0。

```bash
git add src/ssh/dialer.ts tests/ssh/dialer.test.ts tests/helpers/fake_ssh.ts
git commit -m "feat: add SSH dialer with TOFU and proxy support"
```

---

### Task 4: PTY 纯逻辑（normalize / sentinel / shell detect）

**Files:**
- Create: `src/pty/normalize.ts`, `src/pty/sentinel.ts`, `src/pty/shell_detect.ts`
- Test: `tests/pty/normalize.test.ts`, `tests/pty/sentinel.test.ts`, `tests/pty/shell_detect.test.ts`

- [x] **Step 1: 写失败的三组测试**

`tests/pty/normalize.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { cleanOutput, stripANSI } from "../../src/pty/normalize.js";

describe("stripANSI", () => {
  it("strips CSI and OSC sequences", () => {
    expect(stripANSI("\x1b[31mred\x1b[0m")).toBe("red");
    expect(stripANSI("a\x1b]0;window title\x07b")).toBe("ab");
    expect(stripANSI("\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\")).toBe("link");
  });
});

describe("cleanOutput", () => {
  it("removes tokenized and initial sentinels", () => {
    expect(cleanOutput("hello\r\n_0__abc_token__]# \r\n", "abc")).toBe("hello");
    expect(cleanOutput("out\r\n_1__abc___]# \r\n", "abc")).toBe("out");
  });

  it("removes PS1-only and ANSI and normalizes line endings", () => {
    expect(cleanOutput("__P_abc__> x", "abc")).toBe("x");
    expect(cleanOutput("\x1b[32mok\x1b[0m\r\nnext\rline\n\n", "abc")).toBe("ok\nnextline");
  });

  it("keeps sentinel literals for other sessions", () => {
    expect(cleanOutput("_0__other_token__]# ", "abc")).toBe("_0__other_token__]# ");
  });
});
```

`tests/pty/sentinel.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import {
  detectShellReady,
  extractExitCode,
  truncateOutput,
} from "../../src/pty/sentinel.js";

describe("detectShellReady", () => {
  it("matches the initial PS1 sentinel at the end of the stream", () => {
    expect(detectShellReady("_0__abc___]# ", "abc")).toBe(true);
    expect(detectShellReady("noise _12__abc_ff__]# \r\n", "abc")).toBe(true);
    expect(detectShellReady("_0__abcd___]# ", "abc")).toBe(false);
  });
});

describe("extractExitCode", () => {
  it("returns the last matching exit code", () => {
    expect(extractExitCode("_3__abc_tok__]# then _7__abc_tok__]# ", "abc", "tok")).toBe(7);
    expect(extractExitCode("_0__abc_other__]# ", "abc", "tok")).toBe(-1);
  });
});

describe("truncateOutput", () => {
  it("truncates by bytes and reports the original size", () => {
    expect(truncateOutput("abcdef", 3)).toEqual({
      text: "abc",
      truncated: true,
      totalBytes: 6,
    });
    expect(truncateOutput("abc", 0)).toEqual({
      text: "abc",
      truncated: false,
      totalBytes: 3,
    });
    expect(truncateOutput("😀", 2)).toEqual({
      text: "�",
      truncated: true,
      totalBytes: 4,
    });
  });
});
```

`tests/pty/shell_detect.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { buildRC, parseShellDetect } from "../../src/pty/shell_detect.js";

describe("parseShellDetect", () => {
  it("requires the end marker and takes the last detection line", () => {
    const stream = [
      "__sshmng_dr=ab12; echo __SHELL_DETECT__:$0:${BASH_VERSION:-}:${ZSH_VERSION:-}; echo __DETECT_END_${__sshmng_dr}__",
      "__SHELL_DETECT__:/bin/bash:5.2.15(1)-release:",
      "__DETECT_END_ab12__",
      "",
    ].join("\r\n");
    expect(parseShellDetect(stream, "ab12")).toEqual({ shell: "bash", ok: true });
  });

  it("returns ok=false without the end marker", () => {
    expect(parseShellDetect("__SHELL_DETECT__:/bin/bash:5.2:", "ab12")).toEqual({
      shell: "",
      ok: false,
    });
  });

  it("classifies zsh, ash, dash/sh and unknown shells", () => {
    const line = (value: string) => `__SHELL_DETECT__:${value}\r\n__DETECT_END_x__\r\n`;
    expect(parseShellDetect(line("/usr/bin/zsh::5.9"), "x").shell).toBe("zsh");
    expect(parseShellDetect(line("/bin/busybox::"), "x").shell).toBe("ash");
    expect(parseShellDetect(line("/bin/sh::"), "x").shell).toBe("dash");
    expect(parseShellDetect(line("/usr/bin/fish::"), "x").shell).toBe("fish");
  });
});

describe("buildRC", () => {
  it("sets PS1 last and never contains a Tab", () => {
    for (const shell of ["bash", "zsh", "dash", "unknown"]) {
      const rc = buildRC(shell, "sid123");
      expect(rc).not.toContain("\t");
      expect(rc.lastIndexOf("export PS1=")).toBeGreaterThan(rc.lastIndexOf("stty -echo"));
      expect(rc).toContain("export TERM=dumb");
      expect(rc).toContain("stty cols 120 rows 100");
    }
  });

  it("uses $(echo _$?) for bash/zsh and __P_ for the rest", () => {
    expect(buildRC("bash", "sid123")).toContain("export PS1='$(echo _$?)__sid123___]# '");
    expect(buildRC("bash", "sid123")).toContain("set +o history");
    expect(buildRC("zsh", "sid123")).toContain("setopt PROMPT_SUBST");
    expect(buildRC("dash", "sid123")).toContain("export PS1='__P_sid123__> '");
    expect(buildRC("dash", "sid123")).not.toContain("$(echo _$?)");
  });
});
```

- [x] **Step 2: 运行确认失败**

Run: `npm test -- tests/pty`
Expected: FAIL，无法解析 `src/pty/*.js`。

- [x] **Step 3: 实现 normalize / sentinel / shell_detect**

`src/pty/normalize.ts`：

```ts
const ANSI_RE = /\x1b(?:\[[0-9;?]*[A-Za-z]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function stripANSI(text: string): string {
  return text.replace(ANSI_RE, "");
}

/** PTY 原始流 → 用户可读输出；只清除本 sid 的 sentinel。 */
export function cleanOutput(raw: string, sid: string): string {
  let text = stripANSI(raw);
  const sentinel = new RegExp(`_-?\\d+__${escapeRegex(sid)}_\\w*__\\]# `, "g");
  text = text.replace(sentinel, "");
  const ps1Only = new RegExp(`__P_${escapeRegex(sid)}__>\\s?`, "g");
  text = text.replace(ps1Only, "");
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "");
  return text.replace(/\n+$/, "");
}
```

`src/pty/sentinel.ts`：

```ts
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** bash/zsh 初始 PS1 sentinel 是否出现在流末尾（token 可空）。 */
export function detectShellReady(stream: string, sid: string): boolean {
  return new RegExp(`_-?\\d+__${escapeRegex(sid)}_\\w*__\\]#\\s*$`).test(stream);
}

/** 取最后一个匹配 token 的 exit code；找不到返回 -1。 */
export function extractExitCode(stream: string, sid: string, token: string): number {
  const re = new RegExp(
    `_(-?\\d+)__${escapeRegex(sid)}_${escapeRegex(token)}__\\]# `,
    "g",
  );
  let last: RegExpExecArray | null = null;
  for (let match = re.exec(stream); match; match = re.exec(stream)) last = match;
  if (!last) return -1;
  const code = Number.parseInt(last[1]!, 10);
  return Number.isNaN(code) ? -1 : code;
}

export interface TruncatedOutput {
  text: string;
  truncated: boolean;
  totalBytes: number;
}

/** 按字节保头截尾；maxBytes <= 0 不截断。 */
export function truncateOutput(text: string, maxBytes: number): TruncatedOutput {
  const totalBytes = Buffer.byteLength(text);
  if (maxBytes <= 0 || totalBytes <= maxBytes) {
    return { text, truncated: false, totalBytes };
  }
  return {
    text: Buffer.from(text).subarray(0, maxBytes).toString("utf8"),
    truncated: true,
    totalBytes,
  };
}
```

`src/pty/shell_detect.ts`：

```ts
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface ShellDetectResult {
  shell: string;
  ok: boolean;
}

/** 解析 detect 输出；必须出现展开后的 end marker，取最后一条结果行。 */
export function parseShellDetect(stream: string, rand: string): ShellDetectResult {
  if (!new RegExp(`__DETECT_END_${escapeRegex(rand)}__`).test(stream)) {
    return { shell: "", ok: false };
  }
  const detectRe = /__SHELL_DETECT__:([^:\r\n]*):([^:\r\n]*):([^:\r\n]*)\r?$/gm;
  let last: RegExpExecArray | null = null;
  for (let match = detectRe.exec(stream); match; match = detectRe.exec(stream)) {
    last = match;
  }
  if (!last) return { shell: "", ok: false };
  return {
    shell: classifyShell(last[1] ?? "", last[2] ?? "", last[3] ?? ""),
    ok: true,
  };
}

export function classifyShell(shellPath: string, bashVersion: string, zshVersion: string): string {
  const base = shellPath.slice(shellPath.lastIndexOf("/") + 1);
  if (bashVersion !== "") return "bash";
  if (zshVersion !== "") return "zsh";
  switch (base) {
    case "bash":
      return "bash";
    case "zsh":
      return "zsh";
    case "ash":
    case "busybox":
      return "ash";
    case "dash":
    case "sh":
      return "dash";
    default:
      return base;
  }
}

/**
 * 生成 RC 注入脚本（PS1-only 设计）。locale 探测块必须用空格缩进，
 * 绝不能用 Tab：交互式 bash 的 readline 会把 Tab 当补全键并阻塞。
 */
export function buildRC(shell: string, sid: string): string {
  const common = `export TERM=dumb
export NO_COLOR=1
if command -v locale >/dev/null 2>&1; then
  _avail=$(locale -a 2>/dev/null)
  _pick=C
  while IFS= read -r _line; do
    case "$_line" in
      C.UTF-8|C.utf8) _pick=C.UTF-8; break ;;
      en_US.UTF-8|en_US.utf8) [ "$_pick" = C ] && _pick=en_US.UTF-8 ;;
    esac
  done <<EOF
$_avail
EOF
  export LANG=$_pick; export LC_ALL=$_pick
  unset _pick _line _avail
else
  export LANG=C; export LC_ALL=C
fi
stty cols 120 rows 100 2>/dev/null
`;
  if (shell === "bash") {
    return `${common}set +o history
stty -echo 2>/dev/null
export PS1='$(echo _$?)__${sid}___]# '
`;
  }
  if (shell === "zsh") {
    return `${common}setopt PROMPT_SUBST
unset HISTFILE
stty -echo 2>/dev/null
export PS1='$(echo _$?)__${sid}___]# '
`;
  }
  return `${common}stty -echo 2>/dev/null
export PS1='__P_${sid}__> '
`;
}
```

- [x] **Step 4: 运行测试**

Run: `npm test -- tests/pty`
Expected: PASS（normalize 4 + sentinel 4 + shell_detect 5 个用例）。

- [x] **Step 5: 类型检查并提交**

Run: `npm run typecheck`

```bash
git add src/pty/normalize.ts src/pty/sentinel.ts src/pty/shell_detect.ts tests/pty
git commit -m "feat: add PTY normalization, sentinel parsing, and shell detection"
```

---

### Task 5: ByteQueue、传输抽象与 PtyConn

**Files:**
- Create: `src/pty/queue.ts`, `src/pty/transport.ts`, `src/pty/pty_conn.ts`
- Modify: `src/ssh/errors.ts`（新增 `PtyUnusableError`）
- Modify: `src/ssh/types.ts`（新增 `LoginTraceEntry`、`LoginFlowError`、`RunOutcome`、`RawReadResult`）
- Modify: `tests/helpers/fake_ssh.ts`（把 `FakeShell` 改为 `export`）
- Create: `tests/helpers/fake_pty.ts`
- Test: `tests/pty/pty_conn.test.ts`

- [x] **Step 1: 扩展错误类型**

`src/ssh/errors.ts` 追加：

```ts
/** PTY 状态机不可恢复（setup token 超时 / drain 失败），Session 应关闭连接。 */
export class PtyUnusableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PtyUnusableError";
  }
}
```

`src/ssh/types.ts`（新文件）：

```ts
export interface LoginTraceEntry {
  time: string;
  elapsed_ms: number;
  send: string;
  expect: string;
  output: string;
}

export class LoginFlowError extends Error {
  constructor(
    readonly stage: string,
    readonly trace: LoginTraceEntry[],
    message: string,
  ) {
    super(message);
    this.name = "LoginFlowError";
  }
}

export interface RunOutcome {
  output: string;
  rawOutput: string;
  exitCode: number;
  timedOut: boolean;
  ctrlCSent: boolean;
  truncated: boolean;
  totalBytes: number;
  connUnusable: boolean;
}

export interface RawReadResult {
  output: string;
  more: boolean;
  idleMs: number;
}
```

- [x] **Step 2: 写假 PTY 传输**

先把 `tests/helpers/fake_ssh.ts` 中的 `class FakeShell` 改为 `export class FakeShell`，并给 `input` 前补 `/** 喂入终端字节。 */`（内容不变）。

`tests/helpers/fake_pty.ts`：

```ts
import type { PtyTransport } from "../../src/pty/transport.js";
import { FakeShell } from "./fake_ssh.js";

export class FakePtyTransport implements PtyTransport {
  readonly written: Buffer[] = [];
  sftp = false;
  autoRespond: boolean;
  private readonly dataHandlers = new Set<(data: Buffer) => void>();
  private readonly closeHandlers = new Set<(err?: Error) => void>();
  private readonly shell: FakeShell;

  constructor(opts: { raw?: boolean } = {}) {
    this.autoRespond = !opts.raw;
    this.shell = new FakeShell((text) => this.emit(Buffer.from(text)), !!opts.raw);
  }

  write(data: Buffer | string): void {
    const buf = Buffer.from(data);
    this.written.push(buf);
    if (this.autoRespond) this.shell.input(buf);
  }

  emit(data: Buffer | string): void {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    for (const handler of this.dataHandlers) handler(buf);
  }

  onData(handler: (data: Buffer) => void): () => void {
    this.dataHandlers.add(handler);
    return () => this.dataHandlers.delete(handler);
  }

  onClose(handler: (err?: Error) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  close(): void {
    this.shell.cancel();
    for (const handler of this.closeHandlers) handler();
  }

  probeSftp(): Promise<boolean> {
    return Promise.resolve(this.sftp);
  }

  allWritten(): string {
    return Buffer.concat(this.written).toString("latin1");
  }
}
```

- [x] **Step 3: 写失败的 PtyConn 测试**

`tests/pty/pty_conn.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { PtyConn } from "../../src/pty/pty_conn.js";
import { ConnLostError } from "../../src/ssh/errors.js";
import { FakePtyTransport } from "../helpers/fake_pty.js";

function make(opts: { raw?: boolean } = {}) {
  const transport = new FakePtyTransport(opts);
  const conn = new PtyConn(transport, "ab12", {
    shellDetectTimeoutMs: 1000,
    rcInjectTimeoutMs: 1000,
    setTokenTimeoutMs: 500,
    ctrlCDrainTimeoutMs: 200,
    rawQuietGapMs: 10,
  });
  return { transport, conn };
}

async function ready(raw = false) {
  const ctx = make({ raw });
  if (!raw) {
    expect(await ctx.conn.detectShell()).toBe("bash");
    await ctx.conn.injectRC();
  } else {
    ctx.conn.markRaw();
  }
  return ctx;
}

describe("PtyConn shell mode", () => {
  it("detects bash and injects RC", async () => {
    const { transport, conn } = await ready();
    expect(conn.shell).toBe("bash");
    expect(conn.mode).toBe("shell");
    expect(transport.allWritten()).toContain("export TERM=dumb");
  });

  it("runs commands and reports cleaned output and exit codes", async () => {
    const { conn } = await ready();
    const hello = await conn.run("echo hello", 1000, 0);
    expect(hello.output).toBe("hello");
    expect(hello.exitCode).toBe(0);
    expect(hello.timedOut).toBe(false);
    const failed = await conn.run("false", 1000, 0);
    expect(failed.exitCode).toBe(1);
    const pwd = await conn.run("pwd", 1000, 0);
    expect(pwd.output).toBe("/home/test");
  });

  it("truncates output and raw output by bytes", async () => {
    const { conn } = await ready();
    const outcome = await conn.run("seq 100", 1000, 10);
    expect(outcome.truncated).toBe(true);
    expect(Buffer.byteLength(outcome.output)).toBeLessThanOrEqual(10);
    expect(Buffer.byteLength(outcome.rawOutput)).toBeLessThanOrEqual(10);
    expect(outcome.totalBytes).toBeGreaterThan(10);
  });

  it("sends Ctrl-C on timeout and stays usable after drain", async () => {
    const { transport, conn } = await ready();
    const outcome = await conn.run("sleep 5", 30, 0);
    expect(outcome.timedOut).toBe(true);
    expect(outcome.ctrlCSent).toBe(true);
    expect(outcome.connUnusable).toBe(false);
    expect(transport.allWritten()).toContain("\x03");
    const next = await conn.run("echo back", 1000, 0);
    expect(next.output).toBe("back");
  });

  it("rejects raw commands on a raw device", async () => {
    const { conn } = await ready(true);
    expect(conn.mode).toBe("raw");
    await expect(conn.run("echo x", 1000, 0)).rejects.toThrow(
      "raw device: Run not supported, use SendRaw/ReadRaw",
    );
  });
});

describe("PtyConn raw mode", () => {
  it("sends verbatim bytes and reads with quiet absorption", async () => {
    const { transport, conn } = await ready(true);
    await conn.sendRaw(Buffer.from("ping\r"));
    transport.emit("pong");
    const result = await conn.readRaw(500, 1024);
    expect(result.output).toBe("pong");
    expect(result.more).toBe(false);
  });

  it("returns empty output on a non-blocking read with no data", async () => {
    const { conn } = await ready(true);
    const result = await conn.readRaw(0, 1024);
    expect(result).toEqual({ output: "", more: false, idleMs: expect.any(Number) });
  });

  it("keeps excess bytes queued and reports more", async () => {
    const { transport, conn } = await ready(true);
    transport.emit("abcdef");
    const first = await conn.readRaw(0, 3);
    expect(first.output).toBe("abc");
    expect(first.more).toBe(true);
    const second = await conn.readRaw(0, 1024);
    expect(second.output).toBe("def");
  });

  it("raises connection lost when the transport closes without data", async () => {
    const { transport, conn } = await ready(true);
    transport.close();
    await expect(conn.readRaw(100, 1024)).rejects.toBeInstanceOf(ConnLostError);
    await expect(conn.sendRaw(Buffer.from("x"))).rejects.toThrow("connection closed");
  });
});
```

- [x] **Step 4: 实现 ByteQueue / transport / PtyConn**

`src/pty/queue.ts`：

```ts
/** 单消费者字节队列：push / drain / wait，关闭后不再接收数据。 */
export class ByteQueue {
  private chunks: Buffer[] = [];
  private bytes = 0;
  private closedRaw = false;
  private waiters: Array<() => void> = [];

  push(data: Buffer): void {
    if (this.closedRaw || data.length === 0) return;
    this.chunks.push(data);
    this.bytes += data.length;
    this.wake();
  }

  pushBack(data: Buffer): void {
    if (data.length === 0) return;
    this.chunks.unshift(data);
    this.bytes += data.length;
    this.wake();
  }

  drain(): Buffer {
    const out = Buffer.concat(this.chunks);
    this.chunks = [];
    this.bytes = 0;
    return out;
  }

  get size(): number {
    return this.bytes;
  }

  get closed(): boolean {
    return this.closedRaw;
  }

  close(): void {
    this.closedRaw = true;
    this.wake();
  }

  /** 有数据 / 已关闭 / 超时后 resolve。 */
  wait(ms: number): Promise<void> {
    if (this.bytes > 0 || this.closedRaw || ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const waiter = (): void => {
        clearTimeout(timer);
        this.waiters = this.waiters.filter((item) => item !== waiter);
        resolve();
      };
      const timer = setTimeout(waiter, ms);
      this.waiters.push(waiter);
    });
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter();
  }
}
```

`src/pty/transport.ts`：

```ts
/** PTY 传输抽象：真实实现是 ssh2 channel，测试实现是 FakePtyTransport。 */
export interface PtyTransport {
  write(data: Buffer | string): void;
  onData(handler: (data: Buffer) => void): () => void;
  onClose(handler: (err?: Error) => void): () => void;
  close(): void;
  probeSftp(): Promise<boolean>;
}
```

`src/pty/pty_conn.ts`：

```ts
import { ConnLostError, PtyUnusableError } from "../ssh/errors.js";
import { LoginFlowError, type LoginTraceEntry, type RawReadResult, type RunOutcome } from "../ssh/types.js";
import { nullLogger, type Logger } from "../log.js";
import { randomSID } from "../util/random.js";
import { traceTimestamp } from "../util/time.js";
import { cleanOutput } from "./normalize.js";
import { ByteQueue } from "./queue.js";
import { detectShellReady, extractExitCode, truncateOutput } from "./sentinel.js";
import { buildRC, parseShellDetect } from "./shell_detect.js";
import type { PtyTransport } from "./transport.js";

export const DEFAULT_CMD_TIMEOUT_MS = 30_000;
const CTRL_C_DRAIN_TIMEOUT_MS = 3_000;
const SET_TOKEN_TIMEOUT_MS = 2_000;
const SHELL_DETECT_TIMEOUT_MS = 5_000;
const RC_INJECT_TIMEOUT_MS = 5_000;
const RAW_QUIET_GAP_MS = 400;

export interface PtyConnOptions {
  cmdTimeoutMs?: number;
  setTokenTimeoutMs?: number;
  ctrlCDrainTimeoutMs?: number;
  shellDetectTimeoutMs?: number;
  rcInjectTimeoutMs?: number;
  rawQuietGapMs?: number;
  logger?: Logger;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readyRe(sid: string): RegExp {
  return new RegExp(`_-?\\d+__${escapeRegex(sid)}_\\w*__\\]# `);
}

function tokenRe(sid: string, token: string): RegExp {
  return new RegExp(`_-?\\d+__${escapeRegex(sid)}_${escapeRegex(token)}__\\]# `);
}

/** 包装 SSH channel 的 PTY，负责 sentinel 命令执行与 raw 终端原语。 */
export class PtyConn {
  private readonly queue = new ByteQueue();
  private pushback: Buffer = Buffer.alloc(0);
  private closedFlag = false;
  private shellType = "";
  private lastOutputAt = Date.now();
  private readonly detachData: () => void;
  private readonly detachClose: () => void;
  private readonly logger: Logger;

  constructor(
    private readonly transport: PtyTransport,
    readonly sid: string,
    private readonly options: PtyConnOptions = {},
  ) {
    this.logger = options.logger ?? nullLogger;
    this.detachData = transport.onData((data) => {
      this.lastOutputAt = Date.now();
      this.queue.push(data);
    });
    this.detachClose = transport.onClose(() => {
      this.closedFlag = true;
      this.queue.close();
    });
  }

  get shell(): string {
    return this.shellType;
  }

  get mode(): "shell" | "raw" {
    return this.shellType === "raw" ? "raw" : "shell";
  }

  get closed(): boolean {
    return this.closedFlag;
  }

  get lastOutputAtMs(): number {
    return this.lastOutputAt;
  }

  markRaw(): void {
    this.shellType = "raw";
  }

  async detectShell(): Promise<string> {
    try {
      return await this.doDetectShell();
    } catch (err) {
      throw new Error(`detect shell: ${message(err)}`);
    }
  }

  private async doDetectShell(): Promise<string> {
    const rand = randomSID();
    const cmd =
      "__sshmng_dr=" + rand +
      "; echo __SHELL_DETECT__:$0:${BASH_VERSION:-}:${ZSH_VERSION:-}; echo __DETECT_END_${__sshmng_dr}__\n";
    this.writeRaw(cmd);
    const marker = `__DETECT_END_${rand}__`;
    const { text, timedOut } = await this.readUntil(
      (input) => input.indexOf(marker),
      this.options.shellDetectTimeoutMs ?? SHELL_DETECT_TIMEOUT_MS,
    );
    if (timedOut) {
      throw new Error(
        `timeout waiting for ${JSON.stringify(marker)} after ${
          (this.options.shellDetectTimeoutMs ?? SHELL_DETECT_TIMEOUT_MS) / 1000
        }s; got: ${JSON.stringify(text)}`,
      );
    }
    // readUntil 返回 marker 之前的文本；parse 需要看到展开后的 end marker。
    const parsed = parseShellDetect(text + marker, rand);
    if (!parsed.ok) throw new Error(`could not parse shell from: ${JSON.stringify(text)}`);
    this.shellType = parsed.shell;
    return parsed.shell;
  }

  async injectRC(): Promise<LoginTraceEntry> {
    const rc = buildRC(this.shellType, this.sid);
    const started = Date.now();
    this.writeRaw(rc);
    const useRegex = this.shellType === "bash" || this.shellType === "zsh";
    const expect = useRegex
      ? "initial PS1 sentinel"
      : `__P_${this.sid}__> `;
    const timeout = this.options.rcInjectTimeoutMs ?? RC_INJECT_TIMEOUT_MS;
    const { text, timedOut } = useRegex
      ? await this.readUntilRegex(readyRe(this.sid), timeout)
      : await this.readUntil((input) => input.indexOf(expect), timeout);
    const trace: LoginTraceEntry = {
      time: traceTimestamp(new Date(started)),
      elapsed_ms: Date.now() - started,
      send: rc,
      expect,
      output: text,
    };
    if (timedOut) {
      throw new LoginFlowError(
        "rc_inject",
        [trace],
        `inject rc: timeout waiting for ${expect} after ${timeout / 1000}s; pty output: ${JSON.stringify(text)}`,
      );
    }
    return trace;
  }

  async run(cmd: string, timeoutMs = 0, maxOutputBytes = 0): Promise<RunOutcome> {
    this.requireOpen();
    if (this.shellType === "raw") {
      throw new Error("raw device: Run not supported, use SendRaw/ReadRaw");
    }
    const timeout = timeoutMs > 0 ? timeoutMs : this.options.cmdTimeoutMs ?? DEFAULT_CMD_TIMEOUT_MS;
    if (this.shellType === "bash" || this.shellType === "zsh") {
      return this.runWithToken(cmd, timeout, maxOutputBytes);
    }
    return this.runPS1Only(cmd, timeout, maxOutputBytes);
  }

  private async runWithToken(cmd: string, timeout: number, maxOutputBytes: number): Promise<RunOutcome> {
    const token = randomSID();
    this.writeRaw(`PS1='$(echo _$?)__${this.sid}_${token}__]# '\n`);
    const setup = await this.readUntilRegex(
      tokenRe(this.sid, token),
      this.options.setTokenTimeoutMs ?? SET_TOKEN_TIMEOUT_MS,
    );
    if (setup.timedOut) {
      this.logger.warn("setup token timed out, conn unusable", { sid: this.sid, token });
      throw new PtyUnusableError("setup token timeout");
    }
    this.pushback = Buffer.alloc(0);
    this.writeRaw(cmd + "\n");
    let { text: raw, timedOut } = await this.readUntilRegex(tokenRe(this.sid, token), timeout);
    let ctrlCSent = false;
    let connUnusable = false;
    if (timedOut) {
      try {
        this.writeRaw(Buffer.from([0x03]));
        ctrlCSent = true;
      } catch (err) {
        this.logger.error("failed to send Ctrl-C after timeout", { err: message(err) });
      }
      const drain = await this.readUntilRegex(
        tokenRe(this.sid, token),
        this.options.ctrlCDrainTimeoutMs ?? CTRL_C_DRAIN_TIMEOUT_MS,
      );
      raw += drain.text;
      if (drain.timedOut) connUnusable = true;
    }
    return this.finishRun(raw, maxOutputBytes, token, timedOut, ctrlCSent, connUnusable);
  }

  private async runPS1Only(cmd: string, timeout: number, maxOutputBytes: number): Promise<RunOutcome> {
    this.writeRaw(cmd + "\n");
    const sentinel = `__P_${this.sid}__> `;
    let { text: raw, timedOut } = await this.readUntil((input) => input.indexOf(sentinel), timeout);
    let ctrlCSent = false;
    let connUnusable = false;
    if (timedOut) {
      try {
        this.writeRaw(Buffer.from([0x03]));
        ctrlCSent = true;
      } catch (err) {
        this.logger.error("failed to send Ctrl-C after timeout", { err: message(err) });
      }
      const drain = await this.readUntil(
        (input) => input.indexOf(sentinel),
        this.options.ctrlCDrainTimeoutMs ?? CTRL_C_DRAIN_TIMEOUT_MS,
      );
      raw += drain.text;
      if (drain.timedOut) connUnusable = true;
    }
    return this.finishRun(raw, maxOutputBytes, "", timedOut, ctrlCSent, connUnusable);
  }

  private finishRun(
    raw: string,
    maxOutputBytes: number,
    token: string,
    timedOut: boolean,
    ctrlCSent: boolean,
    connUnusable: boolean,
  ): RunOutcome {
    const code = token ? extractExitCode(raw, this.sid, token) : -1;
    const cleaned = cleanOutput(raw, this.sid);
    const output = truncateOutput(cleaned, maxOutputBytes);
    const rawOut = truncateOutput(raw, maxOutputBytes);
    return {
      output: output.text,
      rawOutput: rawOut.text,
      exitCode: code,
      timedOut,
      ctrlCSent,
      truncated: output.truncated,
      totalBytes: output.totalBytes,
      connUnusable,
    };
  }

  async sendRaw(data: Buffer): Promise<void> {
    if (this.closedFlag) throw new Error("connection closed");
    this.transport.write(data);
  }

  async readRaw(waitMs: number, maxBytes: number): Promise<RawReadResult> {
    if (this.closedFlag && this.pushback.length === 0 && this.queue.size === 0) {
      throw new ConnLostError();
    }
    const limit = maxBytes > 0 ? maxBytes : 1 << 20;
    const quietGap = this.options.rawQuietGapMs ?? RAW_QUIET_GAP_MS;
    let buf: Buffer = this.pushback;
    this.pushback = Buffer.alloc(0);

    if (buf.length === 0) {
      if (waitMs > 0 && this.queue.size === 0) await this.queue.wait(waitMs);
      if (this.queue.size > 0) buf = this.queue.drain();
      else if (this.queue.closed) throw new ConnLostError();
      else return { output: "", more: false, idleMs: this.idleMs() };
    }

    const deadline = Date.now() + Math.max(0, waitMs);
    while (buf.length < limit) {
      if (this.queue.size > 0) {
        buf = Buffer.concat([buf, this.queue.drain()]);
        continue;
      }
      const now = Date.now();
      if (now >= deadline) break;
      await this.queue.wait(Math.min(quietGap, deadline - now));
      if (this.queue.size === 0) break;
    }

    const out = buf.subarray(0, limit);
    if (buf.length > limit) this.pushback = buf.subarray(limit);
    const more = this.pushback.length > 0 || this.queue.size > 0;
    return { output: out.toString("utf8"), more, idleMs: out.length > 0 ? 0 : this.idleMs() };
  }

  private idleMs(): number {
    return Date.now() - this.lastOutputAt;
  }

  async probeSftp(): Promise<boolean> {
    return this.transport.probeSftp();
  }

  close(): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    this.queue.close();
    this.detachData();
    this.detachClose();
    try {
      this.transport.close();
    } catch (err) {
      this.logger.warn("close pty transport", { err: message(err) });
    }
  }

  private requireOpen(): void {
    if (this.closedFlag) throw new Error("connection closed");
  }

  private writeRaw(data: Buffer | string): void {
    if (this.closedFlag) throw new Error("connection closed");
    this.transport.write(data);
  }

  private async readUntilRegex(
    regex: RegExp,
    timeoutMs: number,
  ): Promise<{ text: string; timedOut: boolean }> {
    return this.readUntil((input) => {
      const match = regex.exec(input);
      return match ? match.index + match[0].length : -1;
    }, timeoutMs);
  }

  private async readUntil(
    findEnd: (input: string) => number,
    timeoutMs: number,
  ): Promise<{ text: string; timedOut: boolean }> {
    const deadline = Date.now() + timeoutMs;
    let buf = this.pushback;
    this.pushback = Buffer.alloc(0);
    for (;;) {
      const end = findEnd(buf.toString("latin1"));
      if (end >= 0) {
        this.pushback = buf.subarray(end);
        return { text: buf.subarray(0, end).toString("latin1"), timedOut: false };
      }
      if (this.queue.size > 0) {
        buf = Buffer.concat([buf, this.queue.drain()]);
        continue;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0 || this.queue.closed) {
        return { text: buf.toString("latin1"), timedOut: true };
      }
      await this.queue.wait(remaining);
    }
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
```

- [x] **Step 5: 运行测试**

Run: `npm test -- tests/pty`
Expected: PASS（Task 4 + Task 5 全部用例）。

- [x] **Step 6: 类型检查并提交**

Run: `npm run typecheck`

```bash
git add src/pty src/ssh/errors.ts src/ssh/types.ts tests/pty tests/helpers/fake_pty.ts tests/helpers/fake_ssh.ts
git commit -m "feat: add PtyConn sentinel state machine and raw terminal IO"
```

---

### Task 6: Session 状态机与 Manager（trace / graveyard / idle timeout）

**Files:**
- Create: `src/session/trace.ts`, `src/session/session.ts`, `src/session/manager.ts`
- Test: `tests/session/session.test.ts`, `tests/session/manager.test.ts`

- [x] **Step 1: 写失败的 Session 测试**

`tests/session/session.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { Session } from "../../src/session/session.js";
import { ConnLostError, PtyUnusableError } from "../../src/ssh/errors.js";
import type { RawReadResult, RunOutcome } from "../../src/ssh/types.js";

class FakeConn {
  mode: "shell" | "raw" = "shell";
  closed = false;
  sent: Buffer[] = [];
  reads: RawReadResult[] = [];
  gate: Promise<void> | null = null;
  outcome: RunOutcome = {
    output: "ok",
    rawOutput: "ok",
    exitCode: 0,
    timedOut: false,
    ctrlCSent: false,
    truncated: false,
    totalBytes: 2,
    connUnusable: false,
  };
  error: Error | null = null;

  async run(): Promise<RunOutcome> {
    if (this.gate) await this.gate;
    if (this.error) throw this.error;
    return this.outcome;
  }
  async sendRaw(data: Buffer): Promise<void> {
    if (this.error) throw this.error;
    this.sent.push(data);
  }
  async readRaw(): Promise<RawReadResult> {
    if (this.error) throw this.error;
    return this.reads.shift() ?? { output: "", more: false, idleMs: 0 };
  }
  close(): void {
    this.closed = true;
  }
}

function make(options: { raw?: boolean; idleTimeoutMs?: number; now?: () => number } = {}) {
  const conn = new FakeConn();
  const session = new Session("s1", "server-a", conn, {
    idleTimeoutMs: options.idleTimeoutMs ?? 0,
    raw: options.raw,
    now: options.now,
  });
  return { conn, session };
}

describe("Session", () => {
  it("runs a command and records a trace", async () => {
    const { session } = make();
    const result = await session.run("echo hi", 1000, 0);
    expect(result).toEqual({
      output: "ok",
      exit_code: 0,
      timed_out: false,
      truncated: false,
      total_bytes: 2,
    });
    const traces = session.getTraces(0, 0);
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({
      cmd: "echo hi",
      output: "ok",
      raw_output: "ok",
      exit_code: 0,
      timed_out: false,
      ctrl_c_sent: false,
    });
    expect(traces[0]!.time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(session.stat()).toMatchObject({ state: "idle", commands_run: 1, mode: "shell" });
  });

  it("rejects concurrent runs and closed sessions", async () => {
    const { conn, session } = make();
    let release!: () => void;
    conn.gate = new Promise((resolve) => { release = resolve; });
    const first = session.run("sleep 1", 1000, 0);
    await expect(session.run("true", 1000, 0)).rejects.toThrow("session busy");
    release();
    await first;
    session.close();
    await expect(session.run("true", 1000, 0)).rejects.toThrow("session closed");
  });

  it("rejects run on a raw device", async () => {
    const { session } = make({ raw: true });
    await expect(session.run("echo x", 1000, 0)).rejects.toThrow(
      "raw device: no unix shell, use send_in_session/read_in_session",
    );
    expect(session.stat().mode).toBe("raw");
  });

  it("closes the session when the connection becomes unusable", async () => {
    const { conn, session } = make();
    conn.outcome = { ...conn.outcome, connUnusable: true };
    await session.run("x", 1000, 0);
    expect(session.state).toBe("closed");
    expect(conn.closed).toBe(true);
  });

  it("closes on connection lost and rethrows", async () => {
    const { conn, session } = make();
    conn.error = new ConnLostError();
    await expect(session.run("x", 1000, 0)).rejects.toBeInstanceOf(ConnLostError);
    expect(session.state).toBe("closed");
  });

  it("closes on protocol unusable errors", async () => {
    const { conn, session } = make();
    conn.error = new PtyUnusableError("setup token timeout");
    await expect(session.run("x", 1000, 0)).rejects.toThrow("setup token timeout");
    expect(session.state).toBe("closed");
  });

  it("closes after the idle timeout only while idle", async () => {
    const { session } = make({ idleTimeoutMs: 20 });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(session.state).toBe("closed");
  });

  it("sends raw input and appends reads to the latest trace", async () => {
    const { conn, session } = make({ raw: true });
    conn.reads.push({ output: "pong", more: false, idleMs: 0 });
    expect(await session.sendInSession("ping\r")).toBe(5);
    expect(conn.sent[0]!.toString()).toBe("ping\r");
    const read = await session.readInSession(10, 1024);
    expect(read).toEqual({ output: "pong", more: false, idle_ms: 0 });
    const traces = session.getTraces(0, 0);
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ cmd: "ping\r", output: "pong" });
    expect(session.stat().commands_run).toBe(1);
  });

  it("creates a (read) trace when there is no prior trace", async () => {
    const { conn, session } = make({ raw: true });
    conn.reads.push({ output: "menu", more: false, idleMs: 0 });
    await session.readInSession(10, 1024);
    expect(session.getTraces(0, 0)[0]).toMatchObject({ cmd: "(read)", output: "menu" });
  });

  it("closes when a raw read reports connection lost", async () => {
    const { conn, session } = make({ raw: true });
    conn.error = new ConnLostError();
    await expect(session.readInSession(10, 1024)).rejects.toBeInstanceOf(ConnLostError);
    expect(session.state).toBe("closed");
  });
});
```

- [x] **Step 2: 写失败的 Manager 测试**

`tests/session/manager.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { SessionManager } from "../../src/session/manager.js";
import type { RawReadResult, RunOutcome } from "../../src/ssh/types.js";

class FakeConn {
  mode: "shell" | "raw" = "shell";
  closed = false;
  async run(): Promise<RunOutcome> {
    return {
      output: "x", rawOutput: "x", exitCode: 0, timedOut: false,
      ctrlCSent: false, truncated: false, totalBytes: 1, connUnusable: false,
    };
  }
  async sendRaw(): Promise<void> {}
  async readRaw(): Promise<RawReadResult> {
    return { output: "", more: false, idleMs: 0 };
  }
  close(): void {
    this.closed = true;
  }
}

describe("SessionManager", () => {
  it("returns sessions by sid and reports missing ones", () => {
    const manager = new SessionManager();
    const session = manager.newSession("s1", "srv", new FakeConn(), 0);
    expect(manager.get("s1")).toBe(session);
    expect(() => manager.get("nope")).toThrow('session "nope" not found');
    expect(manager.stat()).toEqual([
      expect.objectContaining({ sid: "s1", name: "srv", state: "idle", mode: "shell" }),
    ]);
  });

  it("lists stats with tags and sorted sids, and empty arrays", () => {
    const manager = new SessionManager();
    expect(manager.stat()).toEqual([]);
    manager.newSession("b", "srv-b", new FakeConn(), 0, { tags: ["blue"] });
    manager.newSession("a", "srv-a", new FakeConn(), 0);
    const stats = manager.stat();
    expect(stats.map((stat) => stat.sid)).toEqual(["a", "b"]);
    expect(stats[1]!.tags).toEqual(["blue"]);
    expect(stats[0]!.tags).toBeUndefined();
  });

  it("keeps traces after close and expires them after 10 minutes", async () => {
    let now = 1_000_000;
    const manager = new SessionManager({ now: () => now });
    const session = manager.newSession("s1", "srv", new FakeConn(), 0);
    await session.run("echo hi", 1000, 0);
    session.close();
    expect(() => manager.get("s1")).toThrow('session "s1" not found');
    expect(manager.getTrace("s1", 0, 0)).toHaveLength(1);
    now += 10 * 60_000;
    expect(manager.getTrace("s1", 0, 0)).toHaveLength(1);
    now += 1;
    expect(() => manager.getTrace("s1", 0, 0)).toThrow(
      'session "s1" not found (alive or within trace TTL)',
    );
  });

  it("applies last_n and trunc_output to traces", async () => {
    const manager = new SessionManager();
    const session = manager.newSession("s1", "srv", new FakeConn(), 0);
    await session.run("one", 1000, 0);
    await session.run("two", 1000, 0);
    const last = manager.getTrace("s1", 1, 1);
    expect(last).toHaveLength(1);
    expect(last[0]!.cmd).toBe("two");
    expect(last[0]!.output).toBe("x");
    expect(() => manager.getTrace("missing", 0, 0)).toThrow(
      'session "missing" not found (alive or within trace TTL)',
    );
  });

  it("closes all sessions", () => {
    const manager = new SessionManager();
    const conn = new FakeConn();
    manager.newSession("s1", "srv", conn, 0);
    manager.closeAll();
    expect(conn.closed).toBe(true);
    expect(manager.stat()).toEqual([]);
  });
});
```

- [x] **Step 3: 运行确认失败**

Run: `npm test -- tests/session`
Expected: FAIL，无法解析 `src/session/*.js`。

- [x] **Step 4: 实现 trace / session / manager**

`src/session/trace.ts`：

```ts
export const GRAVE_TTL_MS = 10 * 60_000;

export interface CommandTrace {
  time: string;
  cmd: string;
  output: string;
  raw_output: string;
  exit_code: number;
  timed_out: boolean;
  ctrl_c_sent: boolean;
}

/** 复制并按 last_n / trunc_output 裁剪；不修改输入。 */
export function truncateTraces(
  traces: readonly CommandTrace[],
  lastN: number,
  truncOutput: number,
): CommandTrace[] {
  if (traces.length === 0) return [];
  const src = lastN > 0 && traces.length > lastN ? traces.slice(-lastN) : traces;
  return src.map((trace) => ({
    ...trace,
    output: truncOutput > 0 ? trace.output.slice(0, truncOutput) : trace.output,
    raw_output: truncOutput > 0
      ? trace.raw_output.slice(0, truncOutput)
      : trace.raw_output,
  }));
}
```

`src/session/session.ts`：

```ts
import { goTimestamp } from "../util/time.js";
import { isConnLost, PtyUnusableError } from "../ssh/errors.js";
import type { LoginTraceEntry, RawReadResult, RunOutcome } from "../ssh/types.js";
import { nullLogger, type Logger } from "../log.js";
import { truncateTraces, type CommandTrace } from "./trace.js";

export type SessionState = "idle" | "running" | "closed";

export interface SessionStat {
  sid: string;
  name: string;
  state: SessionState;
  mode: "raw" | "shell";
  sftp_available: boolean;
  last_activity: string;
  commands_run: number;
  uptime_s: number;
  tags?: string[];
}

export interface SessionConn {
  readonly mode: "shell" | "raw";
  run(cmd: string, timeoutMs: number, maxOutputBytes: number): Promise<RunOutcome>;
  sendRaw(data: Buffer): Promise<void>;
  readRaw(waitMs: number, maxBytes: number): Promise<RawReadResult>;
  close(): void;
}

export interface SessionRunResult {
  output: string;
  exit_code: number;
  timed_out: boolean;
  truncated: boolean;
  total_bytes: number;
}

export interface SessionRawRead {
  output: string;
  more: boolean;
  idle_ms: number;
}

export interface SessionOptions {
  idleTimeoutMs?: number;
  raw?: boolean;
  sftpAvailable?: boolean;
  tags?: string[];
  loginFlowTrace?: LoginTraceEntry[];
  logger?: Logger;
  now?: () => number;
  onClosed?: (session: Session) => void;
}

export class Session {
  state: SessionState = "idle";
  private readonly createdAt: number;
  private lastActivity: number;
  private lastOutputAt: number;
  private commandsRun = 0;
  private traces: CommandTrace[] = [];
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly idleTimeoutMs: number;
  private readonly rawFlag: boolean;
  private readonly sftpAvail: boolean;
  private readonly tags: string[];
  private readonly loginFlow: LoginTraceEntry[];
  private readonly logger: Logger;
  private readonly now: () => number;

  constructor(
    readonly sid: string,
    readonly serverName: string,
    private readonly conn: SessionConn,
    private readonly options: SessionOptions = {},
  ) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? 0;
    this.rawFlag = options.raw ?? false;
    this.sftpAvail = options.sftpAvailable ?? false;
    this.tags = [...(options.tags ?? [])];
    this.loginFlow = [...(options.loginFlowTrace ?? [])];
    this.logger = options.logger ?? nullLogger;
    this.now = options.now ?? Date.now;
    this.createdAt = this.now();
    this.lastActivity = this.createdAt;
    this.lastOutputAt = this.createdAt;
    this.resetIdleTimer();
  }

  get mode(): "raw" | "shell" {
    return this.rawFlag ? "raw" : "shell";
  }

  get sftpAvailable(): boolean {
    return this.sftpAvail;
  }

  async run(cmd: string, timeoutMs = 0, maxOutputBytes = 0): Promise<SessionRunResult> {
    this.requireIdle();
    if (this.rawFlag) {
      throw new Error("raw device: no unix shell, use send_in_session/read_in_session");
    }
    this.state = "running";
    this.stopIdleTimer();
    const started = this.now();
    try {
      const outcome = await this.conn.run(cmd, timeoutMs, maxOutputBytes);
      this.traces.push({
        time: goTimestamp(new Date(started)),
        cmd,
        output: outcome.output,
        raw_output: outcome.rawOutput,
        exit_code: outcome.exitCode,
        timed_out: outcome.timedOut,
        ctrl_c_sent: outcome.ctrlCSent,
      });
      this.commandsRun += 1;
      this.lastActivity = this.now();
      if (this.state !== "closed") {
        if (outcome.connUnusable) {
          this.logger.warn("conn unusable after run, closing session", {
            sid: this.sid,
            server: this.serverName,
          });
          this.close();
        } else {
          this.state = "idle";
          this.resetIdleTimer();
        }
      }
      return {
        output: outcome.output,
        exit_code: outcome.exitCode,
        timed_out: outcome.timedOut,
        truncated: outcome.truncated,
        total_bytes: outcome.totalBytes,
      };
    } catch (err) {
      this.traces.push({
        time: goTimestamp(new Date(started)),
        cmd,
        output: "",
        raw_output: "",
        exit_code: 0,
        timed_out: false,
        ctrl_c_sent: false,
      });
      this.commandsRun += 1;
      this.lastActivity = this.now();
      if (this.state !== "closed") {
        if (isConnLost(err) || err instanceof PtyUnusableError) this.close();
        else {
          this.state = "idle";
          this.resetIdleTimer();
        }
      }
      throw err;
    }
  }

  async sendInSession(input: string): Promise<number> {
    this.requireIdle();
    this.state = "running";
    this.stopIdleTimer();
    let error: Error | undefined;
    try {
      await this.conn.sendRaw(Buffer.from(input, "utf8"));
    } catch (err) {
      error = err instanceof Error ? err : new Error(String(err));
    }
    this.commandsRun += 1;
    this.lastActivity = this.now();
    this.traces.push({
      time: goTimestamp(new Date(this.now())),
      cmd: input,
      output: "",
      raw_output: "",
      exit_code: 0,
      timed_out: false,
      ctrl_c_sent: false,
    });
    if (error) this.close();
    else if (this.state !== "closed") {
      this.state = "idle";
      this.resetIdleTimer();
    }
    if (error) throw error;
    return Buffer.byteLength(input);
  }

  async readInSession(waitMs: number, maxBytes: number): Promise<SessionRawRead> {
    this.requireIdle();
    this.state = "running";
    this.stopIdleTimer();
    try {
      const result = await this.conn.readRaw(waitMs, maxBytes);
      const now = this.now();
      let idleMs = now - this.lastOutputAt;
      if (result.output.length > 0) {
        this.lastOutputAt = now;
        idleMs = 0;
        const last = this.traces[this.traces.length - 1];
        if (last) last.output += result.output;
        else {
          this.traces.push({
            time: goTimestamp(new Date(now)),
            cmd: "(read)",
            output: result.output,
            raw_output: result.output,
            exit_code: 0,
            timed_out: false,
            ctrl_c_sent: false,
          });
        }
      }
      this.lastActivity = now;
      if (this.state !== "closed") {
        this.state = "idle";
        this.resetIdleTimer();
      }
      return { output: result.output, more: result.more, idle_ms: idleMs };
    } catch (err) {
      this.lastActivity = this.now();
      if (this.state !== "closed" && isConnLost(err)) {
        this.logger.warn("conn lost during read, closing session", {
          sid: this.sid,
          server: this.serverName,
        });
        this.close();
      } else if (this.state !== "closed") {
        this.state = "idle";
        this.resetIdleTimer();
      }
      throw err;
    }
  }

  stat(): SessionStat {
    const out: SessionStat = {
      sid: this.sid,
      name: this.serverName,
      state: this.state,
      mode: this.mode,
      sftp_available: this.sftpAvail,
      last_activity: goTimestamp(new Date(this.lastActivity)),
      commands_run: this.commandsRun,
      uptime_s: Math.floor((this.now() - this.createdAt) / 1000),
    };
    if (this.tags.length > 0) out.tags = [...this.tags];
    return out;
  }

  getTraces(lastN = 0, truncOutput = 0): CommandTrace[] {
    return truncateTraces(this.traces, lastN, truncOutput);
  }

  loginFlowTrace(): LoginTraceEntry[] {
    return [...this.loginFlow];
  }

  close(): void {
    if (this.state === "closed") return;
    this.state = "closed";
    this.stopIdleTimer();
    try {
      this.conn.close();
    } catch (err) {
      this.logger.warn("close session conn", {
        sid: this.sid,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    this.options.onClosed?.(this);
  }

  private requireIdle(): void {
    if (this.state === "closed") throw new Error("session closed");
    if (this.state === "running") throw new Error("session busy");
  }

  private resetIdleTimer(): void {
    this.stopIdleTimer();
    if (this.idleTimeoutMs <= 0 || this.state === "closed") return;
    this.idleTimer = setTimeout(() => {
      if (this.state !== "idle") return;
      this.logger.info("idle timeout fired, closing session", {
        sid: this.sid,
        server: this.serverName,
        idle_timeout: `${this.idleTimeoutMs}ms`,
      });
      this.close();
    }, this.idleTimeoutMs);
    this.idleTimer.unref();
  }

  private stopIdleTimer(): void {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }
}
```

`src/session/manager.ts`：

```ts
import { nullLogger, type Logger } from "../log.js";
import type { SessionConn, SessionOptions, SessionStat } from "./session.js";
import { Session } from "./session.js";
import { GRAVE_TTL_MS, truncateTraces, type CommandTrace } from "./trace.js";

interface GraveEntry {
  traces: CommandTrace[];
  closedAt: number;
}

export interface ManagerOptions {
  now?: () => number;
  logger?: Logger;
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly graveyard = new Map<string, GraveEntry>();
  private readonly now: () => number;
  private readonly logger: Logger;

  constructor(options: ManagerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? nullLogger;
  }

  newSession(
    sid: string,
    serverName: string,
    conn: SessionConn,
    idleTimeoutMs: number,
    options: Omit<SessionOptions, "idleTimeoutMs" | "now" | "logger" | "onClosed"> = {},
  ): Session {
    const session = new Session(sid, serverName, conn, {
      ...options,
      idleTimeoutMs,
      now: this.now,
      logger: this.logger,
      onClosed: (closed) => this.bury(closed),
    });
    this.sessions.set(sid, session);
    return session;
  }

  get(sid: string): Session {
    const session = this.sessions.get(sid);
    if (!session) throw new Error(`session ${JSON.stringify(sid)} not found`);
    return session;
  }

  find(sid: string): Session | undefined {
    return this.sessions.get(sid);
  }

  stat(): SessionStat[] {
    return [...this.sessions.values()]
      .map((session) => session.stat())
      .sort((a, b) => a.sid.localeCompare(b.sid));
  }

  getTrace(sid: string, lastN: number, truncOutput: number): CommandTrace[] {
    const alive = this.sessions.get(sid);
    if (alive) return alive.getTraces(lastN, truncOutput);
    this.cleanupGraveyard();
    const entry = this.graveyard.get(sid);
    if (!entry) {
      throw new Error(`session ${JSON.stringify(sid)} not found (alive or within trace TTL)`);
    }
    return truncateTraces(entry.traces, lastN, truncOutput);
  }

  closeAll(): void {
    for (const session of [...this.sessions.values()]) session.close();
  }

  private bury(session: Session): void {
    this.sessions.delete(session.sid);
    this.graveyard.set(session.sid, {
      traces: session.getTraces(0, 0),
      closedAt: this.now(),
    });
  }

  private cleanupGraveyard(): void {
    const now = this.now();
    for (const [sid, entry] of this.graveyard) {
      if (now - entry.closedAt > GRAVE_TTL_MS) this.graveyard.delete(sid);
    }
  }
}
```

- [x] **Step 5: 运行测试**

Run: `npm test -- tests/session`
Expected: PASS（session 10 + manager 5 个用例）。

- [x] **Step 6: 类型检查并提交**

Run: `npm run typecheck`

```bash
git add src/session tests/session
git commit -m "feat: add session state machine, traces, graveyard, and idle timeout"
```

---

### Task 7: 直连登录、Service 扩展与 7 个 MCP 工具

**Files:**
- Create: `src/ssh/login.ts`, `src/mcp/tools_session.ts`, `src/mcp/tools_raw.ts`
- Modify: `src/mcp/service.ts`（manager / known_hosts / logger）
- Modify: `src/mcp/server.ts`（注册 16 个工具，扩展 instructions）
- Modify: `tests/mcp/tools_config.test.ts`（9 → 16 工具）
- Test: `tests/mcp/session_tools.test.ts`

- [x] **Step 1: 扩展 Service**

`src/mcp/service.ts` 改为：

```ts
import path from "node:path";
import type { Store } from "../config/store.js";
import { nullLogger, type Logger } from "../log.js";
import { SessionManager } from "../session/manager.js";
import { KnownHostsStore } from "../ssh/known_hosts.js";

export interface ServiceOptions {
  manager?: SessionManager;
  knownHosts?: KnownHostsStore;
  logger?: Logger;
}

export class Service {
  private tail: Promise<unknown> = Promise.resolve();
  readonly manager: SessionManager;
  readonly knownHosts: KnownHostsStore;
  readonly logger: Logger;

  constructor(readonly store: Store, options: ServiceOptions = {}) {
    this.logger = options.logger ?? nullLogger;
    this.manager = options.manager ?? new SessionManager({ logger: this.logger });
    this.knownHosts = options.knownHosts
      ?? new KnownHostsStore(path.join(path.dirname(store.path), "known_hosts"));
  }

  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
```

- [x] **Step 2: 写直连登录装配**

`src/ssh/login.ts`：

```ts
import ssh2 from "ssh2";
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
```

- [x] **Step 3: 写 session / raw 工具 handler**

`src/mcp/tools_session.ts`：

```ts
import type { SSHServer } from "../config/types.js";
import { setupDirect } from "../ssh/login.js";
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
  let server: SSHServer | undefined;
  try {
    const cfg = await svc.store.load();
    server = cfg.servers.find((item) => item.name === args.name);
    if (!server) return errorResult(`ssh server ${JSON.stringify(args.name)} not found`);
    if (server.via) return errorResult("via jumphosts not implemented yet (M3)");
    if (server.login_flow && Object.keys(server.login_flow).length > 0) {
      return errorResult("login_flow not implemented yet (M3)");
    }
    let proxy;
    if (server.proxy) {
      proxy = cfg.proxies.find((item) => item.name === server!.proxy);
      if (!proxy) return errorResult(`proxy ${JSON.stringify(server.proxy)} not found`);
    }

    const sid = randomSID();
    const setup = await setupDirect({
      server,
      proxy,
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
```

`src/mcp/tools_raw.ts`：

```ts
import type { Service } from "./service.js";
import { errorResult, textResult } from "./result.js";

const DEFAULT_READ_WAIT_MS = 5_000;
const MAX_READ_WAIT_MS = 60_000;
const DEFAULT_READ_MAX_BYTES = 128 * 1024;
const MAX_READ_MAX_BYTES = 1 << 20;
const MAX_SEND_INPUT_BYTES = 64 * 1024;

/** 解释 C 风格转义；未知转义保留反斜杠与后续字符。 */
export function expandSendInput(input: string): string {
  if (!input.includes("\\")) return input;
  let out = "";
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]!;
    if (char !== "\\") {
      out += char;
      continue;
    }
    const next = input[i + 1];
    if (next === undefined) {
      out += char;
      break;
    }
    switch (next) {
      case "r": out += "\r"; i += 1; break;
      case "n": out += "\n"; i += 1; break;
      case "t": out += "\t"; i += 1; break;
      case "e": out += "\x1b"; i += 1; break;
      case "\\": out += "\\"; i += 1; break;
      case "u": {
        const hex = input.slice(i + 2, i + 6);
        if (hex.length === 4 && /^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(Number.parseInt(hex, 16));
          i += 6;
        } else {
          out += "\\";
        }
        break;
      }
      default:
        out += "\\";
        break;
    }
  }
  return out;
}

export async function sendInSessionTool(
  svc: Service,
  args: { sid: string; input: string },
) {
  if (Buffer.byteLength(args.input) > MAX_SEND_INPUT_BYTES) {
    return errorResult(
      `input too large: ${Buffer.byteLength(args.input)} bytes (max ${MAX_SEND_INPUT_BYTES})`,
    );
  }
  try {
    const session = svc.manager.get(args.sid);
    const sent = await session.sendInSession(expandSendInput(args.input));
    return textResult({ sid: args.sid, sent_bytes: sent });
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}

export async function readInSessionTool(
  svc: Service,
  args: { sid: string; wait_ms?: number; max_bytes?: number },
) {
  let waitMs = args.wait_ms ?? 0;
  if (waitMs <= 0) waitMs = DEFAULT_READ_WAIT_MS;
  if (waitMs > MAX_READ_WAIT_MS) waitMs = MAX_READ_WAIT_MS;
  let maxBytes = args.max_bytes ?? 0;
  if (maxBytes <= 0) maxBytes = DEFAULT_READ_MAX_BYTES;
  if (maxBytes > MAX_READ_MAX_BYTES) maxBytes = MAX_READ_MAX_BYTES;
  try {
    const session = svc.manager.get(args.sid);
    return textResult(await session.readInSession(waitMs, maxBytes));
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}
```

> `String.fromCharCode` 对 `\uXXXX` 与 Go 的 `WriteRune` 在 BMP 范围内一致；M2 只承诺 4 位 hex（BMP）。

- [x] **Step 4: 注册 7 个工具并扩展 instructions**

`src/mcp/server.ts`：

在 import 区加入：

```ts
import {
  closeSessionTool,
  getTraceTool,
  loginTool,
  runInSessionTool,
  statTool,
} from "./tools_session.js";
import { readInSessionTool, sendInSessionTool } from "./tools_raw.js";
```

将 `instructions` 替换为：

```ts
const instructions = `SSH session manager: servers, jumphosts, proxies, sessions.

Entity model:
- SSHServer: name, addr (host:port), user, auth, login_flow?, via?, proxy?, tags, host_key_verify? (default true; set false to skip known_hosts TOFU).
- Jumphost: ssh_j=true -> transparent (ssh -J); ssh_j=false -> interactive bastion (login_flow required).
- Proxy: transport HTTP/SOCKS5.
Relationships: SSHServer.via -> Jumphost.name; *.proxy -> Proxy.name.
Query tools: space-separated keywords, AND semantics on name/addr/tags.
Update tools: RFC 7396 JSON Merge Patch; null deletes, object merges or creates.

Workflow:
1. list_ssh_servers -> resolve the server name.
2. login(name) -> {sid, server_name, sftp_available, mode, tags}.
3. run_in_session(sid, cmd) -> {output, exit_code, timed_out, truncated, total_bytes}.
4. close_session(sid), or rely on idle timeout (default 5min via idle_timeout_s).

Sessions:
- Each session is an independent PTY; cwd/env/background jobs persist across run_in_session calls.
- States: idle / running / closed. run_in_session requires idle; use stat.
- mode: 'raw' = no unix shell (network switches etc.) — run_in_session is REJECTED; use send_in_session/read_in_session. mode: 'shell' = prefer run_in_session; raw primitives remain available for interactive programs.
- send_in_session interprets C-style escapes: \\r = Enter, \\n, \\t, \\e = ESC, \\uXXXX, \\\\ = literal backslash.
- read_in_session absorbs output while bytes keep arriving (<400ms gaps); use wait_ms 3-10s, do not poll with small values.
- run_in_session timeout -> auto Ctrl-C + 3s drain. If drain fails, session is closed; re-login.
- After close, command traces remain queryable via get_trace for 10 minutes.`;
```

在 `registerTool("update_proxy", ...)` 之后、`return server;` 之前追加：

```ts
  server.registerTool("login", {
    description: "Establish an interactive SSH session to a server. Use list_ssh_servers first to resolve the name. Returns {sid, server_name, sftp_available, mode, tags}. mode: 'shell' = unix shell (use run_in_session); 'raw' = no unix shell, e.g. network switch (run_in_session is rejected; use send_in_session/read_in_session). tags mirror the server's configured tags. M2 supports direct connections only; via/login_flow return an explicit M3 error.",
    inputSchema: {
      name: z.string().describe(
        "SSH server name; supports name/addr/tag substring match (use list_ssh_servers to find)",
      ),
    },
  }, (args) => loginTool(svc, args));

  server.registerTool("run_in_session", {
    description: "Run a single command in an existing session. Session must be idle (use stat to check). Returns {output, exit_code, timed_out, truncated, total_bytes}. On timeout: auto Ctrl-C + 3s drain; if drain fails (vim/REPL/pipe block) session is closed and must re-login. If output insufficient, call get_trace(sid, last_n, trunc_output=0) for raw PTY bytes. If truncated=true, use tail/head/grep or redirect to file. One command per call; combine multiple commands with `&&` or `;`. Multi-line single-command constructs (for-loop, heredoc, if-block, line continuation `\\`) work fine.",
    inputSchema: {
      sid: z.string(),
      cmd: z.string(),
      timeout_ms: z.number().int().optional().describe(
        "optional, default 30000 (30s). On timeout: auto Ctrl-C + 3s drain, partial output returned",
      ),
      max_output_bytes: z.number().int().optional().describe(
        "optional, 0 = no truncation. If exceeded: output truncated, truncated=true returned",
      ),
    },
  }, (args) => runInSessionTool(svc, args));

  server.registerTool("close_session", {
    description: "Close an SSH session. Forced: closes even if a command is running. Trace retained 10min for get_trace diagnosis. After this, sid is invalid for run_in_session.",
    inputSchema: { sid: z.string() },
  }, (args) => closeSessionTool(svc, args));

  server.registerTool("stat", {
    description: "List all active sessions with state (idle/running/closed), last activity, command count, uptime, sftp_available, mode (raw/shell), tags. Use before run_in_session to avoid 'session busy' error.",
    inputSchema: {},
  }, () => statTool(svc));

  server.registerTool("get_trace", {
    description: "Retrieve command trace for a session (alive or closed within last 10min). Returns {commands:[{time, cmd, output, raw_output, exit_code, timed_out, ctrl_c_sent}], login_flow}. raw_output contains uncleaned PTY bytes (ANSI/sentinel/\\r\\n) for debugging sentinel mismatch or interactive prompt issues. Use last_n to limit count (0=all), trunc_output to cap each Output/raw_output length (default 200, 0=no truncation for full raw bytes).",
    inputSchema: {
      sid: z.string(),
      last_n: z.number().int().optional().describe(
        'optional, return only the last N traces; 0 = all (default)',
      ),
      trunc_output: z.number().int().optional().describe(
        "optional, truncate each Output and raw_output to this many chars; default 200, 0 = no truncation (full raw PTY bytes for debugging)",
      ),
    },
  }, (args) => getTraceTool(svc, args));

  server.registerTool("send_in_session", {
    description: "Send input to a session's PTY (like typing in a terminal). The server interprets C-style escapes in input: \\r = Enter, \\n, \\t, \\e = ESC, \\uXXXX (e.g. \\u0003 = Ctrl-C), \\\\ = literal backslash; everything else is written as-is. Only works when session is idle (check stat). Works on ALL sessions: raw devices (mode=raw) and unix shells (for interactive programs). Max input 64KB. Returns {sid, sent_bytes}. State persists across calls.",
    inputSchema: {
      sid: z.string(),
      input: z.string().describe(
        "input for the PTY. The server interprets C-style escapes: \\\\r = Enter, \\\\n, \\\\t, \\\\e = ESC, \\\\uXXXX (e.g. \\\\u0003 = Ctrl-C), \\\\\\\\ = literal backslash. Everything else is written as-is. Max 64KB",
      ),
    },
  }, (args) => sendInSessionTool(svc, args));

  server.registerTool("read_in_session", {
    description: "Read new output produced by a session's PTY since the last read (sequential cursor; unread output stays queued, nothing is lost). Absorbs output while bytes keep arriving (<400ms gaps) and returns {output, more, idle_ms}. more=true: queue still has data — call again to drain. idle_ms: ms since the last output byte. Defaults: wait_ms 5000 (max 60000) blocks until first byte; max_bytes 131072 (max 1048576), excess stays queued. Prefer large wait_ms (3-10s); do NOT poll with small values.",
    inputSchema: {
      sid: z.string(),
      wait_ms: z.number().int().optional().describe(
        "optional, default 5000 (max 60000). Blocks until first output byte or timeout; use 1 for non-blocking poll. Do NOT poll with small values",
      ),
      max_bytes: z.number().int().optional().describe(
        "optional, default 131072 (max 1048576). Excess stays queued, more=true",
      ),
    },
  }, (args) => readInSessionTool(svc, args));
```

- [x] **Step 5: 更新工具数量断言**

`tests/mcp/tools_config.test.ts` 中把第一个用例改为：

```ts
  it("registers all 16 tools", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const file = await writeConfig(dir, sample);
      const { client } = await connect(new Store(file));
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name).sort()).toEqual([
        "close_session", "get_jumphost", "get_proxy", "get_ssh_server",
        "get_trace", "list_jumphosts", "list_proxies", "list_ssh_servers",
        "login", "read_in_session", "run_in_session", "send_in_session",
        "stat", "update_jumphost", "update_proxy", "update_ssh_server",
      ]);
    } finally {
      await cleanup();
    }
  });
```

- [x] **Step 6: 写 MCP 端到端 session 测试**

`tests/mcp/session_tools.test.ts`：

```ts
import { existsSync } from "node:fs";
import path from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../../src/config/store.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { Service } from "../../src/mcp/service.js";
import { tempDir, writeConfig } from "../helpers/config.js";
import { FakeSshServer, type FakeSshOptions } from "../helpers/fake_ssh.js";

function textOf(result: unknown): string {
  const r = result as { content?: Array<{ type: string; text?: string }> };
  return r.content?.find((c) => c.type === "text")?.text ?? "";
}

async function connect(store: Store) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(new Service(store));
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return { client, server };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  return {
    isError: !!(result as { isError?: boolean }).isError,
    text: textOf(result),
    json: () => JSON.parse(textOf(result)),
  };
}

async function setupServer(fakeOpts: FakeSshOptions = {}) {
  const fake = await FakeSshServer.start(fakeOpts);
  const temp = await tempDir();
  const file = await writeConfig(temp.dir, {
    version: "1",
    idle_timeout_s: 300,
    jumphosts: [],
    proxies: [],
    servers: [{
      name: "local",
      addr: fake.addr,
      user: "test",
      auth: { password: "secret" },
      raw: fakeOpts.raw,
      tags: ["stage"],
    }],
  });
  const { client } = await connect(new Store(file));
  return { fake, dir: temp.dir, cleanup: temp.cleanup, client };
}

let cleanupFns: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanupFns.reverse()) await fn();
  cleanupFns = [];
});

describe("session MCP tools", () => {
  it("logs in, runs commands, reports stat/trace and closes", async () => {
    const { fake, dir, cleanup, client } = await setupServer();
    cleanupFns.push(cleanup, () => fake.close());

    const login = await call(client, "login", { name: "local" });
    expect(login.isError).toBe(false);
    const session = login.json();
    expect(session.sid).toMatch(/^[0-9a-f]{16}$/);
    expect(session).toMatchObject({
      server_name: "local",
      sftp_available: false,
      mode: "shell",
      tags: ["stage"],
    });
    expect(existsSync(path.join(dir, "known_hosts"))).toBe(true);

    const echo = await call(client, "run_in_session", {
      sid: session.sid,
      cmd: "echo hello",
    });
    expect(echo.json()).toEqual({
      output: "hello",
      exit_code: 0,
      timed_out: false,
      truncated: false,
      total_bytes: 5,
    });

    const failed = await call(client, "run_in_session", {
      sid: session.sid,
      cmd: "false",
    });
    expect(failed.json().exit_code).toBe(1);

    const stat = await call(client, "stat");
    expect(stat.json()).toEqual([
      expect.objectContaining({
        sid: session.sid,
        name: "local",
        state: "idle",
        mode: "shell",
        sftp_available: false,
        commands_run: 2,
        tags: ["stage"],
      }),
    ]);

    const trace = await call(client, "get_trace", { sid: session.sid });
    expect(trace.json().commands).toHaveLength(2);
    expect(trace.json().commands[0]).toMatchObject({
      cmd: "echo hello",
      output: "hello",
      exit_code: 0,
    });
    expect(trace.json().login_flow).toHaveLength(1);

    const closed = await call(client, "close_session", { sid: session.sid });
    expect(closed.json()).toEqual({ sid: session.sid, closed: true });
    const after = await call(client, "run_in_session", {
      sid: session.sid,
      cmd: "true",
    });
    expect(after.isError).toBe(true);
    expect(after.text).toContain("not found");

    const grave = await call(client, "get_trace", { sid: session.sid });
    expect(grave.json().commands).toHaveLength(2);
    expect(grave.json().login_flow).toBeNull();
  });

  it("supports shell raw primitives between run_in_session calls", async () => {
    const { fake, cleanup, client } = await setupServer();
    cleanupFns.push(cleanup, () => fake.close());
    const sid = (await call(client, "login", { name: "local" })).json().sid;

    const sent = await call(client, "send_in_session", {
      sid,
      input: "echo typed\\r",
    });
    expect(sent.json()).toEqual({ sid, sent_bytes: 11 });
    const read = await call(client, "read_in_session", {
      sid,
      wait_ms: 500,
      max_bytes: 4096,
    });
    expect(read.json().output).toContain("typed");
    expect(read.json()).toHaveProperty("more");
    expect(read.json()).toHaveProperty("idle_ms");
  });

  it("logs in to a raw device and serves send/read only", async () => {
    const { fake, cleanup, client } = await setupServer({ raw: true });
    cleanupFns.push(cleanup, () => fake.close());
    const login = await call(client, "login", { name: "local" });
    expect(login.json().mode).toBe("raw");
    const sid = login.json().sid;

    const run = await call(client, "run_in_session", { sid, cmd: "show version" });
    expect(run.isError).toBe(true);
    expect(run.text).toBe(
      "raw device: no unix shell, use send_in_session/read_in_session",
    );

    await call(client, "send_in_session", { sid, input: "show version\\r" });
    const read = await call(client, "read_in_session", { sid, wait_ms: 200 });
    expect(read.json().output).toContain("show version\r");
  });

  it("reports unknown servers and unsupported via/login_flow", async () => {
    const { fake, cleanup, client } = await setupServer();
    cleanupFns.push(cleanup, () => fake.close());
    const missing = await call(client, "login", { name: "nope" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toBe('ssh server "nope" not found');
  });
});
```

- [x] **Step 7: 运行新测试并修复**

Run: `npm test -- tests/mcp`
Expected: PASS（config 6 + session 4 个用例）。

若 ssh2 server 的 `echo` 输出与 prompt 粘在同一 chunk，`cleanOutput` 已处理；若 `send_in_session` 后 read 偶发空输出，把 `wait_ms` 提高到 1000（pty 有 400ms 静默吸收窗口）。

- [x] **Step 8: 类型检查并提交**

Run: `npm run typecheck`

```bash
git add src/ssh/login.ts src/mcp tests/mcp
git commit -m "feat: add direct login and session MCP tools"
```

---

### Task 8: 安全、代理与 sftp 的端到端用例

**Files:**
- Test: `tests/mcp/session_security.test.ts`

- [x] **Step 1: 写端到端测试**

`tests/mcp/session_security.test.ts`：

```ts
import { readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import ssh2 from "ssh2";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../../src/config/store.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { Service } from "../../src/mcp/service.js";
import { tempDir, writeConfig } from "../helpers/config.js";
import { FakeSshServer, type FakeSshOptions } from "../helpers/fake_ssh.js";

const { utils } = ssh2;

function textOf(result: unknown): string {
  const r = result as { content?: Array<{ type: string; text?: string }> };
  return r.content?.find((c) => c.type === "text")?.text ?? "";
}

async function connect(store: Store) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(new Service(store));
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return { client, server };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  return {
    isError: !!(result as { isError?: boolean }).isError,
    text: textOf(result),
    json: () => JSON.parse(textOf(result)),
  };
}

interface AppOptions {
  fake?: FakeSshOptions;
  server?: Record<string, unknown>;
  proxies?: unknown[];
  jumphosts?: unknown[];
}

async function startApp(options: AppOptions = {}) {
  const fake = await FakeSshServer.start(options.fake ?? {});
  const temp = await tempDir();
  const file = await writeConfig(temp.dir, {
    version: "1",
    idle_timeout_s: 300,
    jumphosts: options.jumphosts ?? [],
    proxies: options.proxies ?? [],
    servers: [{
      name: "local",
      addr: fake.addr,
      user: "test",
      auth: { password: "secret" },
      ...options.server,
    }],
  });
  const { client } = await connect(new Store(file));
  return { fake, dir: temp.dir, client, cleanup: temp.cleanup };
}

/** 最小 HTTP CONNECT 代理：读完请求头后连接目标并双向转发。 */
async function startHttpProxy() {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffered = "";
    const onData = (chunk: Buffer) => {
      buffered += chunk.toString("latin1");
      const end = buffered.indexOf("\r\n\r\n");
      if (end < 0) return;
      socket.off("data", onData);
      const target = /^CONNECT (\S+) HTTP\/1\.1/.exec(buffered)?.[1];
      const [host, portText] = target?.split(":") ?? [];
      if (!host || !portText) {
        socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
        return;
      }
      const upstream = net.connect(Number(portText), host, () => {
        socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
        const rest = buffered.slice(end + 4);
        if (rest) upstream.write(rest);
        socket.pipe(upstream).pipe(socket);
      });
      sockets.add(upstream);
      upstream.on("close", () => sockets.delete(upstream));
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
    };
    socket.on("data", onData);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    addr: `127.0.0.1:${port}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

let cleanupFns: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanupFns.reverse()) await fn();
  cleanupFns = [];
});

describe("session security and transport options", () => {
  it("refuses a changed host key and leaves known_hosts untouched", async () => {
    const { fake, dir, client, cleanup } = await startApp();
    cleanupFns.push(cleanup, () => fake.close());
    const knownHosts = path.join(dir, "known_hosts");

    const first = await call(client, "login", { name: "local" });
    expect(first.isError).toBe(false);
    await call(client, "close_session", { sid: first.json().sid });

    const other = utils.generateKeyPairSync("ed25519");
    const parsed = utils.parseKey(other.private);
    if (parsed instanceof Error) throw parsed;
    writeFileSync(
      knownHosts,
      `${fake.addr} ${parsed.getPublicSSH().toString("base64")}\n`,
      { mode: 0o600 },
    );

    const second = await call(client, "login", { name: "local" });
    expect(second.isError).toBe(true);
    expect(second.text).toContain(`host key changed for ${fake.addr}`);
    expect(readFileSync(knownHosts, "utf8")).toContain(fake.addr);
  });

  it("skips known_hosts when host_key_verify is false", async () => {
    const { fake, dir, client, cleanup } = await startApp({
      server: { host_key_verify: false },
    });
    cleanupFns.push(cleanup, () => fake.close());
    const login = await call(client, "login", { name: "local" });
    expect(login.isError).toBe(false);
    expect(() => readFileSync(path.join(dir, "known_hosts"))).toThrow();
  });

  it("logs in through an HTTP CONNECT proxy", async () => {
    const proxy = await startHttpProxy();
    const { fake, client, cleanup } = await startApp({
      server: { proxy: "corp" },
      proxies: [{ name: "corp", type: "HTTP", addr: proxy.addr }],
    });
    cleanupFns.push(cleanup, () => fake.close(), () => proxy.close());
    const login = await call(client, "login", { name: "local" });
    expect(login.isError).toBe(false);
    const sid = login.json().sid;
    const run = await call(client, "run_in_session", { sid, cmd: "echo via-proxy" });
    expect(run.json().output).toBe("via-proxy");
  });

  it("reports sftp availability from the server", async () => {
    const { fake, client, cleanup } = await startApp({ fake: { allowSftp: true } });
    cleanupFns.push(cleanup, () => fake.close());
    const login = await call(client, "login", { name: "local" });
    expect(login.isError).toBe(false);
    expect(login.json().sftp_available).toBe(true);
  });

  it("rejects via and login_flow with explicit M3 errors", async () => {
    const { fake, client, cleanup } = await startApp({
      server: { via: "bastion" },
      jumphosts: [{
        name: "bastion", addr: "127.0.0.1:22", user: "ops",
        auth: { password: "secret" }, ssh_j: true,
      }],
    });
    cleanupFns.push(cleanup, () => fake.close());
    const via = await call(client, "login", { name: "local" });
    expect(via.isError).toBe(true);
    expect(via.text).toBe("via jumphosts not implemented yet (M3)");

    const flowApp = await startApp({
      server: { login_flow: { expect: "Password:", send: "secret\\r" } },
    });
    cleanupFns.push(flowApp.cleanup, () => flowApp.fake.close());
    const flow = await call(flowApp.client, "login", { name: "local" });
    expect(flow.isError).toBe(true);
    expect(flow.text).toBe("login_flow not implemented yet (M3)");
  });
});
```

- [x] **Step 2: 运行测试**

Run: `npm test -- tests/mcp/session_security.test.ts`
Expected: PASS（5 个用例）。

若 `sftp_available` 为 false，检查 `FakeSshServer` 的 `session.on("sftp")` 分支；不要放宽断言，修正假服务器直到 `acceptSftp()` 被调用。

- [x] **Step 3: 提交**

```bash
git add tests/mcp/session_security.test.ts
git commit -m "test: cover TOFU, proxy, sftp and deferred M3 paths end-to-end"
```

---

### Task 9: 文档与完整验收

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-11-17-myssh-m2-connection.md`（勾选完成项）

- [x] **Step 1: 更新 README 状态与工具列表**

把 `## Status` 段替换为：

```markdown
## Status

M2 (SSH connection) is complete for direct connections:

- [x] Project scaffold, build, tests
- [x] Config model, validation, atomic load/save
- [x] `server` / `jumphost` / `proxy` `list|get` CLI
- [x] 9 config CRUD MCP tools
- [x] Direct SSH via password or private key, HTTP/SOCKS5 proxies
- [x] TOFU `known_hosts`, 0600 key checks
- [x] PTY sessions, command sentinel, `run_in_session`
- [x] Session state, traces, `stat` / `get_trace`, raw send/read, sftp probe
- [ ] Jumphosts, Pattern A/B, LoginFlow (M3)
- [ ] sftp file transfer (M4)
- [ ] `install` / `doctor` / Agent injection (M5)
- [ ] npm publish and three-platform CI (M6)

M2 limitations:

- `login` supports direct connections only; `via` and `login_flow` return
  `... not implemented yet (M3)`.
- SFTP availability is probed at login but file transfer tools arrive in M4.
```

把工具列表段替换为：

```markdown
The MCP server is named `sshmng` and exposes 16 tools:

- Config: `list_ssh_servers`, `get_ssh_server`, `update_ssh_server`,
  `list_jumphosts`, `get_jumphost`, `update_jumphost`,
  `list_proxies`, `get_proxy`, `update_proxy`
- Sessions: `login`, `run_in_session`, `close_session`, `stat`,
  `get_trace`, `send_in_session`, `read_in_session`
```

把末尾 Development 段更新为：

```markdown
Design spec: `docs/superpowers/specs/2026-11-17-myssh-ts-rewrite-design.md`.
M1 plan: `docs/superpowers/plans/2026-11-17-myssh-m1-foundation.md`.
M2 plan: `docs/superpowers/plans/2026-11-17-myssh-m2-connection.md`.
```

- [x] **Step 2: 完整验收**

Run: `npm run typecheck`
Expected: 退出码 0，无错误。

Run: `npm test`
Expected: 全部测试通过（0 failed）。

Run: `npm run build`
Expected: `dist/index.js` 生成，退出码 0。

Run: `node dist/index.js version`
Expected: 打印版本号，退出码 0。

- [x] **Step 3: 勾选计划并提交**

把本文件所有已完成的 `- [ ]` 改为 `- [x]`（只勾选实际运行通过的步骤）。

```bash
git add README.md docs/superpowers/plans/2026-11-17-myssh-m2-connection.md
git commit -m "docs: record M2 connection support and limitations"
```

---
