import { promises as fs } from "node:fs";
import { writeFileAtomic, type AtomicWriteOptions } from "./backup.js";

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function loadJSONMap(
  filePath: string,
): Promise<Record<string, unknown>> {
  let data: string;
  try {
    data = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`read ${filePath}: ${message(err)}`);
  }
  if (data.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch (err) {
    throw new Error(`parse ${filePath} as JSON: ${message(err)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`parse ${filePath} as JSON: top level must be an object`);
  }
  return parsed as Record<string, unknown>;
}

export async function writeJSONMapAtomic(
  filePath: string,
  value: Record<string, unknown>,
  options: AtomicWriteOptions,
): Promise<void> {
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, options);
}

export function mergeEntry(
  root: Record<string, unknown>,
  topKey: string,
  entry: Record<string, unknown>,
): void {
  const current = root[topKey];
  const servers = current !== null && typeof current === "object" && !Array.isArray(current)
    ? { ...(current as Record<string, unknown>) }
    : {};
  servers.sshmng = entry;
  root[topKey] = servers;
}

export function argsEqual(got: unknown, want: string[]): boolean {
  if (!Array.isArray(got)) return want.length === 0;
  if (got.length !== want.length) return false;
  return got.every((value, index) => value === want[index]);
}
