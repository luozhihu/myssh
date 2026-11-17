# myssh M3: Jumphosts, Pattern A/B, LoginFlow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the three sshmng connection forms — direct, transparent jumphost (Pattern A), interactive bastion (Pattern B) — plus the LoginFlow decision-tree executor, with drop-in tool behavior.

**Architecture:** A pure LoginFlow executor drives an abstract PTY (`send` / `read(deadline, matchers)`); `PtyConn` implements that interface over the existing byte queue and preserves trailing bytes in `pushback` across flow segments. Pattern A opens a second SSH handshake over `forwardOut`'s direct-tcpip channel and binds the jumphost client to the PTY's lifetime; Pattern B runs two LoginFlow segments over one bastion PTY before shell detection.

**Tech Stack:** TypeScript 7 strict ESM, ssh2 1.17, vitest 5.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/loginflow/executor.ts` | Decision-tree executor, glob/regex compilation, trace |
| `src/pty/normalize.ts` | adds `stripANSIWithPos` for raw match boundaries |
| `src/pty/pty_conn.ts` | `send`/`read`/`runLoginFlow`, configurable quiet period |
| `src/ssh/dialer.ts` | `dialThrough` via `forwardOut`, shared handshake helper |
| `src/ssh/login.ts` | `setupDirect` / `setupPatternA` / `setupPatternB` / `setupServer` |
| `src/mcp/tools_session.ts` | resolve `via` / proxies, dispatch to setup |
| `tests/helpers/fake_ssh.ts` | tcpip forwarding, bastion menu, banner |
| `tests/loginflow/executor.test.ts` | executor unit tests |
| `tests/pty/pty_loginflow.test.ts` | PTY adapter + pushback tests |
| `tests/ssh/dialer_through.test.ts` | direct-tcpip dial |
| `tests/mcp/session_loginflow.test.ts` | end-to-end M3 scenarios |

---

### Task 1: LoginFlow Executor

**Files:**
- Modify: `src/pty/normalize.ts`
- Create: `src/loginflow/executor.ts`
- Test: `tests/loginflow/executor.test.ts`

- [x] **Step 1: Write the failing tests**

`tests/loginflow/executor.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  compilePattern,
  runLoginFlow,
  type LoginFlowPty,
  type LoginFlowRead,
} from "../../src/loginflow/executor.js";
import type { LoginAction } from "../../src/config/types.js";

class ScriptPty implements LoginFlowPty {
  sent: string[] = [];
  reads: Array<Partial<LoginFlowRead>> = [];
  sendError: Error | null = null;
  readError: Error | null = null;

  send(data: string): void {
    if (this.sendError) throw this.sendError;
    this.sent.push(data);
  }

  async read(): Promise<LoginFlowRead> {
    if (this.readError) throw this.readError;
    const next = this.reads.shift() ?? { timedOut: true };
    return {
      output: next.output ?? "",
      matchedIdx: next.matchedIdx ?? -1,
      timedOut: next.timedOut ?? false,
    };
  }
}

const cwdFlow: Record<string, LoginAction> = {
  start: {
    send: "hello\r",
    expects: [{ pattern: "Password:*", next: "password" }],
  },
  password: {
    send: "secret\r",
    expects: [{ pattern: "Welcome*", next: "success" }],
  },
};

describe("compilePattern", () => {
  it("uses unanchored glob semantics unless re: is used", () => {
    expect(compilePattern("login:*").test("xx login: ")).toBe(true);
    expect(compilePattern("a.b").test("axb")).toBe(false);
    expect(compilePattern("x?y").test("xzy")).toBe(true);
    expect(compilePattern("re:^\\d+$").test("123")).toBe(true);
    expect(() => compilePattern("re:(")).toThrow();
  });
});

describe("runLoginFlow", () => {
  it("walks actions, sends text and records trace entries", async () => {
    const pty = new ScriptPty();
    pty.reads = [
      { output: "Password: ", matchedIdx: 0 },
      { output: "Welcome home", matchedIdx: 0 },
    ];
    const result = await runLoginFlow(pty, cwdFlow, "start", {
      now: () => 1_700_000_000_000,
    });
    expect(result.error).toBeUndefined();
    expect(pty.sent).toEqual(["hello\r", "secret\r"]);
    expect(result.trace).toHaveLength(2);
    expect(result.trace[0]).toMatchObject({
      send: "hello\r",
      expect: "Password:*",
      output: "Password: ",
    });
    expect(result.trace[1]).toMatchObject({
      send: "secret\r",
      expect: "Welcome*",
      output: "Welcome home",
    });
    expect(result.trace[0]!.time).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
  });

  it("fails when no expect matches", async () => {
    const pty = new ScriptPty();
    pty.reads = [{ output: "nope", matchedIdx: -1 }];
    const result = await runLoginFlow(pty, cwdFlow, "start");
    expect(result.error?.message).toBe(
      'loginflow: action "start": no expect matched (output: "nope")',
    );
    expect(result.trace).toHaveLength(1);
  });

  it("fails on timeout with the configured duration", async () => {
    const pty = new ScriptPty();
    pty.reads = [{ timedOut: true }];
    const flow = {
      start: {
        expects: [{ pattern: "x", next: "success" }],
        timeout_ms: 1500,
      },
    };
    const result = await runLoginFlow(pty, flow, "start");
    expect(result.error?.message).toBe('loginflow: action "start" timed out after 1.5s');
  });

  it("fails for missing actions and invalid patterns", async () => {
    const pty = new ScriptPty();
    const missing = await runLoginFlow(pty, cwdFlow, "nope");
    expect(missing.error?.message).toBe('loginflow: action "nope" not found in flow');

    const invalid = await runLoginFlow(
      pty,
      { start: { expects: [{ pattern: "re:(", next: "success" }] } },
      "start",
    );
    expect(invalid.error?.message).toContain('loginflow: action "start": invalid pattern "re:("');
  });

  it("enforces max steps and the global timeout", async () => {
    const pty = new ScriptPty();
    const loop = {
      start: { expects: [{ pattern: "again", next: "start" }] },
    };
    pty.reads = [{ output: "again", matchedIdx: 0 }, { output: "again", matchedIdx: 0 }];
    const steps = await runLoginFlow(pty, loop, "start", { maxSteps: 2 });
    expect(steps.error?.message).toBe("loginflow: max steps (2) exceeded");
    expect(steps.trace).toHaveLength(2);

    let ticks = 0;
    const timed = await runLoginFlow(pty, loop, "start", {
      globalTimeoutMs: 1,
      now: () => {
        ticks += 10;
        return ticks;
      },
    });
    expect(timed.error?.message).toContain("loginflow: global timeout exceeded (1ms)");
  });

  it("wraps send and read errors", async () => {
    const sendPty = new ScriptPty();
    sendPty.sendError = new Error("boom");
    const send = await runLoginFlow(sendPty, cwdFlow, "start");
    expect(send.error?.message).toBe('loginflow: send at "start": boom');

    const readPty = new ScriptPty();
    readPty.readError = new Error("dead");
    const read = await runLoginFlow(readPty, cwdFlow, "start");
    expect(read.error?.message).toBe('loginflow: read at "start": dead');
  });
});
```

- [x] **Step 2: Run tests to confirm they fail**

Run: `npm test -- tests/loginflow`
Expected: FAIL — cannot resolve `src/loginflow/executor.js`.

- [x] **Step 3: Implement `stripANSIWithPos`**

Append to `src/pty/normalize.ts`:

```ts
/** 剥离 ANSI 并给出 stripped 字节 → raw 字节末尾偏移的映射。 */
export function stripANSIWithPos(text: string): { stripped: string; posMap: number[] } {
  const chars: string[] = [];
  const posMap: number[] = [0];
  const re = new RegExp(ANSI_RE.source, "g");
  let lastEnd = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    for (let i = lastEnd; i < match.index; i += 1) {
      chars.push(text[i]!);
      posMap.push(i + 1);
    }
    lastEnd = match.index + match[0].length;
  }
  for (let i = lastEnd; i < text.length; i += 1) {
    chars.push(text[i]!);
    posMap.push(i + 1);
  }
  return { stripped: chars.join(""), posMap };
}
```

- [x] **Step 4: Implement the executor**

Create `src/loginflow/executor.ts`:

```ts
import type { LoginAction } from "../config/types.js";
import { nullLogger, type Logger } from "../log.js";
import type { LoginTraceEntry } from "../ssh/types.js";
import { traceTimestamp } from "../util/time.js";

export interface LoginFlowRead {
  output: string;
  matchedIdx: number;
  timedOut: boolean;
}

export interface LoginFlowPty {
  send(data: string): void;
  read(deadline: number, matchers: RegExp[]): Promise<LoginFlowRead>;
}

export interface LoginFlowOptions {
  maxSteps?: number;
  globalTimeoutMs?: number;
  defaultTimeoutMs?: number;
  logger?: Logger;
  now?: () => number;
}

export interface LoginFlowResult {
  trace: LoginTraceEntry[];
  error?: Error;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_STEPS = 50;
const DEFAULT_GLOBAL_TIMEOUT_MS = 60_000;
const SUCCESS = "success";

/** "re:" 前缀直接编译；否则 glob → 未锚定正则（contains 语义）。 */
export function compilePattern(pattern: string): RegExp {
  if (pattern.startsWith("re:")) return new RegExp(pattern.slice(3));
  return globToRegex(pattern);
}

/** 支持 *、?、[...]；其余正则元字符按字面量转义。 */
export function globToRegex(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]!;
    if (char === "*") out += ".*";
    else if (char === "?") out += ".";
    else if (".+()|{}^$\\".includes(char)) out += `\\${char}`;
    else if (char === "[") {
      out += "[";
      while (i + 1 < pattern.length && pattern[i + 1] !== "]") {
        i += 1;
        out += pattern[i]!;
      }
      if (i + 1 < pattern.length) {
        i += 1;
        out += "]";
      }
    } else out += char;
  }
  return new RegExp(out);
}

function truncateForMsg(text: string, maxLen: number): string {
  return text.length <= maxLen ? text : `${text.slice(0, maxLen)}...`;
}

function goDuration(ms: number): string {
  if (ms === 0) return "0s";
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (Number.isInteger(seconds)) return `${seconds}s`;
  return `${seconds}s`;
}

/** 在 PTY 上执行 LoginFlow 决策树；失败时返回截至失败点的 trace。 */
export async function runLoginFlow(
  pty: LoginFlowPty,
  flow: Record<string, LoginAction>,
  entry: string,
  options: LoginFlowOptions = {},
): Promise<LoginFlowResult> {
  const logger = options.logger ?? nullLogger;
  const now = options.now ?? Date.now;
  const maxSteps = options.maxSteps && options.maxSteps > 0
    ? options.maxSteps
    : DEFAULT_MAX_STEPS;
  const globalTimeoutMs = options.globalTimeoutMs && options.globalTimeoutMs > 0
    ? options.globalTimeoutMs
    : DEFAULT_GLOBAL_TIMEOUT_MS;
  const defaultTimeoutMs = options.defaultTimeoutMs && options.defaultTimeoutMs > 0
    ? options.defaultTimeoutMs
    : DEFAULT_TIMEOUT_MS;

  const globalDeadline = now() + globalTimeoutMs;
  const trace: LoginTraceEntry[] = [];
  let currentName = entry;

  for (let step = 0; step < maxSteps; step += 1) {
    if (now() > globalDeadline) {
      const message =
        `loginflow: global timeout exceeded (${goDuration(globalTimeoutMs)}) ` +
        `at step ${step} (${JSON.stringify(currentName)})`;
      logger.warn("loginflow failed", { step, action: currentName, err: message });
      return { trace, error: new Error(message) };
    }

    const action = flow[currentName];
    if (!action) {
      const message = `loginflow: action ${JSON.stringify(currentName)} not found in flow`;
      logger.warn("loginflow failed", { step, action: currentName, err: message });
      return { trace, error: new Error(message) };
    }

    logger.debug("loginflow step", { step, action: currentName, send: action.send ?? "" });
    const stepStart = now();
    if (action.send) {
      try {
        pty.send(action.send);
      } catch (err) {
        const message = `loginflow: send at ${JSON.stringify(currentName)}: ${
          err instanceof Error ? err.message : String(err)
        }`;
        logger.warn("loginflow failed", { step, action: currentName, err: message });
        return { trace, error: new Error(message) };
      }
    }

    const matchers: RegExp[] = [];
    for (const expect of action.expects) {
      try {
        matchers.push(compilePattern(expect.pattern));
      } catch (err) {
        const message =
          `loginflow: action ${JSON.stringify(currentName)}: invalid pattern ` +
          `${JSON.stringify(expect.pattern)}: ${
            err instanceof Error ? err.message : String(err)
          }`;
        logger.warn("loginflow failed", { step, action: currentName, err: message });
        return { trace, error: new Error(message) };
      }
    }

    const timeoutMs = action.timeout_ms && action.timeout_ms > 0
      ? action.timeout_ms
      : defaultTimeoutMs;
    const deadline = Math.min(stepStart + timeoutMs, globalDeadline);

    let read: LoginFlowRead;
    try {
      read = await pty.read(deadline, matchers);
    } catch (err) {
      const message = `loginflow: read at ${JSON.stringify(currentName)}: ${
        err instanceof Error ? err.message : String(err)
      }`;
      logger.warn("loginflow failed", { step, action: currentName, err: message });
      return { trace, error: new Error(message) };
    }

    const matched = read.matchedIdx >= 0 ? action.expects[read.matchedIdx] : undefined;
    trace.push({
      time: traceTimestamp(new Date(stepStart)),
      elapsed_ms: now() - stepStart,
      send: action.send ?? "",
      expect: matched?.pattern ?? "",
      output: read.output,
    });
    logger.debug("loginflow read", {
      step,
      action: currentName,
      matched_idx: read.matchedIdx,
      timed_out: read.timedOut,
      next: matched?.next ?? "",
      output: read.output,
    });

    if (read.timedOut) {
      const message = `loginflow: action ${JSON.stringify(currentName)} timed out after ${goDuration(timeoutMs)}`;
      logger.warn("loginflow failed", { step, action: currentName, err: message });
      return { trace, error: new Error(message) };
    }
    if (!matched) {
      const message =
        `loginflow: action ${JSON.stringify(currentName)}: no expect matched ` +
        `(output: ${JSON.stringify(truncateForMsg(read.output, 200))})`;
      logger.warn("loginflow failed", { step, action: currentName, err: message });
      return { trace, error: new Error(message) };
    }
    if (matched.next === SUCCESS) {
      logger.debug("loginflow success", { step, action: currentName, total_steps: step + 1 });
      return { trace };
    }
    currentName = matched.next;
  }

  const message = `loginflow: max steps (${maxSteps}) exceeded`;
  logger.warn("loginflow failed", { step: maxSteps, action: currentName, err: message });
  return { trace, error: new Error(message) };
}
```

- [x] **Step 5: Run tests**

Run: `npm test -- tests/loginflow`
Expected: PASS (8 tests).

- [x] **Step 6: Commit**

```bash
git add src/loginflow src/pty/normalize.ts tests/loginflow
git commit -m "feat: add LoginFlow decision-tree executor"
```

---

### Task 2: PtyConn LoginFlow Adapter

**Files:**
- Modify: `src/pty/pty_conn.ts`
- Test: `tests/pty/pty_loginflow.test.ts`

- [x] **Step 1: Write the failing tests**

`tests/pty/pty_loginflow.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { PtyConn } from "../../src/pty/pty_conn.js";
import type { PtyTransport } from "../../src/pty/transport.js";

class ManualTransport implements PtyTransport {
  readonly written: string[] = [];
  private readonly dataHandlers = new Set<(data: Buffer) => void>();
  private readonly closeHandlers = new Set<(err?: Error) => void>();
  onWrite: ((data: string) => void) | null = null;
  sftp = false;

  write(data: Buffer | string): void {
    const text = Buffer.isBuffer(data) ? data.toString("latin1") : data;
    this.written.push(text);
    this.onWrite?.(text);
  }
  emit(text: string): void {
    for (const handler of this.dataHandlers) handler(Buffer.from(text, "latin1"));
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
    return Promise.resolve(this.sftp);
  }
  close(): void {
    for (const handler of this.closeHandlers) handler();
  }
}

function make(quietMs = 20) {
  const transport = new ManualTransport();
  const conn = new PtyConn(transport, "ab12", { loginFlowQuietMs: quietMs });
  return { transport, conn };
}

describe("PtyConn LoginFlow adapter", () => {
  it("sends raw login input", () => {
    const { transport, conn } = make();
    conn.send("user\r");
    expect(transport.written).toEqual(["user\r"]);
  });

  it("matches ANSI-wrapped prompts and keeps trailing bytes", async () => {
    const { transport, conn } = make();
    transport.emit("xx\x1b[31mPassword:\x1b[0m user> ");
    const first = await conn.read(Date.now() + 500, [/Password:/]);
    expect(first.matchedIdx).toBe(0);
    expect(first.timedOut).toBe(false);
    expect(first.output).toBe("xx\x1b[31mPassword:");

    const second = await conn.read(Date.now() + 500, [/user> /]);
    expect(second.matchedIdx).toBe(0);
    expect(second.output).toBe("\x1b[0m user> ");
  });

  it("returns after the quiet period when no matcher is given", async () => {
    const { transport, conn } = make(10);
    transport.emit("menu");
    const result = await conn.read(Date.now() + 1000, []);
    expect(result.timedOut).toBe(false);
    expect(result.matchedIdx).toBe(-1);
    expect(result.output).toBe("menu");
  });

  it("times out without data and reports closed connections", async () => {
    const { transport, conn } = make();
    const timed = await conn.read(Date.now() + 20, [/x/]);
    expect(timed.timedOut).toBe(true);
    expect(timed.output).toBe("");

    transport.close();
    await expect(conn.read(Date.now() + 20, [/x/])).rejects.toThrow("connection closed");
  });

  it("preserves trailing data across two LoginFlow segments", async () => {
    const { transport, conn } = make();
    transport.emit("Welcome select target: login: ");
    const jump = await conn.runLoginFlow(
      { entry: { expects: [{ pattern: "select target:", next: "success" }] } },
      "entry",
    );
    expect(jump.error).toBeUndefined();
    expect(jump.trace).toHaveLength(1);
    expect(jump.trace[0]!.output).toBe("Welcome select target:");

    const target = await conn.runLoginFlow(
      { entry: { expects: [{ pattern: "login:", next: "success" }] } },
      "entry",
    );
    expect(target.error).toBeUndefined();
    expect(target.trace[0]!.output).toBe(" login:");
  });

  it("runs an empty flow as a no-op", async () => {
    const { conn } = make();
    const result = await conn.runLoginFlow({}, "entry");
    expect(result).toEqual({ trace: [] });
  });
});
```

- [x] **Step 2: Run tests to confirm they fail**

Run: `npm test -- tests/pty/pty_loginflow.test.ts`
Expected: FAIL — `loginFlowQuietMs` not in options; `send`/`read`/`runLoginFlow` missing.

- [x] **Step 3: Implement the adapter**

In `src/pty/pty_conn.ts`:

1. Add imports:

```ts
import type { LoginAction } from "../config/types.js";
import { runLoginFlow, type LoginFlowRead, type LoginFlowPty } from "../loginflow/executor.js";
import { cleanOutput, stripANSIWithPos } from "./normalize.js";
```

2. Add constant and option:

```ts
const LOGIN_FLOW_QUIET_MS = 200;
```

```ts
export interface PtyConnOptions {
  cmdTimeoutMs?: number;
  setTokenTimeoutMs?: number;
  ctrlCDrainTimeoutMs?: number;
  shellDetectTimeoutMs?: number;
  rcInjectTimeoutMs?: number;
  rawQuietGapMs?: number;
  loginFlowQuietMs?: number;
  logger?: Logger;
}
```

3. Declare the class implements the interface:

```ts
export class PtyConn implements LoginFlowPty {
```

4. Add methods after `markRaw()`:

```ts
  /** LoginFlow 阶段：向 PTY 写入任意文本。 */
  send(data: string): void {
    this.requireOpen();
    this.logger.debug("loginflow send", {
      bytes: Buffer.byteLength(data),
      text: data,
    });
    this.transport.write(data);
  }

  /**
   * LoginFlow 阶段读取：累积输出并用 matchers（ANSI 过滤后）匹配。
   * 命中返回截至 match 末尾的原始字节，trailing 存入 pushback 供下一段使用。
   * matchers 为空时按静默期 heuristic 返回。
   */
  async read(deadline: number, matchers: RegExp[]): Promise<LoginFlowRead> {
    this.requireOpen();
    let buf = this.pushback;
    this.pushback = Buffer.alloc(0);

    const initial = this.matchRaw(buf, matchers);
    if (initial) {
      this.pushback = buf.subarray(initial.end);
      return {
        output: buf.subarray(0, initial.end).toString("latin1"),
        matchedIdx: initial.idx,
        timedOut: false,
      };
    }

    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return { output: buf.toString("latin1"), matchedIdx: -1, timedOut: true };
      }
      if (this.queue.size > 0) {
        buf = Buffer.concat([buf, this.queue.drain()]);
        const found = this.matchRaw(buf, matchers);
        if (found) {
          this.pushback = buf.subarray(found.end);
          return {
            output: buf.subarray(0, found.end).toString("latin1"),
            matchedIdx: found.idx,
            timedOut: false,
          };
        }
        continue;
      }
      if (this.queue.closed) {
        return { output: buf.toString("latin1"), matchedIdx: -1, timedOut: true };
      }
      const quiet = this.options.loginFlowQuietMs ?? LOGIN_FLOW_QUIET_MS;
      await this.queue.wait(
        matchers.length === 0 ? Math.min(remaining, quiet) : remaining,
      );
      if (this.queue.size === 0 && matchers.length === 0 && !this.queue.closed) {
        return { output: buf.toString("latin1"), matchedIdx: -1, timedOut: false };
      }
    }
  }

  async runLoginFlow(
    flow: Record<string, LoginAction>,
    entry: string,
    options: { maxSteps?: number; globalTimeoutMs?: number } = {},
  ) {
    if (Object.keys(flow).length === 0) return { trace: [] };
    return runLoginFlow(this, flow, entry, {
      maxSteps: options.maxSteps,
      globalTimeoutMs: options.globalTimeoutMs,
      logger: this.logger,
    });
  }

  private matchRaw(
    buf: Buffer,
    matchers: RegExp[],
  ): { idx: number; end: number } | null {
    if (matchers.length === 0) return null;
    const { stripped, posMap } = stripANSIWithPos(buf.toString("latin1"));
    for (let idx = 0; idx < matchers.length; idx += 1) {
      const match = matchers[idx]!.exec(stripped);
      if (match) {
        const end = posMap[match.index + match[0].length] ?? buf.length;
        return { idx, end };
      }
    }
    return null;
  }
```

`cleanOutput` is already imported; keep a single import line.

- [x] **Step 4: Run tests**

Run: `npm test -- tests/pty/pty_loginflow.test.ts`
Expected: PASS (6 tests).

Run: `npm test -- tests/pty`
Expected: existing PTY tests still pass.

- [x] **Step 5: Commit**

```bash
git add src/pty/pty_conn.ts tests/pty/pty_loginflow.test.ts
git commit -m "feat: expose LoginFlow send/read on PtyConn with pushback semantics"
```

---

### Task 3: direct-tcpip Dial and Fake Forwarding

**Files:**
- Modify: `src/ssh/dialer.ts`
- Modify: `tests/helpers/fake_ssh.ts`
- Test: `tests/ssh/dialer_through.test.ts`

- [x] **Step 1: Write the failing tests**

`tests/ssh/dialer_through.test.ts`:

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Client } from "ssh2";
import { Dialer } from "../../src/ssh/dialer.js";
import { KnownHostsStore } from "../../src/ssh/known_hosts.js";
import { FakeSshServer } from "../helpers/fake_ssh.js";

const cleanupFns: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanupFns.reverse()) await fn();
  cleanupFns.length = 0;
});

async function setup(forwarding = true) {
  const dir = await mkdtemp(path.join(tmpdir(), "myssh-through-"));
  const target = await FakeSshServer.start();
  const jump = await FakeSshServer.start({ forwarding });
  cleanupFns.push(
    async () => rm(dir, { recursive: true, force: true }),
    () => target.close(),
    () => jump.close(),
  );
  const dialer = new Dialer(new KnownHostsStore(path.join(dir, "known_hosts")));
  const jumpClient = await dialer.dial({
    addr: jump.addr,
    user: "test",
    auth: { password: "secret" },
    hostKeyVerify: true,
  });
  return { dialer, jumpClient, target, jump };
}

async function shellEcho(client: Client): Promise<string> {
  return new Promise((resolve, reject) => {
    client.shell({ term: "xterm", rows: 24, cols: 80 }, {}, (err, stream) => {
      if (err) {
        reject(err);
        return;
      }
      let out = "";
      const timer = setTimeout(() => resolve(out), 1000);
      stream.on("data", (data: Buffer) => {
        out += data.toString("latin1");
        if (out.includes("through")) {
          clearTimeout(timer);
          resolve(out);
        }
      });
      stream.write("echo through\r");
    });
  });
}

describe("Dialer.dialThrough", () => {
  it("opens an SSH connection through a direct-tcpip channel", async () => {
    const { dialer, jumpClient, target } = await setup();
    const targetClient = await dialer.dialThrough(jumpClient, {
      addr: target.addr,
      user: "test",
      auth: { password: "secret" },
      hostKeyVerify: true,
    });
    expect(await shellEcho(targetClient)).toContain("through");
    targetClient.end();
    jumpClient.end();
  });

  it("reports forwardOpen rejection and unreachable targets", async () => {
    const { dialer, jumpClient, target } = await setup(false);
    await expect(
      dialer.dialThrough(jumpClient, {
        addr: target.addr,
        user: "test",
        auth: { password: "secret" },
        hostKeyVerify: true,
      }),
    ).rejects.toThrow(`dial ${target.addr} through jumphost:`);
    jumpClient.end();
  });
});
```

- [x] **Step 2: Run tests to confirm they fail**

Run: `npm test -- tests/ssh/dialer_through.test.ts`
Expected: FAIL — `dialThrough` missing; FakeSshServer ignores `forwarding`.

- [x] **Step 3: Add forwarding to the fake server**

In `tests/helpers/fake_ssh.ts`:

Add to `FakeSshOptions`:

```ts
  forwarding?: boolean;
```

Inside `FakeSshServer.start`, after `client.on("session", ...)`:

```ts
      client.on("tcpip", (accept, reject, info) => {
        if (opts.forwarding === false) {
          reject();
          return;
        }
        const upstream = net.connect(info.destPort, info.destIP, () => {
          let channel;
          try {
            channel = accept();
          } catch {
            upstream.destroy();
            return;
          }
          channel.pipe(upstream).pipe(channel);
          channel.on("error", () => upstream.destroy());
          channel.on("close", () => upstream.destroy());
          upstream.on("error", () => channel.destroy());
          upstream.on("close", () => channel.destroy());
        });
        upstream.on("error", () => {
          try { reject(); } catch { /* already settled */ }
        });
      });
```

- [x] **Step 4: Implement `dialThrough`**

Refactor `src/ssh/dialer.ts`:

1. Add `ClientChannel` to the ssh2 type import:

```ts
import type { Client as SshClient, ClientChannel, ConnectConfig } from "ssh2";
```

2. Extract the handshake from `dial`:

```ts
  private async connectOverSocket(
    socket: net.Socket | ClientChannel,
    opts: DialOptions,
    auth: AuthConfig,
  ): Promise<SshClient> {
    let hostKeyError: Error | undefined;
    const { host, port } = splitHostPort(opts.addr);
    const config: ConnectConfig = {
      host,
      port,
      username: opts.user,
      sock: socket,
      readyTimeout: 10_000,
      hostVerifier: (key: Buffer): boolean => {
        if (!opts.hostKeyVerify) {
          this.logger.debug("host key verification disabled", {
            server: opts.serverName, addr: opts.addr,
          });
          return true;
        }
        try {
          const status = this.knownHosts.check(opts.addr, key);
          this.logger.debug("host key verified", {
            server: opts.serverName, addr: opts.addr, fingerprint: status,
          });
          return true;
        } catch (err) {
          hostKeyError = err instanceof Error ? err : new Error(String(err));
          this.logger.warn("host key check failed", {
            server: opts.serverName, addr: opts.addr, err: hostKeyError.message,
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
        server: opts.serverName, addr: opts.addr, err: err.message,
      });
    });
    this.logger.debug("ssh connected", { server: opts.serverName, addr: opts.addr });
    return client;
  }
```

3. Replace the body of `dial` after `const auth = loadAuth(opts.auth);` with:

```ts
    let socket: net.Socket;
    try {
      socket = await connectUnderlying(opts.addr, opts.proxy, this.logger);
    } catch (err) {
      throw new Error(`dial ${opts.addr}: ${message(err)}`);
    }
    return this.connectOverSocket(socket, opts, auth);
```

4. Add `openDirectTcpip` and `dialThrough`:

```ts
  private openDirectTcpip(
    jumpClient: SshClient,
    host: string,
    port: number,
  ): Promise<ClientChannel> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("open direct-tcpip timed out after 10s"));
      }, 10_000);
      try {
        jumpClient.forwardOut("127.0.0.1", 0, host, port, (err, channel) => {
          if (settled) {
            if (!err && channel) channel.destroy();
            return;
          }
          settled = true;
          clearTimeout(timer);
          if (err) reject(new Error(message(err)));
          else resolve(channel);
        });
      } catch (err) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
    });
  }

  /** 经 jumphost 的 direct-tcpip 通道拨号 target（ssh -J 语义）。 */
  async dialThrough(jumpClient: SshClient, opts: DialOptions): Promise<SshClient> {
    this.logger.debug("dialing through", {
      server: opts.serverName,
      addr: opts.addr,
      user: opts.user,
      auth_method: opts.auth.private_key ? "private_key" : "password",
    });
    const auth = loadAuth(opts.auth);
    const { host, port } = splitHostPort(opts.addr);
    let channel: ClientChannel;
    try {
      channel = await this.openDirectTcpip(jumpClient, host, port);
    } catch (err) {
      throw new Error(
        `dial ${opts.addr} through jumphost: ${message(err)}`,
      );
    }
    return this.connectOverSocket(channel, opts, auth);
  }
```

- [x] **Step 5: Run tests**

Run: `npm test -- tests/ssh`
Expected: PASS — dialer, known_hosts, proxy, dialer_through.

- [x] **Step 6: Commit**

```bash
git add src/ssh/dialer.ts tests/helpers/fake_ssh.ts tests/ssh/dialer_through.test.ts
git commit -m "feat: add direct-tcpip dialing through a jumphost"
```

---

### Task 4: Pattern A/B Login Assembly

**Files:**
- Modify: `src/ssh/login.ts`
- Modify: `src/mcp/tools_session.ts`
- Modify: `src/mcp/server.ts` (login description)
- Test: compile-level only here; end-to-end in Task 5

- [x] **Step 1: Rewrite `src/ssh/login.ts`**

Keep `SshChannelTransport`, but extend `openPty` with a jumphost client and replace the setup section:

```ts
import type { Client, ClientChannel, TerminalModes } from "ssh2";
import type { Jumphost, LoginAction, Proxy, SSHServer } from "../config/types.js";
import { nullLogger, type Logger } from "../log.js";
import { PtyConn } from "../pty/pty_conn.js";
import type { PtyTransport } from "../pty/transport.js";
import { Dialer } from "./dialer.js";
import type { KnownHostsStore } from "./known_hosts.js";
import { LoginFlowError, type LoginTraceEntry } from "./types.js";

const OPEN_PTY_TIMEOUT_MS = 15_000;
const SFTP_PROBE_TIMEOUT_MS = 5_000;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function hasFlow(flow: Record<string, LoginAction> | undefined): boolean {
  return !!flow && Object.keys(flow).length > 0;
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
      new SshChannelTransport(client, channel, logger, jumpClient),
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
}

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
  server: SSHServer,
  trace: LoginTraceEntry[],
  stage: string,
): Promise<void> {
  if (server.raw) {
    conn.markRaw();
    return;
  }
  await conn.detectShell();
  try {
    trace.push(await conn.injectRC());
  } catch (err) {
    if (err instanceof LoginFlowError) {
      throw new LoginFlowError("rc_inject", [...trace, ...err.trace], `${stage}: ${err.message}`);
    }
    throw err;
  }
}

/** 直连：dial → open pty → LoginFlow（可选）→ raw 或 detect+RC → sftp 探测。 */
export async function setupDirect(
  options: SetupOptions & { server: SSHServer; proxy?: Proxy },
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

  const trace: LoginTraceEntry[] = [];
  try {
    trace.push(...await runFlow(
      conn, server.login_flow, server.login_entry,
      server.max_steps, server.global_timeout_ms, "direct",
    ));
    await finishLogin(conn, server, trace, "direct");
  } catch (err) {
    conn.close();
    throw err;
  }
  const sftpAvailable = await conn.probeSftp();
  return { conn, loginTrace: trace, sftpAvailable };
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

  const trace: LoginTraceEntry[] = [];
  try {
    trace.push(...await runFlow(
      conn, server.login_flow, server.login_entry,
      server.max_steps, server.global_timeout_ms, "patternA",
    ));
    await finishLogin(conn, server, trace, "patternA");
  } catch (err) {
    conn.close();
    throw err;
  }
  const sftpAvailable = await conn.probeSftp();
  return { conn, loginTrace: trace, sftpAvailable };
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

  const trace: LoginTraceEntry[] = [];
  try {
    trace.push(...await runFlow(
      conn, jump.login_flow, jump.login_entry,
      jump.max_steps, jump.global_timeout_ms, "jumphost",
    ));
    trace.push(...await runFlow(
      conn, server.login_flow, server.login_entry,
      server.max_steps, server.global_timeout_ms, "target",
    ));
    await finishLogin(conn, server, trace, "patternB");
  } catch (err) {
    conn.close();
    throw err;
  }
  return { conn, loginTrace: trace, sftpAvailable: false };
}

/** 按 server.via 选择直连 / Pattern A / Pattern B。 */
export async function setupServer(
  options: SetupOptions & {
    server: SSHServer;
    jump?: Jumphost;
    serverProxy?: Proxy;
    jumpProxy?: Proxy;
  },
): Promise<SetupResult> {
  if (!options.jump) {
    return setupDirect(options);
  }
  if (options.jump.ssh_j) {
    return setupPatternA({ ...options, jump: options.jump });
  }
  return setupPatternB({ ...options, jump: options.jump });
}

export type { DirectSetupResult } from "./login.js";
```

Remove the stale `DirectSetupResult` block; keep `SetupResult` only. Delete `export type { DirectSetupResult }` line above (it is invalid because the interface no longer exists).

- [x] **Step 2: Update `loginTool` to resolve `via` and dispatch**

In `src/mcp/tools_session.ts`:

Replace imports:

```ts
import type { Jumphost, Proxy, SSHServer } from "../config/types.js";
import { setupServer } from "../ssh/login.js";
```

Replace the whole `loginTool` body:

```ts
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
```

- [x] **Step 3: Update the `login` tool description**

In `src/mcp/server.ts`, change the final sentence from

```
M2 supports direct connections only; via/login_flow return an explicit M3 error.
```

to

```
Supports direct connections, Pattern A (via.ssh_j=true, transparent ssh -J), and Pattern B (via.ssh_j=false, interactive bastion driven by LoginFlow). LoginFlow failures return JSON {error, login_trace} for diagnosis.
```

- [x] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [x] **Step 5: Run existing tests**

Run: `npm test`
Expected: PASS (existing 116 tests; the security test asserting the M3 error must be updated in Task 5 — expect exactly those two failures until then: `via jumphosts not implemented yet (M3)` and `login_flow not implemented yet (M3)`).

- [x] **Step 6: Commit**

```bash
git add src/ssh/login.ts src/mcp/tools_session.ts src/mcp/server.ts
git commit -m "feat: add Pattern A/B login assembly and LoginFlow dispatch"
```

---

### Task 5: Fake Bastion and End-to-End Tests

**Files:**
- Modify: `tests/helpers/fake_ssh.ts` (`FakeShell` bastion/banner)
- Modify: `tests/mcp/session_security.test.ts` (replace M3-rejection case with Pattern checks)
- Test: `tests/mcp/session_loginflow.test.ts`

- [x] **Step 1: Extend `FakeShell` with banner and bastion menu**

In `tests/helpers/fake_ssh.ts`:

```ts
export interface FakeShellOptions {
  raw?: boolean;
  bastion?: boolean;
  banner?: string;
}

export const BASTION_MENU =
  "Welcome to Jumphost v2\r\nMain menu:\r\n1) prod-db\r\nSelect target: ";
```

Change the constructor:

```ts
  private bastionPhase: "menu" | "user" | "pass" | "shell" | null = null;

  constructor(
    private readonly send: (text: string) => void,
    private readonly raw: boolean,
    options: FakeShellOptions = {},
  ) {
    if (options.banner) this.send(options.banner);
    if (options.bastion) {
      this.bastionPhase = "menu";
      this.send(BASTION_MENU);
    }
  }
```

Add a branch at the top of `handleLine`:

```ts
    if (this.bastionPhase && this.bastionPhase !== "shell") {
      this.handleBastionLine(line);
      return;
    }
```

Add:

```ts
  private handleBastionLine(line: string): void {
    switch (this.bastionPhase) {
      case "menu":
        if (line === "1") {
          this.send("Connecting to prod-db...\r\nlogin: ");
          this.bastionPhase = "user";
        }
        return;
      case "user":
        this.send("Password: ");
        this.bastionPhase = "pass";
        return;
      case "pass":
        if (line === "wonderland") {
          this.send("Welcome to prod-db!\r\n");
          this.bastionPhase = "shell";
        } else {
          this.send("Login incorrect\r\nSelect target: ");
          this.bastionPhase = "menu";
        }
        return;
      default:
        return;
    }
  }
```

Pass options from both callers:

- `FakePtyTransport`: `new FakeShell(..., !!opts.raw, {})` (keep defaults; or extend its options).
- `FakeSshServer`: `new FakeShell((text) => stream.write(text), !!opts.raw, { bastion: opts.bastion, banner: opts.banner })`.

Add to `FakeSshOptions`:

```ts
  bastion?: boolean;
  banner?: string;
```

- [x] **Step 2: Replace the M3-rejection test**

In `tests/mcp/session_security.test.ts`, delete the `rejects via and login_flow with explicit M3 errors` test. M3 coverage moves to `session_loginflow.test.ts`.

- [x] **Step 3: Write end-to-end tests**

`tests/mcp/session_loginflow.test.ts`:

```ts
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
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  return {
    isError: !!(result as { isError?: boolean }).isError,
    text: textOf(result),
    json: () => JSON.parse(textOf(result)),
  };
}

async function app(config: Record<string, unknown>) {
  const temp = await tempDir();
  const file = await writeConfig(temp.dir, { version: "1", idle_timeout_s: 300, ...config });
  const client = await connect(new Store(file));
  return { client, cleanup: temp.cleanup };
}

const jumpFlow = {
  entry: { expects: [{ pattern: "Select target:*", next: "success" }] },
};
const targetFlow = {
  entry: { send: "1\n", expects: [{ pattern: "login:*", next: "send_user" }] },
  send_user: { send: "alice\n", expects: [{ pattern: "Password:*", next: "send_pwd" }] },
  send_pwd: { send: "wonderland\n", expects: [{ pattern: "Welcome to*", next: "success" }] },
};

let cleanupFns: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanupFns.reverse()) await fn();
  cleanupFns = [];
});

describe("M3 connection forms", () => {
  it("runs a direct LoginFlow before shell detection", async () => {
    const fake = await FakeSshServer.start({ banner: "Welcome to prod\r\nRole: " });
    const { client, cleanup } = await app({
      jumphosts: [], proxies: [],
      servers: [{
        name: "local", addr: fake.addr, user: "test", auth: { password: "secret" },
        login_flow: { entry: { expects: [{ pattern: "Role: *", next: "success" }] } },
        login_entry: "entry",
      }],
    });
    cleanupFns.push(cleanup, () => fake.close());
    const login = await call(client, "login", { name: "local" });
    expect(login.isError).toBe(false);
    const sid = login.json().sid;
    expect((await call(client, "run_in_session", { sid, cmd: "echo direct-ok" })).json().output)
      .toBe("direct-ok");
    const trace = (await call(client, "get_trace", { sid })).json();
    expect(trace.login_flow).toHaveLength(2);
    expect(trace.login_flow[0]).toMatchObject({ send: "", expect: "Role: *" });
  });

  it("returns loginflow error plus login_trace on direct failure", async () => {
    const fake = await FakeSshServer.start({ banner: "Welcome\r\nRole: " });
    const { client, cleanup } = await app({
      jumphosts: [], proxies: [],
      servers: [{
        name: "local", addr: fake.addr, user: "test", auth: { password: "secret" },
        login_flow: {
          entry: {
            expects: [{ pattern: "NEVER_MATCHES", next: "success" }],
            timeout_ms: 100,
          },
        },
        login_entry: "entry",
      }],
    });
    cleanupFns.push(cleanup, () => fake.close());
    const login = await call(client, "login", { name: "local" });
    expect(login.isError).toBe(true);
    const body = login.json();
    expect(body.error).toContain("loginflow");
    expect(body.error.startsWith("direct: loginflow:")).toBe(true);
    expect(body.login_trace).toHaveLength(1);
    expect(body.login_trace[0].expect).toBe("");
  });

  it("logs in through Pattern A and runs commands on the target", async () => {
    const target = await FakeSshServer.start();
    const jump = await FakeSshServer.start();
    const { client, cleanup } = await app({
      proxies: [],
      jumphosts: [{
        name: "bastion", addr: jump.addr, user: "test",
        auth: { password: "secret" }, ssh_j: true,
      }],
      servers: [{
        name: "target", addr: target.addr, user: "test",
        auth: { password: "secret" }, via: "bastion",
      }],
    });
    cleanupFns.push(cleanup, () => target.close(), () => jump.close());
    const login = await call(client, "login", { name: "target" });
    expect(login.isError).toBe(false);
    expect(login.json()).toMatchObject({ mode: "shell", sftp_available: false });
    const sid = login.json().sid;
    const run = await call(client, "run_in_session", { sid, cmd: "echo via-pattern-a" });
    expect(run.json().output).toBe("via-pattern-a");
  });

  it("reports sftp availability for Pattern A and none for Pattern B", async () => {
    const target = await FakeSshServer.start({ allowSftp: true });
    const jump = await FakeSshServer.start();
    const appA = await app({
      proxies: [],
      jumphosts: [{
        name: "bastion", addr: jump.addr, user: "test",
        auth: { password: "secret" }, ssh_j: true,
      }],
      servers: [{
        name: "target", addr: target.addr, user: "test",
        auth: { password: "secret" }, via: "bastion",
      }],
    });
    cleanupFns.push(appA.cleanup, () => target.close(), () => jump.close());
    expect((await call(appA.client, "login", { name: "target" })).json().sftp_available).toBe(true);

    const bastion = await FakeSshServer.start({ bastion: true, allowSftp: true });
    const appB = await app({
      proxies: [],
      jumphosts: [{
        name: "menu", addr: bastion.addr, user: "test",
        auth: { password: "secret" }, ssh_j: false,
        login_flow: jumpFlow, login_entry: "entry",
      }],
      servers: [{
        name: "target", addr: "127.0.0.1:22", user: "alice", auth: {},
        via: "menu", login_flow: targetFlow, login_entry: "entry",
      }],
    });
    cleanupFns.push(appB.cleanup, () => bastion.close());
    const loginB = await call(appB.client, "login", { name: "target" });
    expect(loginB.isError).toBe(false);
    expect(loginB.json()).toMatchObject({ mode: "shell", sftp_available: false });
  });

  it("runs Pattern B: bastion then target LoginFlow on one PTY", async () => {
    const bastion = await FakeSshServer.start({ bastion: true });
    const { client, cleanup } = await app({
      proxies: [],
      jumphosts: [{
        name: "menu", addr: bastion.addr, user: "test",
        auth: { password: "secret" }, ssh_j: false,
        login_flow: jumpFlow, login_entry: "entry",
      }],
      servers: [{
        name: "target", addr: "127.0.0.1:22", user: "alice", auth: {},
        via: "menu", login_flow: targetFlow, login_entry: "entry",
      }],
    });
    cleanupFns.push(cleanup, () => bastion.close());
    const login = await call(client, "login", { name: "target" });
    expect(login.isError).toBe(false);
    const sid = login.json().sid;
    const run = await call(client, "run_in_session", { sid, cmd: "echo via-pattern-b" });
    expect(run.json().output).toBe("via-pattern-b");
    const trace = (await call(client, "get_trace", { sid })).json();
    expect(trace.login_flow).toHaveLength(5);
    expect(trace.login_flow.slice(0, 4).map((t: { send: string }) => t.send))
      .toEqual(["", "1\n", "alice\n", "wonderland\n"]);
  });

  it("returns only the failing segment trace for Pattern B", async () => {
    const bastion = await FakeSshServer.start({ bastion: true });
    const badFlow = {
      entry: {
        expects: [{ pattern: "NEVER_MATCHES", next: "success" }],
        timeout_ms: 100,
      },
    };
    const { client, cleanup } = await app({
      proxies: [],
      jumphosts: [{
        name: "menu", addr: bastion.addr, user: "test",
        auth: { password: "secret" }, ssh_j: false,
        login_flow: jumpFlow, login_entry: "entry",
      }],
      servers: [{
        name: "target", addr: "127.0.0.1:22", user: "alice", auth: {},
        via: "menu", login_flow: badFlow, login_entry: "entry",
      }],
    });
    cleanupFns.push(cleanup, () => bastion.close());
    const login = await call(client, "login", { name: "target" });
    expect(login.isError).toBe(true);
    const body = login.json();
    expect(body.error.startsWith("target: loginflow:")).toBe(true);
    expect(body.login_trace).toHaveLength(1);
  });
});
```

- [x] **Step 4: Run the new tests**

Run: `npm test -- tests/mcp/session_loginflow.test.ts`
Expected: PASS (6 tests).

If Pattern B hangs, verify `FakeShell` receives `\n` (ICRNL handling treats both `\r` and `\n`) and that `jumpFlow`'s pattern `Select target:*` matches the banner.

- [x] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS (all files).

- [x] **Step 6: Commit**

```bash
git add tests/helpers/fake_ssh.ts tests/mcp/session_security.test.ts tests/mcp/session_loginflow.test.ts
git commit -m "test: cover direct LoginFlow, Pattern A and Pattern B end-to-end"
```

---

### Task 6: Documentation and Acceptance

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-11-18-myssh-m3-jumphosts.md` (checkboxes)

- [x] **Step 1: Update README status**

Replace the M2 status block with:

```markdown
## Status

M3 (jumphosts and LoginFlow) is complete:

- [x] Project scaffold, build, tests
- [x] Config model, validation, atomic load/save
- [x] `server` / `jumphost` / `proxy` `list|get` CLI
- [x] 9 config CRUD MCP tools
- [x] Direct SSH via password or private key, HTTP/SOCKS5 proxies
- [x] TOFU `known_hosts`, 0600 key checks
- [x] PTY sessions, command sentinel, `run_in_session`
- [x] Session state, traces, `stat` / `get_trace`, raw send/read, sftp probe
- [x] Transparent jumphosts (Pattern A, `ssh -J` semantics)
- [x] Interactive bastions (Pattern B) driven by `login_flow`
- [ ] sftp file transfer (M4)
- [ ] `install` / `doctor` / Agent injection (M5)
- [ ] npm publish and three-platform CI (M6)

M3 connection forms:

- Direct (`no via`): SSH to the target; optional target `login_flow` after auth.
- Pattern A (`via.ssh_j=true`): SSH to the jumphost, `direct-tcpip` tunnel,
  second SSH handshake to the target; sftp is available on the target.
- Pattern B (`via.ssh_j=false`): one PTY on the interactive bastion; jumphost
  `login_flow` then target `login_flow` drive the menu; sftp reports `false`.
- LoginFlow failures return `{"error": "... loginflow ...", "login_trace": [...]}`.
```

- [x] **Step 2: Full acceptance**

Run: `npm run typecheck`
Expected: exit 0.

Run: `npm test`
Expected: all tests pass.

Run: `npm run build`
Expected: `dist/index.js` generated.

Run: `node dist/index.js version`
Expected: version line, exit 0.

- [x] **Step 3: Check off the plan and commit**

Mark completed steps `- [x]`, then:

```bash
git add README.md docs/superpowers/plans/2026-11-18-myssh-m3-jumphosts.md
git commit -m "docs: record M3 jumphost and LoginFlow support"
```
