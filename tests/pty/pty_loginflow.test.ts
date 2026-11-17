import { describe, expect, it } from "vitest";
import { PtyConn } from "../../src/pty/pty_conn.js";
import type { PtyTransport } from "../../src/pty/transport.js";

class ManualTransport implements PtyTransport {
  readonly written: string[] = [];
  private readonly dataHandlers = new Set<(data: Buffer) => void>();
  private readonly closeHandlers = new Set<(err?: Error) => void>();
  onWrite: ((data: string) => void) | null = null;

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
