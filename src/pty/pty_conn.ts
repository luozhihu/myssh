import { ConnLostError, PtyUnusableError } from "../ssh/errors.js";
import {
  LoginFlowError,
  type LoginTraceEntry,
  type RawReadResult,
  type RunOutcome,
} from "../ssh/types.js";
import type { LoginAction } from "../config/types.js";
import {
  runLoginFlow,
  type LoginFlowPty,
  type LoginFlowRead,
  type LoginFlowResult,
} from "../loginflow/executor.js";
import { nullLogger, type Logger } from "../log.js";
import { randomSID } from "../util/random.js";
import { traceTimestamp } from "../util/time.js";
import { cleanOutput, stripANSIWithPos } from "./normalize.js";
import { ByteQueue } from "./queue.js";
import { extractExitCode, truncateOutput } from "./sentinel.js";
import { buildRC, parseShellDetect } from "./shell_detect.js";
import type { PtyTransport } from "./transport.js";

export const DEFAULT_CMD_TIMEOUT_MS = 30_000;
const CTRL_C_DRAIN_TIMEOUT_MS = 3_000;
const SET_TOKEN_TIMEOUT_MS = 2_000;
const SHELL_DETECT_TIMEOUT_MS = 5_000;
const RC_INJECT_TIMEOUT_MS = 5_000;
const RAW_QUIET_GAP_MS = 400;
const LOGIN_FLOW_QUIET_MS = 200;

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
export class PtyConn implements LoginFlowPty {
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

  /** LoginFlow 阶段：向 PTY 写入任意文本。 */
  send(data: string): void {
    this.requireOpen();
    this.logger.debug("loginflow send", {
      bytes: Buffer.byteLength(data),
      sid: this.sid,
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
  ): Promise<LoginFlowResult> {
    if (Object.keys(flow).length === 0) return { trace: [] };
    return runLoginFlow(this, flow, entry, {
      maxSteps: options.maxSteps,
      globalTimeoutMs: options.globalTimeoutMs,
      logger: this.logger,
    });
  }

  /** 在 stripped 输出上匹配；命中返回 matcher 下标和 raw 字节末尾位置。 */
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
