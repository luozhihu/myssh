import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export async function tempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "myssh-test-"));
  return {
    dir,
    cleanup: async () => { await rm(dir, { recursive: true, force: true }); },
  };
}

export async function writeConfig(dir: string, value: unknown): Promise<string> {
  const file = path.join(dir, "config.json");
  await writeFile(file, JSON.stringify(value, null, 2), { mode: 0o600 });
  return file;
}
