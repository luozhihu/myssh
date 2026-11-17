import { packageSpec } from "../../pkg.js";
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
    args: ["-y", packageSpec(pin, version), "mcp"],
    env: { SSHMNG_HOME: home },
  };
}

/** Entry for a globally installed binary; `myssh install --local` uses this. */
export function buildLocalEntry(home: string, command = "myssh"): MCPEntry {
  return {
    command,
    args: ["mcp"],
    env: { SSHMNG_HOME: home },
  };
}

/** Doctor accepts the rolling/pinned npx entries and the local global command. */
export function expectedEntries(
  home: string,
  version: string = VERSION,
): MCPEntry[] {
  return [
    buildEntry(home, false, version),
    buildEntry(home, true, version),
    buildLocalEntry(home),
  ];
}

export function expectedHome(entry: MCPEntry): string {
  return entry.env.SSHMNG_HOME ?? "";
}
