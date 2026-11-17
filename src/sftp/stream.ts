import type { Readable, Writable } from "node:stream";
import type { PumpError } from "./types.js";

/** The error a transfer should report once its abort signal fires. */
export function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  return reason instanceof Error ? reason : new Error("transfer aborted");
}

/** Wait for `drain`, or fail on error/abort. */
export function waitDrain(dst: Writable, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      dst.off("drain", onDrain);
      dst.off("error", onError);
      dst.off("close", onClose);
      signal.removeEventListener("abort", onAbort);
    };
    const onDrain = (): void => { cleanup(); resolve(); };
    const onError = (err: Error): void => { cleanup(); reject(err); };
    const onClose = (): void => {
      cleanup();
      reject(dst.errored ?? new Error("destination closed"));
    };
    const onAbort = (): void => { cleanup(); reject(abortError(signal)); };
    dst.once("drain", onDrain);
    dst.once("error", onError);
    dst.once("close", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Pump `src` into `dst` with backpressure and abort support. Never ends `dst`;
 * the caller owns its lifecycle. Returns bytes successfully written.
 */
export async function pumpToWritable(
  src: Readable,
  dst: Writable,
  signal: AbortSignal,
  onBytes?: (bytes: number) => void,
): Promise<number> {
  let bytes = 0;
  // Errors are observed through waitDrain / the destination's errored state.
  // A permanent no-op listener prevents an unhandled 'error' after destroy().
  const onError = (): void => { /* consumed below */ };
  dst.on("error", onError);
  try {
    for await (const chunk of src) {
      if (signal.aborted) throw abortError(signal);
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      if (!dst.write(buf)) await waitDrain(dst, signal);
      if (dst.errored) throw dst.errored;
      bytes += buf.length;
      onBytes?.(bytes);
    }
    if (signal.aborted) throw abortError(signal);
    if (dst.errored) throw dst.errored;
    return bytes;
  } catch (err) {
    const failure: PumpError = err instanceof Error ? err : new Error(String(err));
    failure.bytes = bytes;
    throw failure;
  } finally {
    dst.off("error", onError);
  }
}

/**
 * End a writable and wait until all queued data is flushed. With a signal,
 * an abort (or the stream being destroyed) rejects instead of hanging.
 */
export function finishWritable(dst: Writable, signal?: AbortSignal): Promise<void> {
  if (dst.writableFinished) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      dst.off("finish", onFinish);
      dst.off("error", onError);
      dst.off("close", onClose);
      signal?.removeEventListener("abort", onAbort);
    };
    const onFinish = (): void => { cleanup(); resolve(); };
    const onError = (err: Error): void => { cleanup(); reject(err); };
    const onClose = (): void => {
      cleanup();
      reject(dst.errored ?? new Error("destination closed"));
    };
    const onAbort = (): void => { cleanup(); reject(abortError(signal!)); };
    dst.once("finish", onFinish);
    dst.once("error", onError);
    dst.once("close", onClose);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      cleanup();
      reject(abortError(signal));
      return;
    }
    dst.end();
  });
}
