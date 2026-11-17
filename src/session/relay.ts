import { PassThrough, Writable } from "node:stream";
import type { SessionManager } from "./manager.js";
import type { Session } from "./session.js";
import type { TransferOutcome } from "../sftp/types.js";
import { SFTP_UNAVAILABLE } from "../sftp/types.js";

export const ALL_DESTINATIONS_FAILED = "all relay destinations failed";

interface Slot {
  stream: PassThrough;
  dead: boolean;
}

/** Writable that fans every chunk out to N PassThroughs with backpressure. */
export class FanoutSink extends Writable {
  private readonly slots: Slot[];

  constructor(count: number) {
    super({ highWaterMark: 64 * 1024 });
    // A destroyed sink may emit 'error' after the download pump detached its
    // listener; keep one permanent consumer so relayTransfer can report it.
    this.on("error", () => { /* surfaced by the download outcome */ });
    this.slots = Array.from({ length: count }, () => {
      const stream = new PassThrough({ highWaterMark: 64 * 1024 });
      const slot: Slot = { stream, dead: false };
      stream.on("error", () => { slot.dead = true; });
      stream.on("close", () => { slot.dead = true; });
      return slot;
    });
  }

  streams(): PassThrough[] {
    return this.slots.map((slot) => slot.stream);
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const live = this.slots.filter((slot) => !slot.dead && !slot.stream.destroyed);
    if (live.length === 0) {
      callback(new Error(ALL_DESTINATIONS_FAILED));
      return;
    }
    void Promise.all(live.map((slot) => this.writeSlot(slot, chunk))).then(() => {
      if (this.liveCount() === 0) callback(new Error(ALL_DESTINATIONS_FAILED));
      else callback();
    });
  }

  override _final(callback: () => void): void {
    for (const slot of this.slots) {
      if (!slot.stream.destroyed) {
        try { slot.stream.end(); } catch { /* already ended */ }
      }
    }
    callback();
  }

  override _destroy(err: Error | null, callback: (error?: Error | null) => void): void {
    for (const slot of this.slots) {
      try { slot.stream.destroy(err ?? undefined); } catch { /* ignore */ }
    }
    callback();
  }

  private liveCount(): number {
    return this.slots.filter((slot) => !slot.dead && !slot.stream.destroyed).length;
  }

  private writeSlot(slot: Slot, chunk: Buffer): Promise<void> {
    return new Promise<void>((resolve) => {
      if (slot.dead || slot.stream.destroyed) {
        resolve();
        return;
      }
      let settled = false;
      const finish = (dead: boolean): void => {
        if (settled) return;
        settled = true;
        slot.stream.off("drain", onDrain);
        slot.stream.off("error", onError);
        slot.stream.off("close", onClose);
        if (dead) slot.dead = true;
        resolve();
      };
      const onDrain = (): void => finish(false);
      const onError = (): void => finish(true);
      const onClose = (): void => finish(true);
      slot.stream.once("drain", onDrain);
      slot.stream.once("error", onError);
      slot.stream.once("close", onClose);
      try {
        if (slot.stream.write(chunk)) finish(false);
      } catch {
        finish(true);
      }
    });
  }
}

export interface RelayDestinationResult {
  dstSid: string;
  dstServer: string;
  ok: boolean;
  bytes: number;
  timedOut: boolean;
  error?: string;
}

export interface RelayOutcome {
  ok: boolean;
  downloadedBytes: number;
  timedOut: boolean;
  srcServer: string;
  destinations: RelayDestinationResult[];
  error?: string;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function failedDownload(err: unknown): TransferOutcome {
  return {
    bytes: 0,
    timedOut: false,
    error: err instanceof Error ? err : new Error(String(err)),
  };
}

export interface RelayHooks {
  onDownloadedBytes?: (bytes: number) => void;
  onDestinationDone?: (
    dstSid: string,
    ok: boolean,
    bytes: number,
    error?: string,
  ) => void;
}

export async function relayTransfer(
  manager: SessionManager,
  srcSid: string,
  srcPath: string,
  dstSids: string[],
  dstPath: string,
  timeoutMs = 0,
  hooks: RelayHooks = {},
): Promise<RelayOutcome> {
  const srcSession = manager.get(srcSid);
  if (dstSids.length === 0) throw new Error("no relay destinations");

  if (!srcSession.sftpAvailable) {
    return {
      ok: false,
      downloadedBytes: 0,
      timedOut: false,
      srcServer: srcSession.serverName,
      destinations: dstSids.map((dstSid) => ({
        dstSid,
        dstServer: "",
        ok: false,
        bytes: 0,
        timedOut: false,
        error: "source sftp unavailable",
      })),
      error: SFTP_UNAVAILABLE,
    };
  }

  const destinations: RelayDestinationResult[] = dstSids.map((dstSid) => ({
    dstSid,
    dstServer: "",
    ok: false,
    bytes: 0,
    timedOut: false,
  }));

  interface LiveEntry {
    index: number;
    session: Session;
  }
  const live: LiveEntry[] = [];

  for (let index = 0; index < dstSids.length; index += 1) {
    const dstSid = dstSids[index]!;
    const destination = destinations[index]!;
    if (dstSid === srcSid) {
      destination.error = "cannot relay a session to itself";
      continue;
    }
    let dstSession: Session;
    try {
      dstSession = manager.get(dstSid);
    } catch (err) {
      destination.error = message(err);
      continue;
    }
    destination.dstServer = dstSession.serverName;
    if (!dstSession.sftpAvailable) {
      destination.error = SFTP_UNAVAILABLE;
      continue;
    }
    if (dstSession.state !== "idle") {
      destination.error = "session busy";
      continue;
    }
    live.push({ index, session: dstSession });
  }

  if (live.length === 0) {
    return {
      ok: false,
      downloadedBytes: 0,
      timedOut: false,
      srcServer: srcSession.serverName,
      destinations,
      error: "no live relay destinations (all failed pre-flight)",
    };
  }

  let size: number | undefined;
  try {
    const st = await srcSession.sftpStat(srcPath);
    if (!st.isFile) {
      for (const entry of live) {
        destinations[entry.index]!.error = "source not a regular file";
      }
      return {
        ok: false,
        downloadedBytes: 0,
        timedOut: false,
        srcServer: srcSession.serverName,
        destinations,
        error: "source not a regular file",
      };
    }
    size = st.size;
  } catch {
    // A stat failure only skips the byte-count cross-check; the download
    // itself reports the real error.
    size = undefined;
  }

  const sink = new FanoutSink(live.length);
  const streams = sink.streams();

  // A busy/closed source rejects before any bytes flow; treat it like a
  // failed download so the destinations are released instead of hanging.
  const downloadPromise = srcSession
    .download(srcPath, sink, timeoutMs, hooks.onDownloadedBytes)
    .catch(failedDownload);
  const uploadPromises = live.map(async (entry, streamIndex) => {
    const stream = streams[streamIndex]!;
    try {
      const outcome = await entry.session.upload(stream, dstPath, timeoutMs);
      const destination = destinations[entry.index]!;
      destination.ok = !outcome.error && !outcome.timedOut;
      destination.bytes = outcome.bytes;
      destination.timedOut = outcome.timedOut;
      if (outcome.error) destination.error = outcome.error.message;
    } catch (err) {
      const destination = destinations[entry.index]!;
      destination.error = message(err);
    } finally {
      try { stream.destroy(); } catch { /* ignore */ }
      const destination = destinations[entry.index]!;
      hooks.onDestinationDone?.(
        destination.dstSid,
        destination.ok,
        destination.bytes,
        destination.error,
      );
    }
  });

  const downloaded = await downloadPromise;
  if (downloaded.error) sink.destroy(downloaded.error);
  else sink.end();
  await Promise.all(uploadPromises);

  let timedOut = downloaded.timedOut;
  for (const destination of destinations) {
    if (destination.timedOut) timedOut = true;
  }

  let allOk = !downloaded.error && !downloaded.timedOut
    && destinations.every((destination) => destination.ok);
  if (allOk && size !== undefined) {
    if (downloaded.bytes !== size) allOk = false;
    for (const destination of destinations) {
      if (destination.bytes !== size) {
        destination.ok = false;
        allOk = false;
      }
    }
  }

  const result: RelayOutcome = {
    ok: allOk,
    downloadedBytes: downloaded.bytes,
    timedOut,
    srcServer: srcSession.serverName,
    destinations,
  };
  if (!allOk) {
    result.error = downloaded.error?.message ?? "one or more relay destinations failed";
  }
  return result;
}
