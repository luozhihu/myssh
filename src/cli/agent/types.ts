import type { Logger } from "../../log.js";

export interface MCPEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface AgentContext {
  homeDir: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  logger?: Logger;
}

export interface Detection {
  path: string;
  installed: boolean;
}

export interface AgentInjector {
  readonly name: string;
  readonly displayName: string;
  configPath(ctx: AgentContext): string;
  detect(ctx: AgentContext): Promise<Detection>;
  inject(path: string, entry: MCPEntry): Promise<void>;
  /** Returns undefined when the entry matches; otherwise the first mismatch. */
  verify(path: string, expected: MCPEntry): Promise<Error | undefined>;
}
