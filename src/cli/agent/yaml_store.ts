import { promises as fs } from "node:fs";
import { parse, stringify } from "yaml";
import { writeFileAtomic, type AtomicWriteOptions } from "./backup.js";

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function loadYAMLMap(
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
    parsed = parse(data);
  } catch (err) {
    throw new Error(`parse ${filePath} as YAML: ${message(err)}`);
  }
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`parse ${filePath} as YAML: top level must be a mapping`);
  }
  return parsed as Record<string, unknown>;
}

export async function writeYAMLMapAtomic(
  filePath: string,
  value: Record<string, unknown>,
  options: AtomicWriteOptions,
): Promise<void> {
  let data: string;
  try {
    data = stringify(value, { lineWidth: 0 });
  } catch (err) {
    throw new Error(`marshal yaml: ${message(err)}`);
  }
  await writeFileAtomic(filePath, data, options);
}
