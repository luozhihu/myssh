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

describe("relay primitives", () => {
  it("drains queued and pushed-back data exactly once", async () => {
    const transport = new FakePtyTransport();
    const conn = new PtyConn(transport, "ab12");
    transport.emit("queued");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(conn.drainPending().toString()).toBe("queued");
    expect(conn.drainPending().length).toBe(0);
    conn.close();
  });

  it("forwards window sizes to the transport", () => {
    const transport = new FakePtyTransport();
    const conn = new PtyConn(transport, "ab12");
    conn.resize(40, 120);
    conn.resize(0, 120);
    expect(transport.windowSizes).toEqual([{ rows: 40, cols: 120 }]);
    conn.close();
  });
});
