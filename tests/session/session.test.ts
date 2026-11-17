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
