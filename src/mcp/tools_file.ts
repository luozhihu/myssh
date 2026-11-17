import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { open } from "node:fs/promises";
import type { Readable, Writable } from "node:stream";
import { parseConflictPolicy, type DirTransferOutcome } from "../sftp/types.js";
import type { Service } from "./service.js";
import { errorResult, textResult } from "./result.js";

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function uploadTool(
  svc: Service,
  args: { sid: string; src: string; dst: string; timeout_ms?: number },
) {
  try {
    const session = svc.manager.get(args.sid);
    let fh;
    try {
      fh = await open(args.src, "r");
    } catch (err) {
      return errorResult(`open local ${args.src}: ${message(err)}`);
    }
    try {
      const source = fh.createReadStream({ autoClose: true }) as Readable;
      const outcome = await session.upload(source, args.dst, args.timeout_ms ?? 0);
      if (outcome.error && !outcome.timedOut) return errorResult(message(outcome.error));
      return textResult({
        sid: args.sid,
        ok: !outcome.error,
        bytes: outcome.bytes,
        timed_out: outcome.timedOut,
        remote_url: args.dst,
      });
    } finally {
      try { await fh.close(); } catch { /* the stream may own the fd */ }
    }
  } catch (err) {
    return errorResult(message(err));
  }
}

export async function downloadTool(
  svc: Service,
  args: { sid: string; src: string; dst: string; timeout_ms?: number },
) {
  try {
    const session = svc.manager.get(args.sid);
    const dst = createWriteStream(args.dst, { flags: "w" });
    // Surface create/open failures with Go's prefix.
    try {
      await once(dst, "open");
    } catch (err) {
      dst.destroy();
      return errorResult(`create local ${args.dst}: ${message(err)}`);
    }
    const onError = (): void => { /* reported via outcome */ };
    dst.on("error", onError);
    try {
      const outcome = await session.download(args.src, dst as Writable, args.timeout_ms ?? 0);
      dst.end();
      try { await once(dst, "finish"); } catch { /* already errored */ }
      if (outcome.error && !outcome.timedOut) return errorResult(message(outcome.error));
      return textResult({
        sid: args.sid,
        ok: !outcome.error,
        bytes: outcome.bytes,
        timed_out: outcome.timedOut,
        local_url: args.dst,
      });
    } finally {
      dst.off("error", onError);
      dst.destroy();
    }
  } catch (err) {
    return errorResult(message(err));
  }
}

function dirBody(
  sid: string,
  outcome: DirTransferOutcome,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    sid,
    ok: !outcome.error,
    bytes: outcome.result.bytes,
    files: outcome.result.files,
    skipped: outcome.result.skipped,
    renamed: outcome.result.renamed,
    timed_out: outcome.result.timedOut,
  };
  if (outcome.error) body.err = outcome.error.message;
  return body;
}

export interface DirTransferArgs {
  sid: string;
  src: string;
  dst: string;
  conflict?: string;
  concurrency?: number;
  timeout_ms?: number;
}

export async function uploadDirTool(svc: Service, args: DirTransferArgs) {
  try {
    const session = svc.manager.get(args.sid);
    const outcome = await session.uploadDir(args.src, args.dst, {
      conflict: parseConflictPolicy(args.conflict),
      concurrency: args.concurrency ?? 0,
      timeoutMs: args.timeout_ms ?? 0,
    });
    return textResult(dirBody(args.sid, outcome));
  } catch (err) {
    return errorResult(message(err));
  }
}

export async function downloadDirTool(svc: Service, args: DirTransferArgs) {
  try {
    const session = svc.manager.get(args.sid);
    const outcome = await session.downloadDir(args.src, args.dst, {
      conflict: parseConflictPolicy(args.conflict),
      concurrency: args.concurrency ?? 0,
      timeoutMs: args.timeout_ms ?? 0,
    });
    return textResult(dirBody(args.sid, outcome));
  } catch (err) {
    return errorResult(message(err));
  }
}
