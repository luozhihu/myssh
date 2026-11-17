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
