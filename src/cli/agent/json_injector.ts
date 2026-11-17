import { promises as fs } from "node:fs";
import path from "node:path";
import { backupFile } from "./backup.js";
import { argsEqual, loadJSONMap, mergeEntry, writeJSONMapAtomic } from "./json_store.js";
import { expectedHome } from "./entry.js";
import type { AgentInjector, MCPEntry } from "./types.js";

export interface JsonInjectorOptions {
  name: string;
  displayName: string;
  /** e.g. ".claude.json"; resolved under homeDir. */
  file: string | ((ctx: { homeDir: string }) => string);
  topKey: string;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Shared implementation for Claude Code and CodeAgent (identical schema). */
export class JsonInjector implements AgentInjector {
  readonly name: string;
  readonly displayName: string;
  private readonly file: JsonInjectorOptions["file"];
  private readonly topKey: string;

  constructor(options: JsonInjectorOptions) {
    this.name = options.name;
    this.displayName = options.displayName;
    this.file = options.file;
    this.topKey = options.topKey;
  }

  configPath(ctx: { homeDir: string }): string {
    return typeof this.file === "function" ? this.file(ctx) : path.join(ctx.homeDir, this.file);
  }

  async detect(ctx: { homeDir: string }): Promise<{ path: string; installed: boolean }> {
    const path = this.configPath(ctx);
    try {
      await fs.stat(path);
      return { path, installed: true };
    } catch {
      return { path, installed: false };
    }
  }

  private entryMap(entry: MCPEntry): Record<string, unknown> {
    return { command: entry.command, args: entry.args, env: entry.env };
  }

  async inject(path: string, entry: MCPEntry): Promise<void> {
    try {
      await backupFile(path);
    } catch (err) {
      throw new Error(`backup: ${message(err)}`);
    }
    const root = await loadJSONMap(path);
    mergeEntry(root, this.topKey, this.entryMap(entry));
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
    const servers = root[this.topKey];
    if (servers === null || typeof servers !== "object") {
      return new Error(`no ${this.topKey} key in ${path}`);
    }
    const entry = (servers as Record<string, unknown>).sshmng;
    if (entry === null || typeof entry !== "object") {
      return new Error(`no sshmng entry in ${this.topKey}`);
    }
    const record = entry as Record<string, unknown>;
    const command = typeof record.command === "string" ? record.command : "";
    if (command !== expected.command) {
      return new Error(`stale: expected command ${JSON.stringify(expected.command)}, got ${JSON.stringify(command)}`);
    }
    if (!argsEqual(record.args, expected.args)) {
      return new Error(`stale: expected args ${JSON.stringify(expected.args)}, got ${String(JSON.stringify(record.args))}`);
    }
    const env = record.env;
    const home = env !== null && typeof env === "object"
      ? (env as Record<string, unknown>).SSHMNG_HOME
      : undefined;
    if (home !== expectedHome(expected)) {
      return new Error(
        `stale: expected env.SSHMNG_HOME ${JSON.stringify(expectedHome(expected))}, got ${String(JSON.stringify(home))}`,
      );
    }
    return undefined;
  }
}
