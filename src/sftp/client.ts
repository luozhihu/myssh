import { open, rename, unlink } from "node:fs/promises";
import type { Readable, Writable } from "node:stream";
import type { Client, FileEntryWithStats, SFTPWrapper } from "ssh2";
import { nullLogger, type Logger } from "../log.js";
import { atomicRemotePath, localTempPath } from "./paths.js";
import { finishWritable, pumpToWritable } from "./stream.js";
import {
  DEFAULT_TRANSFER_TIMEOUT_MS,
  SftpUnavailableError,
  errorMessage,
  type PumpError,
  type SftpStat,
  type SftpTransfer,
  type TransferOutcome,
} from "./types.js";

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

const OPEN_SFTP_TIMEOUT_MS = 5_000;

function message(err: unknown): string {
  return errorMessage(err);
}

function statFrom(attrs: { mode?: number; size?: number }): SftpStat {
  const mode = attrs.mode ?? 0;
  const kind = mode & S_IFMT;
  return {
    size: attrs.size ?? 0,
    isDirectory: kind === S_IFDIR,
    isFile: kind === S_IFREG,
    isSymbolicLink: kind === S_IFLNK,
  };
}

function openRemote(sftp: SFTPWrapper, path: string, flags: "r" | "w"): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    sftp.open(path, flags, (err, handle) => (err ? reject(err) : resolve(handle)));
  });
}

function closeRemote(sftp: SFTPWrapper, handle: Buffer): Promise<void> {
  return new Promise((resolve) => {
    try {
      sftp.close(handle, () => resolve());
    } catch {
      resolve();
    }
  });
}

function unlinkRemote(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      sftp.unlink(path, () => resolve());
    } catch {
      resolve();
    }
  });
}

function renameRemote(sftp: SFTPWrapper, from: string, to: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.rename(from, to, (err) => (err ? reject(err) : resolve()));
  });
}

/** Best-effort fsync via the OpenSSH extension; absent on most test servers. */
function fsyncRemote(sftp: SFTPWrapper, handle: Buffer): Promise<void> {
  return new Promise((resolve) => {
    try {
      sftp.ext_openssh_fsync(handle, () => resolve());
    } catch {
      resolve();
    }
  });
}

/** PosixRename with Remove+Rename fallback. Throws with `posixError` attached. */
async function posixRename(
  sftp: SFTPWrapper,
  from: string,
  to: string,
): Promise<void> {
  let posixError: Error;
  try {
    await new Promise<void>((resolve, reject) => {
      sftp.ext_openssh_rename(from, to, (err) => (err ? reject(err) : resolve()));
    });
    return;
  } catch (err) {
    posixError = err instanceof Error ? err : new Error(String(err));
  }
  await unlinkRemote(sftp, to);
  try {
    await renameRemote(sftp, from, to);
  } catch (err) {
    throw Object.assign(err instanceof Error ? err : new Error(String(err)), {
      posixError,
    });
  }
}

/** Open a persistent SFTP subsystem channel; null when unavailable. */
export function openSftp(
  client: Client,
  logger: Logger = nullLogger,
  timeoutMs = OPEN_SFTP_TIMEOUT_MS,
): Promise<SftpClient | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: SftpClient | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      client.sftp((err, sftp) => {
        if (settled) {
          try { sftp?.end(); } catch { /* ignore */ }
          return;
        }
        if (err || !sftp) {
          logger.debug("sftp channel unavailable", {
            err: err ? err.message : "no client",
          });
          finish(null);
          return;
        }
        finish(new SftpClient(sftp, logger));
      });
    } catch (err) {
      logger.debug("sftp channel unavailable", { err: message(err) });
      finish(null);
    }
  });
}

export class SftpClient implements SftpTransfer {
  private closed = false;

  constructor(
    private readonly sftp: SFTPWrapper,
    private readonly logger: Logger = nullLogger,
  ) {
    this.sftp.on("close", () => { this.closed = true; });
    this.sftp.on("error", () => { /* surfaced by individual operations */ });
  }

  get available(): boolean {
    return !this.closed;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.sftp.end(); } catch { /* ignore */ }
  }

  stat(remotePath: string): Promise<SftpStat> {
    return new Promise((resolve, reject) => {
      if (!this.available) return reject(new SftpUnavailableError());
      this.sftp.stat(remotePath, (err, st) => (
        err ? reject(err) : resolve(statFrom(st))
      ));
    });
  }

  lstat(remotePath: string): Promise<SftpStat> {
    return new Promise((resolve, reject) => {
      if (!this.available) return reject(new SftpUnavailableError());
      this.sftp.lstat(remotePath, (err, st) => (
        err ? reject(err) : resolve(statFrom(st))
      ));
    });
  }

  readdir(remotePath: string): Promise<Array<{ name: string; stat: SftpStat }>> {
    return new Promise((resolve, reject) => {
      if (!this.available) return reject(new SftpUnavailableError());
      this.sftp.readdir(remotePath, (err, list) => {
        if (err) return reject(err);
        resolve(list.map((entry: FileEntryWithStats) => ({
          name: entry.filename,
          stat: statFrom(entry.attrs),
        })));
      });
    });
  }

  mkdir(remotePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.available) return reject(new SftpUnavailableError());
      this.sftp.mkdir(remotePath, (err) => (err ? reject(err) : resolve()));
    });
  }

  async upload(
    src: Readable,
    remotePath: string,
    timeoutMs = 0,
  ): Promise<TransferOutcome> {
    if (!this.available) {
      return { bytes: 0, timedOut: false, error: new SftpUnavailableError() };
    }
    const timeout = timeoutMs > 0 ? timeoutMs : DEFAULT_TRANSFER_TIMEOUT_MS;
    const tmpPath = atomicRemotePath(remotePath);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(
      `transfer timed out after ${timeout}ms`,
    )), timeout);

    let handle: Buffer;
    try {
      handle = await openRemote(this.sftp, tmpPath, "w");
    } catch (err) {
      clearTimeout(timer);
      return {
        bytes: 0,
        timedOut: false,
        error: new Error(`create remote ${tmpPath}: ${message(err)}`),
      };
    }

    const ws = this.sftp.createWriteStream(tmpPath, { handle, autoClose: false });
    // Keep a listener for the stream's whole lifetime: ssh2 delivers late
    // "No response from server" errors to callbacks of requests that were
    // still in flight when the channel closed.
    const onStreamError = (): void => { /* surfaced by pump */ };
    ws.on("error", onStreamError);
    const onAbort = (): void => {
      try { ws.destroy(); } catch { /* ignore */ }
    };
    controller.signal.addEventListener("abort", onAbort, { once: true });
    let bytes = 0;
    let timedOut = false;
    let error: Error | undefined;
    try {
      bytes = await pumpToWritable(src, ws, controller.signal);
      await finishWritable(ws, controller.signal);
    } catch (err) {
      timedOut = controller.signal.aborted;
      const pump = err as PumpError;
      if (typeof pump.bytes === "number") bytes = pump.bytes;
      error = err instanceof Error ? err : new Error(String(err));
      try { ws.destroy(); } catch { /* ignore */ }
      await closeRemote(this.sftp, handle);
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", onAbort);
    }

    if (error) {
      await unlinkRemote(this.sftp, tmpPath);
      return { bytes, timedOut, error };
    }

    await fsyncRemote(this.sftp, handle);
    await closeRemote(this.sftp, handle);

    try {
      await posixRename(this.sftp, tmpPath, remotePath);
    } catch (err) {
      await unlinkRemote(this.sftp, tmpPath);
      const posixError = (err as { posixError?: Error }).posixError ?? err;
      return {
        bytes,
        timedOut: false,
        error: new Error(
          `rename ${tmpPath} -> ${remotePath}: ${message(err)} (posix: ${message(posixError)})`,
        ),
      };
    }
    this.logger.debug("sftp upload done", { remote: remotePath, bytes });
    return { bytes, timedOut: false };
  }

  async download(
    remotePath: string,
    dst: Writable,
    timeoutMs = 0,
    onBytes?: (bytes: number) => void,
  ): Promise<TransferOutcome> {
    if (!this.available) {
      return { bytes: 0, timedOut: false, error: new SftpUnavailableError() };
    }
    const timeout = timeoutMs > 0 ? timeoutMs : DEFAULT_TRANSFER_TIMEOUT_MS;
    // Pre-open the handle so "open remote" failures are visible before any
    // bytes flow, exactly like Go's `sftpClient.Open`.
    let handle: Buffer;
    try {
      handle = await openRemote(this.sftp, remotePath, "r");
    } catch (err) {
      return {
        bytes: 0,
        timedOut: false,
        error: new Error(`open remote ${remotePath}: ${message(err)}`),
      };
    }
    const src = this.sftp.createReadStream(remotePath, { handle, autoClose: true });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(
      `transfer timed out after ${timeout}ms`,
    )), timeout);
    // Deliberately never removed: see the upload path for why.
    const onError = (): void => { /* surfaced by pump */ };
    src.on("error", onError);
    const onAbort = (): void => {
      try { src.destroy(); } catch { /* ignore */ }
    };
    controller.signal.addEventListener("abort", onAbort, { once: true });
    try {
      const bytes = await pumpToWritable(src, dst, controller.signal, onBytes);
      return { bytes, timedOut: false };
    } catch (err) {
      const pump = err as PumpError;
      return {
        bytes: typeof pump.bytes === "number" ? pump.bytes : 0,
        timedOut: controller.signal.aborted,
        error: err instanceof Error ? err : new Error(String(err)),
      };
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", onAbort);
      try { src.destroy(); } catch { /* ignore */ }
    }
  }

  async downloadToFile(
    remotePath: string,
    localPath: string,
    timeoutMs = 0,
    onBytes?: (bytes: number) => void,
  ): Promise<TransferOutcome> {
    const tmpPath = localTempPath(localPath);
    let fh: Awaited<ReturnType<typeof open>>;
    try {
      fh = await open(tmpPath, "wx");
    } catch (err) {
      return {
        bytes: 0,
        timedOut: false,
        error: new Error(`create temp for ${localPath}: ${message(err)}`),
      };
    }
    const ws = fh.createWriteStream({ autoClose: false });
    let removed = false;
    const cleanup = async (): Promise<void> => {
      if (removed) return;
      removed = true;
      // Release the FileHandle's stream reference, or close() hangs forever.
      try { ws.destroy(); } catch { /* ignore */ }
      try { await fh.close(); } catch { /* ignore */ }
      try { await unlink(tmpPath); } catch { /* ignore */ }
    };
    try {
      const outcome = await this.download(remotePath, ws, timeoutMs, onBytes);
      try {
        await finishWritable(ws);
      } catch (err) {
        if (!outcome.error) {
          outcome.error = err instanceof Error ? err : new Error(String(err));
        }
      }
      try { ws.destroy(); } catch { /* ignore */ }
      if (outcome.error || outcome.timedOut) {
        await cleanup();
        return outcome;
      }
      try { await fh.close(); } catch { /* ignore */ }
      try {
        await rename(tmpPath, localPath);
      } catch (err) {
        await cleanup();
        return {
          bytes: outcome.bytes,
          timedOut: false,
          error: new Error(`rename temp -> ${localPath}: ${message(err)}`),
        };
      }
      removed = true;
      return outcome;
    } catch (err) {
      await cleanup();
      return {
        bytes: 0,
        timedOut: false,
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
  }
}
