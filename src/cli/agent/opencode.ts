import { promises as fs } from "node:fs";
import path from "node:path";
import { backupFile } from "./backup.js";
import { expectedHome } from "./entry.js";
import { loadJSONMap, mergeEntry, writeJSONMapAtomic } from "./json_store.js";
import type { AgentContext, AgentInjector, MCPEntry } from "./types.js";

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sliceEqual(got: unknown, want: string[]): boolean {
  if (!Array.isArray(got)) return want.length === 0;
  if (got.length !== want.length) return false;
  return got.every((value, index) => value === want[index]);
}

export class OpenCodeInjector implements AgentInjector {
  readonly name = "opencode";
  readonly displayName = "OpenCode";

  configPath(ctx: AgentContext): string {
    return path.join(ctx.homeDir, ".config", "opencode", "opencode.json");
  }

  async detect(ctx: AgentContext): Promise<{ path: string; installed: boolean }> {
    const path = this.configPath(ctx);
    try {
      await fs.stat(path);
      return { path, installed: true };
    } catch {
      return { path, installed: false };
    }
  }

  private entryMap(entry: MCPEntry): Record<string, unknown> {
    return {
      type: "local",
      command: [entry.command, ...entry.args],
      environment: entry.env,
      enabled: true,
    };
  }

  async inject(path: string, entry: MCPEntry): Promise<void> {
    try {
      await backupFile(path);
    } catch (err) {
      throw new Error(`backup: ${message(err)}`);
    }
    const root = await loadJSONMap(path);
    mergeEntry(root, "mcp", this.entryMap(entry));
    await writeJSONMapAtomic(path, root, { tempPrefix: ".agent.json.tmp" });
    try {
      await loadJSONMap(path);
    } catch (err) {
      throw new Error(`post-write verify: ${message(err)}`);
    }
  }

  async verify(path: string, expected: MCPEntry): Promise<Error | undefined> {
    let root: Record<string, unknown>;
    try {
      root = await loadJSONMap(path);
    } catch (err) {
      return err as Error;
    }
    const servers = root.mcp;
    if (servers === null || typeof servers !== "object") {
      return new Error(`no mcp key in ${path}`);
    }
    const entry = (servers as Record<string, unknown>).sshmng;
    if (entry === null || typeof entry !== "object") {
      return new Error("no sshmng entry in mcp");
    }
    const record = entry as Record<string, unknown>;
    if (!Array.isArray(record.command)) {
      return new Error("sshmng.command is not an array");
    }
    if (record.command.length === 0) {
      return new Error("sshmng.command array is empty");
    }
    const [first, ...rest] = record.command as unknown[];
    if (first !== expected.command) {
      return new Error(
        `stale: expected command[0] ${JSON.stringify(expected.command)}, got ${JSON.stringify(first)}`,
      );
    }
    const restStrings = rest.map((value) => (typeof value === "string" ? value : ""));
    if (!sliceEqual(restStrings, expected.args)) {
      return new Error(
        `stale: expected command args ${JSON.stringify(expected.args)}, got ${String(JSON.stringify(restStrings))}`,
      );
    }
    const env = record.environment;
    const home = env !== null && typeof env === "object"
      ? (env as Record<string, unknown>).SSHMNG_HOME
      : undefined;
    if (home !== expectedHome(expected)) {
      return new Error(
        `stale: expected environment.SSHMNG_HOME ${JSON.stringify(expectedHome(expected))}, got ${String(JSON.stringify(home))}`,
      );
    }
    return undefined;
  }
}
