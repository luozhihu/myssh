import { VERSION } from "../../version.js";
import type { MCPEntry } from "./types.js";

/** npx-injected entry; --pin freezes the version instead of @latest. */
export function buildEntry(
  home: string,
  pin: boolean,
  version: string = VERSION,
): MCPEntry {
  return {
    command: "npx",
    args: ["-y", pin ? `myssh@${version}` : "myssh@latest", "mcp"],
    env: { SSHMNG_HOME: home },
  };
}

/** Doctor accepts either the rolling or the pinned entry. */
export function expectedEntries(
  home: string,
  version: string = VERSION,
): MCPEntry[] {
  return [buildEntry(home, false, version), buildEntry(home, true, version)];
}

export function expectedHome(entry: MCPEntry): string {
  return entry.env.SSHMNG_HOME ?? "";
}
