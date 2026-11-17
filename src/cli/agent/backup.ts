import { promises as fs } from "node:fs";
import path from "node:path";

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** Local-time YYYYMMDD-HHMMSS, matching Go's 20060102-150405. */
export function backupStamp(now: Date = new Date()): string {
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("");
}

/** Copy path to <path>.bak.<stamp>; missing file is a no-op. */
export async function backupFile(filePath: string, now: Date = new Date()): Promise<void> {
  let data: Buffer;
  try {
    data = await fs.readFile(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(`stat ${filePath}: ${message(err)}`);
  }
  const backupPath = `${filePath}.bak.${backupStamp(now)}`;
  try {
    await fs.writeFile(backupPath, data, { mode: 0o600 });
  } catch (err) {
    throw new Error(`write backup ${backupPath}: ${message(err)}`);
  }
}

/** Restore path from the newest <path>.bak.* sibling (Windows rename fallback). */
export async function restoreFromBackup(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  const prefix = `${path.basename(filePath)}.bak.`;
  let names: string[];
  try {
    names = (await fs.readdir(dir)).filter((name) => name.startsWith(prefix));
  } catch (err) {
    throw new Error(`glob backups: ${message(err)}`);
  }
  if (names.length === 0) {
    throw new Error(`no backup found matching ${filePath}.bak.*`);
  }
  let newest = names[0]!;
  let newestTime = 0;
  for (const name of names) {
    const info = await fs.stat(path.join(dir, name));
    if (info.mtimeMs > newestTime) {
      newest = name;
      newestTime = info.mtimeMs;
    }
  }
  const source = path.join(dir, newest);
  const data = await fs.readFile(source);
  await fs.writeFile(filePath, data, {
    mode: process.platform === "win32" ? 0o644 : 0o600,
  });
}

export interface AtomicWriteOptions {
  tempPrefix: string;
  platform?: NodeJS.Platform;
}

/** Temp file in the same dir, chmod 0600, rename; Windows remove-retry. */
export async function writeFileAtomic(
  filePath: string,
  data: string,
  options: AtomicWriteOptions,
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const dir = path.dirname(filePath);
  try {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    throw new Error(`mkdir ${dir}: ${message(err)}`);
  }
  const suffix = `${process.pid}-${Date.now()}`;
  const tempPath = path.join(dir, `${options.tempPrefix}.${suffix}`);
  try {
    await fs.writeFile(tempPath, data, { mode: 0o600 });
    if (platform !== "win32") await fs.chmod(tempPath, 0o600);
  } catch (err) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw new Error(`write temp: ${message(err)}`);
  }
  try {
    await fs.rename(tempPath, filePath);
    return;
  } catch (err) {
    if (platform !== "win32") {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
      throw new Error(
        `rename temp to ${filePath}: ${message(err)} (backup at ${filePath}.bak.<ts> if exists)`,
      );
    }
    try {
      await fs.rm(filePath, { force: true });
      await fs.rename(tempPath, filePath);
      return;
    } catch (retryErr) {
      let restore = "ok";
      try {
        await restoreFromBackup(filePath);
      } catch (restoreErr) {
        restore = message(restoreErr);
      }
      throw new Error(
        `rename temp to ${filePath}: ${message(retryErr)} (restore from backup: ${restore}; backup at ${filePath}.bak.<ts>)`,
      );
    }
  }
}
