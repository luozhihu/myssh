import { promises as fs } from "node:fs";
import path from "node:path";
import { backupFile } from "./backup.js";
import { expectedHome } from "./entry.js";
import { argsEqual, mergeEntry } from "./json_store.js";
import { loadYAMLMap, writeYAMLMapAtomic } from "./yaml_store.js";
import type { AgentContext, AgentInjector, MCPEntry } from "./types.js";

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class HermesInjector implements AgentInjector {
  readonly name = "hermes";
  readonly displayName = "Hermes Agent";

  configPath(ctx: AgentContext): string {
    if (ctx.platform === "win32") {
      const localAppData = ctx.env.LOCALAPPDATA
        || path.win32.join(ctx.env.USERPROFILE ?? ctx.homeDir, "AppData", "Local");
      return path.win32.join(localAppData, "hermes", "config.yaml");
    }
    return path.join(ctx.homeDir, ".hermes", "config.yaml");
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
    return { command: entry.command, args: entry.args, env: entry.env };
  }

  async inject(path: string, entry: MCPEntry): Promise<void> {
    try {
      await backupFile(path);
    } catch (err) {
      throw new Error(`backup: ${message(err)}`);
    }
    const root = await loadYAMLMap(path);
    mergeEntry(root, "mcp_servers", this.entryMap(entry));
    await writeYAMLMapAtomic(path, root, { tempPrefix: ".agent.yaml.tmp" });
    try {
      await loadYAMLMap(path);
    } catch (err) {
      throw new Error(`post-write verify: ${message(err)}`);
    }
  }

  async verify(path: string, expected: MCPEntry): Promise<Error | undefined> {
    let root: Record<string, unknown>;
    try {
      root = await loadYAMLMap(path);
    } catch (err) {
      return err as Error;
    }
    const servers = root.mcp_servers;
    if (servers === null || typeof servers !== "object") {
      return new Error(`no mcp_servers key in ${path}`);
    }
    const entry = (servers as Record<string, unknown>).sshmng;
    if (entry === null || typeof entry !== "object") {
      return new Error("no sshmng entry in mcp_servers");
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
