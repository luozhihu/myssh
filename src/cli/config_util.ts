import path from "node:path";
import { Store, resolveConfigPath } from "../config/store.js";
import type { Config } from "../config/types.js";

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function loadConfigForCli(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<{ path: string; cfg: Config }> {
  const configPath = resolveConfigPath(explicit, env);
  try {
    return { path: configPath, cfg: await new Store(configPath).load() };
  } catch (err) {
    throw new Error(`load config ${configPath}: ${message(err)}`);
  }
}

/** known_hosts lives next to the config file. */
export function knownHostsPathFor(configPath: string): string {
  return path.join(path.dirname(configPath), "known_hosts");
}
