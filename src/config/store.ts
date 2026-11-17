import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseLogLevel } from "./log_level.js";
import type { Config } from "./types.js";
import { resolveReferences } from "./validate.js";

export function resolveConfigPath(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (explicit) {
    return explicit;
  }
  if (env.SSHMNG_HOME) {
    return path.join(env.SSHMNG_HOME, "config.json");
  }
  return path.join(homedir(), ".sshmng", "config.json");
}

export function defaultConfig(): Config {
  return {
    version: "1",
    idle_timeout_s: 300,
    auto_update_enabled: true,
    jumphosts: [],
    proxies: [],
    servers: [],
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function normalizeConfig(cfg: Config): Config {
  if (!cfg.version) {
    throw new Error('missing "version" field');
  }
  if (!cfg.idle_timeout_s) {
    cfg.idle_timeout_s = 300;
  }
  parseLogLevel(cfg.log_level);
  cfg.jumphosts ??= [];
  cfg.proxies ??= [];
  cfg.servers ??= [];
  resolveReferences(cfg);
  return cfg;
}

export class Store {
  constructor(readonly path: string) {}

  async load(): Promise<Config> {
    let info;
    try {
      info = await fs.stat(this.path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return defaultConfig();
      }
      throw new Error(`stat config: ${errorMessage(err)}`);
    }
    if (process.platform !== "win32") {
      const perm = info.mode & 0o777;
      if (perm & 0o077) {
        throw new Error(
          `config file permissions too open: ${perm.toString(8)}, want 0600 or stricter (no group/other access)`,
        );
      }
    }
    let data: string;
    try {
      data = await fs.readFile(this.path, "utf8");
    } catch (err) {
      throw new Error(`read config: ${errorMessage(err)}`);
    }
    let parsed: Config;
    try {
      parsed = JSON.parse(data) as Config;
    } catch (err) {
      throw new Error(`parse config: ${errorMessage(err)}`);
    }
    try {
      return normalizeConfig(parsed);
    } catch (err) {
      throw new Error(`parse config: ${errorMessage(err)}`);
    }
  }

  async save(cfg: Config): Promise<void> {
    const data = JSON.stringify(cfg, null, 2);
    const dir = path.dirname(this.path);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(
      dir,
      `.config.json.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`,
    );
    try {
      await fs.writeFile(tmp, data, { mode: 0o600 });
      await fs.chmod(tmp, 0o600);
      await fs.rename(tmp, this.path);
    } catch (err) {
      await fs.rm(tmp, { force: true });
      if (process.platform === "win32") {
        try {
          await fs.writeFile(this.path, data, { mode: 0o600 });
          return;
        } catch (fallbackErr) {
          throw new Error(
            `rename temp to config: ${errorMessage(err)} (fallback write also failed: ${errorMessage(fallbackErr)})`,
          );
        }
      }
      throw new Error(`rename temp to config: ${errorMessage(err)}`);
    }
  }
}
