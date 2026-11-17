import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { PtyConn } from "../../src/pty/pty_conn.js";
import { relayTerminal } from "../../src/pty/relay_terminal.js";
import { FakePtyTransport } from "../helpers/fake_pty.js";

function tick(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function capture() {
  let text = "";
  const stream = new Writable({
    write(chunk, _enc, cb) { text += chunk.toString(); cb(); },
  });
  return { stream, get text() { return text; } };
}

function makeConn() {
  const transport = new FakePtyTransport();
  const conn = new PtyConn(transport, "ab12");
  return { transport, conn };
}

function makeTerminal() {
  const stdin = new PassThrough();
  const out = capture();
  const rawModes: boolean[] = [];
  let resizeHandler: (() => void) | undefined;
  return {
    stdin,
    out,
    rawModes,
    fireResize: () => resizeHandler?.(),
    streams: {
      stdin,
      stdout: out.stream,
      isTTY: true,
      getWindowSize: () => ({ rows: 24, cols: 80 }),
      onResize: (handler: () => void) => {
        resizeHandler = handler;
        return () => { resizeHandler = undefined; };
      },
      setRawMode: (raw: boolean) => { rawModes.push(raw); },
    },
  };
}

describe("relayTerminal", () => {
  it("flushes pending output, pumps both directions, and restores the terminal", async () => {
    const { transport, conn } = makeConn();
    transport.emit("early-prompt");
    const term = makeTerminal();

    const relay = relayTerminal(conn, term.streams, { echoDelayMs: 0 });
    await tick();
    expect(term.out.text).toBe("early-prompt");
    expect(transport.allWritten()).toContain("stty echo\n");
    expect(transport.windowSizes).toEqual([{ rows: 24, cols: 80 }]);

    term.stdin.write("echo hi\r");
    await tick();
    expect(transport.allWritten()).toContain("echo hi\r");
    expect(term.out.text).toContain("hi\r\n");

    term.fireResize();
    expect(transport.windowSizes).toHaveLength(2);

    term.stdin.end();
    await relay;
    expect(term.rawModes).toEqual([true, false]);
    expect(conn.closed).toBe(true);
  });

  it("finishes when the remote closes", async () => {
    const { transport, conn } = makeConn();
    const term = makeTerminal();
    const relay = relayTerminal(conn, term.streams, { echoDelayMs: 0 });
    await tick();
    transport.close();
    await relay;
    expect(term.rawModes).toEqual([true, false]);
  });

  it("finishes on abort", async () => {
    const { conn } = makeConn();
    const term = makeTerminal();
    const controller = new AbortController();
    const relay = relayTerminal(conn, term.streams, {
      echoDelayMs: 0,
      signal: controller.signal,
    });
    await tick();
    controller.abort();
    await relay;
    expect(conn.closed).toBe(true);
  });

  it("does not touch raw mode for non-TTY streams", async () => {
    const { conn } = makeConn();
    const term = makeTerminal();
    const relay = relayTerminal(conn, { ...term.streams, isTTY: false }, { echoDelayMs: 0 });
    await tick();
    term.stdin.end();
    await relay;
    expect(term.rawModes).toEqual([]);
  });
});
