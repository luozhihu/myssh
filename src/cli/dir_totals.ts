import { readdir, stat } from "node:fs/promises";
import path from "node:path";

/** Local-tree totals for the upload-dir progress bar (Go localDirTotals). */
export async function localDirTotals(
  dir: string,
): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  let root;
  try {
    root = await stat(dir);
  } catch {
    return { bytes: 0, files: 0 };
  }
  if (!root.isDirectory()) return { bytes: root.size, files: 1 };

  async function visit(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(full);
        continue;
      }
      try {
        bytes += (await stat(full)).size;
        files += 1;
      } catch {
        /* unreadable entries are skipped, matching filepath.Walk tolerance */
      }
    }
  }
  await visit(dir);
  return { bytes, files };
}
