import { HermesInjector } from "./hermes.js";
import { JsonInjector } from "./json_injector.js";
import { OpenCodeInjector } from "./opencode.js";
import type { AgentContext, AgentInjector, MCPEntry } from "./types.js";

/** Canonical order used by install and doctor. */
export function createInjectors(_ctx: AgentContext): AgentInjector[] {
  return [
    new JsonInjector({
      name: "claude-code",
      displayName: "Claude Code",
      file: ".claude.json",
      topKey: "mcpServers",
    }),
    new JsonInjector({
      name: "codeagent",
      displayName: "CodeAgent",
      file: ".cac.json",
      topKey: "mcpServers",
    }),
    new HermesInjector(),
    new OpenCodeInjector(),
  ];
}

/** Pass when any expected entry verifies; otherwise return the first error. */
export async function verifyAny(
  injector: AgentInjector,
  path: string,
  expected: MCPEntry[],
): Promise<Error | undefined> {
  let first: Error | undefined;
  for (const entry of expected) {
    const err = await injector.verify(path, entry);
    if (!err) return undefined;
    first ??= err;
  }
  return first;
}
