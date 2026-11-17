import { mkdir, open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_CONCURRENCY,
  SftpUnavailableError,
  emptyDirResult,
  isNoSuchFile,
  joinErrors,
  type ConflictPolicy,
  type DirTransferOptions,
  type DirTransferOutcome,
  type SftpStat,
  type SftpTransfer,
} from "./types.js";

type ConflictAction = "overwrite" | "skip" | "rename";

interface ResolvedConflict {
  path: string;
  action: ConflictAction;
}

interface FileTask {
  localPath: string;
  remotePath: string;
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function isMissingLocal(err: unknown): boolean {
  return (err as { code?: string }).code === "ENOENT";
}

/** Remote mkdir -p. Existing directories are not an error. */
export async function mkdirRemoteAll(
  backend: SftpTransfer,
  remotePath: string,
): Promise<void> {
  const norm = path.posix.normalize(remotePath);
  if (norm === "." || norm === "/" || norm === "") return;
  const parts = norm.split("/").filter(Boolean);
  let current = norm.startsWith("/") ? "/" : "";
  for (const part of parts) {
    current = current === "/" ? `/${part}` : current ? `${current}/${part}` : part;
    try {
      await backend.mkdir(current);
    } catch (err) {
      let existing: SftpStat | undefined;
      try {
        existing = await backend.stat(current);
      } catch {
        throw err;
      }
      if (!existing.isDirectory) throw err;
    }
  }
}

async function resolveRemoteConflict(
  backend: SftpTransfer,
  remotePath: string,
  policy: ConflictPolicy,
): Promise<ResolvedConflict> {
  if (policy === "overwrite") return { path: remotePath, action: "overwrite" };

  let exists = false;
  let statError: Error | undefined;
  try {
    await backend.stat(remotePath);
    exists = true;
  } catch (err) {
    if (isNoSuchFile(err)) exists = false;
    else statError = toError(err);
  }
  if (statError) throw statError;
  if (!exists) return { path: remotePath, action: "overwrite" };
  if (policy === "skip") return { path: remotePath, action: "skip" };

  const dir = path.posix.dirname(remotePath);
  const base = path.posix.basename(remotePath);
  const dot = base.lastIndexOf(".");
  const ext = dot >= 0 ? base.slice(dot) : "";
  const stem = dot >= 0 ? base.slice(0, dot) : base;
  for (let index = 1; ; index += 1) {
    const candidate = path.posix.join(dir, `${stem}_${index}${ext}`);
    try {
      await backend.stat(candidate);
    } catch (err) {
      if (isNoSuchFile(err)) return { path: candidate, action: "rename" };
      throw err;
    }
  }
}

async function resolveLocalConflict(
  localPath: string,
  policy: ConflictPolicy,
): Promise<ResolvedConflict> {
  if (policy === "overwrite") return { path: localPath, action: "overwrite" };

  let exists = false;
  let statError: Error | undefined;
  try {
    await stat(localPath);
    exists = true;
  } catch (err) {
    if (isMissingLocal(err)) exists = false;
    else statError = toError(err);
  }
  if (statError) throw statError;
  if (!exists) return { path: localPath, action: "overwrite" };
  if (policy === "skip") return { path: localPath, action: "skip" };

  const dir = path.dirname(localPath);
  const base = path.basename(localPath);
  const dot = base.lastIndexOf(".");
  const ext = dot >= 0 ? base.slice(dot) : "";
  const stem = dot >= 0 ? base.slice(0, dot) : base;
  for (let index = 1; ; index += 1) {
    const candidate = path.join(dir, `${stem}_${index}${ext}`);
    try {
      await stat(candidate);
    } catch (err) {
      if (isMissingLocal(err)) return { path: candidate, action: "rename" };
      throw err;
    }
  }
}

/** Run `fn` over `items` with at most `concurrency` in flight. */
async function runPool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Math.max(1, Math.min(concurrency, items.length || 1));
  await Promise.all(Array.from({ length: workers }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      await fn(items[index]!);
    }
  }));
}

function concurrencyOf(value: number | undefined): number {
  return value && value > 0 ? value : DEFAULT_CONCURRENCY;
}

/** Upload a local directory tree; symlinks are skipped and not counted. */
export async function uploadDir(
  backend: SftpTransfer,
  localDir: string,
  remoteDir: string,
  options: DirTransferOptions = {},
): Promise<DirTransferOutcome> {
  const result = emptyDirResult();
  if (!backend.available) {
    return { result, error: new SftpUnavailableError() };
  }

  let rootStat;
  try {
    rootStat = await stat(localDir);
  } catch (err) {
    return { result, error: toError(err) };
  }
  if (!rootStat.isDirectory()) {
    return { result, error: new Error("local path is not a directory") };
  }

  const conflict = options.conflict ?? "overwrite";
  const concurrency = concurrencyOf(options.concurrency);
  const errors: Error[] = [];

  try {
    await mkdirRemoteAll(backend, remoteDir);
  } catch (err) {
    errors.push(toError(err));
  }

  const tasks: FileTask[] = [];
  async function visit(dir: string, rel: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      errors.push(toError(err));
      return;
    }
    for (const entry of entries) {
      const localPath = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      const remotePath = path.posix.join(remoteDir, relPath);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        try {
          await mkdirRemoteAll(backend, remotePath);
        } catch (err) {
          errors.push(toError(err));
        }
        await visit(localPath, relPath);
      } else {
        tasks.push({ localPath, remotePath });
      }
    }
  }
  await visit(localDir, "");

  await runPool(tasks, concurrency, async (task) => {
    let fh;
    try {
      fh = await open(task.localPath, "r");
    } catch (err) {
      errors.push(toError(err));
      return;
    }
    let source;
    try {
      let resolved: ResolvedConflict;
      try {
        resolved = await resolveRemoteConflict(backend, task.remotePath, conflict);
      } catch (err) {
        errors.push(toError(err));
        return;
      }
      if (resolved.action === "skip") {
        result.skipped += 1;
        return;
      }
      if (resolved.action === "rename") result.renamed += 1;

      source = fh.createReadStream({ autoClose: true });
      let outcome;
      try {
        outcome = await backend.upload(source, resolved.path, options.timeoutMs ?? 0);
      } catch (err) {
        errors.push(toError(err));
        return;
      }
      if (outcome.error) {
        errors.push(outcome.error);
      } else {
        result.bytes += outcome.bytes;
        result.files += 1;
        options.onProgress?.(result.bytes, result.files);
      }
      if (outcome.timedOut) result.timedOut += 1;
    } finally {
      try { source?.destroy(); } catch { /* ignore */ }
      try { await fh.close(); } catch { /* the stream may have closed it */ }
    }
  });

  return { result, error: joinErrors(errors) };
}

/** Sum regular files under a remote tree; symlinks/errors are skipped. */
export async function remoteDirTotals(
  backend: SftpTransfer,
  remoteDir: string,
): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  async function visit(remotePath: string, known?: SftpStat): Promise<void> {
    let st = known;
    if (!st) {
      try {
        st = await backend.lstat(remotePath);
      } catch {
        return;
      }
    }
    if (st.isSymbolicLink) return;
    if (st.isDirectory) {
      let entries;
      try {
        entries = await backend.readdir(remotePath);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name === "." || entry.name === "..") continue;
        await visit(path.posix.join(remotePath, entry.name), entry.stat);
      }
      return;
    }
    bytes += st.size;
    files += 1;
  }
  await visit(remoteDir);
  return { bytes, files };
}

/** Download a remote directory tree; symlinks are skipped and not counted. */
export async function downloadDir(
  backend: SftpTransfer,
  remoteDir: string,
  localDir: string,
  options: DirTransferOptions = {},
): Promise<DirTransferOutcome> {
  const result = emptyDirResult();
  if (!backend.available) {
    return { result, error: new SftpUnavailableError() };
  }

  const conflict = options.conflict ?? "overwrite";
  const concurrency = concurrencyOf(options.concurrency);
  const errors: Error[] = [];
  const tasks: FileTask[] = [];

  async function visit(
    remotePath: string,
    rel: string,
    known?: SftpStat,
  ): Promise<void> {
    let st = known;
    if (!st) {
      try {
        st = await backend.lstat(remotePath);
      } catch (err) {
        errors.push(toError(err));
        return;
      }
    }
    if (st.isSymbolicLink) return;
    const localPath = rel ? path.join(localDir, rel) : localDir;
    if (st.isDirectory) {
      try {
        await mkdir(localPath, { recursive: true, mode: 0o755 });
      } catch (err) {
        errors.push(toError(err));
      }
      let entries;
      try {
        entries = await backend.readdir(remotePath);
      } catch (err) {
        errors.push(toError(err));
        return;
      }
      for (const entry of entries) {
        if (entry.name === "." || entry.name === "..") continue;
        await visit(
          path.posix.join(remotePath, entry.name),
          rel ? `${rel}/${entry.name}` : entry.name,
          entry.stat,
        );
      }
      return;
    }
    tasks.push({ localPath, remotePath });
  }
  await visit(remoteDir, "");

  await runPool(tasks, concurrency, async (task) => {
    let resolved: ResolvedConflict;
    try {
      resolved = await resolveLocalConflict(task.localPath, conflict);
    } catch (err) {
      errors.push(toError(err));
      return;
    }
    if (resolved.action === "skip") {
      result.skipped += 1;
      return;
    }
    if (resolved.action === "rename") result.renamed += 1;

    let outcome;
    try {
      outcome = await backend.downloadToFile(
        task.remotePath,
        resolved.path,
        options.timeoutMs ?? 0,
      );
    } catch (err) {
      errors.push(toError(err));
      return;
    }
    if (outcome.error) {
      errors.push(outcome.error);
    } else {
      result.bytes += outcome.bytes;
      result.files += 1;
      options.onProgress?.(result.bytes, result.files);
    }
    if (outcome.timedOut) result.timedOut += 1;
  });

  return { result, error: joinErrors(errors) };
}
