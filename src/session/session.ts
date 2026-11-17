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
      if (!this.isClosed()) {
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
      if (!this.isClosed()) {
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
    else if (!this.isClosed()) {
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
      if (!this.isClosed()) {
        this.state = "idle";
        this.resetIdleTimer();
      }
      return { output: result.output, more: result.more, idle_ms: idleMs };
    } catch (err) {
      this.lastActivity = this.now();
      if (!this.isClosed() && isConnLost(err)) {
        this.logger.warn("conn lost during read, closing session", {
          sid: this.sid,
          server: this.serverName,
        });
        this.close();
      } else if (!this.isClosed()) {
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

  private isClosed(): boolean {
    return this.state === "closed";
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
