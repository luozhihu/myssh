import type { PtyConn } from "./pty_conn.js";

/** Local terminal surface used by the relay; injectable in tests. */
export interface TerminalStreams {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  isTTY: boolean;
  getWindowSize?(): { rows: number; cols: number } | undefined;
  onResize?(handler: () => void): () => void;
  setRawMode?(raw: boolean): void;
}

export interface RelayTerminalOptions {
  /** Sent once so a remote shell echoes typed input. */
  echoLine?: string;
  /** Delay after enabling echo before entering raw mode. */
  echoDelayMs?: number;
  signal?: AbortSignal;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * Bidirectional terminal relay. Mirrors Go PtyConn.Relay: flush pending
 * output, run `stty echo`, enter raw mode, pump stdin→PTY and PTY→stdout,
 * forward window resizes, and always restore the terminal + close the PTY.
 */
export async function relayTerminal(
  conn: PtyConn,
  term: TerminalStreams,
  options: RelayTerminalOptions = {},
): Promise<void> {
  const pending = conn.drainPending();
  if (pending.length > 0) term.stdout.write(pending);

  conn.send(options.echoLine ?? "stty echo\n");
  await delay(options.echoDelayMs ?? 50);

  let rawSet = false;
  if (term.isTTY) {
    try {
      term.setRawMode?.(true);
      rawSet = term.setRawMode !== undefined;
    } catch (err) {
      conn.close();
      throw new Error(`set terminal raw mode: ${message(err)}`);
    }
  }

  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });

  const onStdin = (chunk: Buffer | string): void => {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    void conn.sendRaw(data).catch(() => finish());
  };
  const onStdinError = (): void => finish();
  const onAbort = (): void => finish();

  term.stdin.on("data", onStdin);
  term.stdin.once("end", finish);
  term.stdin.once("close", finish);
  term.stdin.once("error", onStdinError);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) finish();

  const detachData = conn.onData((data) => { term.stdout.write(data); });
  const detachClose = conn.onClose(() => finish());

  const applySize = (): void => {
    const size = term.getWindowSize?.();
    if (size && size.rows > 0 && size.cols > 0) conn.resize(size.rows, size.cols);
  };
  applySize();
  const detachResize = term.onResize?.(applySize);

  try {
    await done;
  } finally {
    term.stdin.off("data", onStdin);
    term.stdin.off("end", finish);
    term.stdin.off("close", finish);
    term.stdin.off("error", onStdinError);
    options.signal?.removeEventListener("abort", onAbort);
    detachData();
    detachClose();
    detachResize?.();
    if (rawSet) {
      try { term.setRawMode?.(false); } catch { /* terminal gone */ }
    }
    conn.close();
  }
}
