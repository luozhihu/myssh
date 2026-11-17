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
