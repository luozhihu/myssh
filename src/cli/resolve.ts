import { listJumphosts, listSSHServers } from "../config/crud.js";
import type { Config, Jumphost, SSHServer } from "../config/types.js";

export interface ResolverIO {
  err(text: string): void;
  readLine(): Promise<string | null>;
}

function q(value: string): string {
  return JSON.stringify(value);
}

async function promptChoice<T extends { name: string; addr: string; tags?: string[] }>(
  matches: T[],
  noun: "servers" | "jumphosts",
  io: ResolverIO,
): Promise<T> {
  io.err(`Multiple ${noun} match:\n`);
  matches.forEach((item, index) => {
    const tags = (item.tags ?? []).join(",");
    io.err(
      `  [${index + 1}] ${item.name.padEnd(20)} ${item.addr.padEnd(25)} ${tags}\n`,
    );
  });
  io.err(`Select [1-${matches.length}]: `);
  const line = await io.readLine();
  if (line === null) throw new Error("no selection (EOF)");
  const input = line.trim();
  const index = Number(input);
  if (!Number.isInteger(index) || index < 1 || index > matches.length) {
    throw new Error(`invalid selection ${q(input)} (expected 1-${matches.length})`);
  }
  return matches[index - 1]!;
}

export async function resolveServer(
  cfg: Config,
  query: string,
  allowPrompt: boolean,
  io: ResolverIO,
): Promise<SSHServer> {
  const exact = cfg.servers.find((server) => server.name === query);
  if (exact) return exact;

  const matches = listSSHServers(cfg, query);
  if (matches.length === 0) throw new Error(`no server matches ${q(query)}`);
  if (matches.length === 1) {
    io.err(`matched: ${matches[0]!.name}\n`);
    return matches[0]!;
  }
  if (!allowPrompt) {
    throw new Error(
      `multiple servers match ${q(query)}: ${matches.map((m) => m.name).join(", ")}; specify exact name`,
    );
  }
  return promptChoice(matches, "servers", io);
}

export async function resolveJumphost(
  cfg: Config,
  query: string,
  allowPrompt: boolean,
  io: ResolverIO,
): Promise<Jumphost> {
  const exact = cfg.jumphosts.find((jump) => jump.name === query);
  if (exact) return exact;

  const matches = listJumphosts(cfg, query);
  if (matches.length === 0) throw new Error(`no jumphost matches ${q(query)}`);
  if (matches.length === 1) {
    io.err(`matched: ${matches[0]!.name}\n`);
    return matches[0]!;
  }
  if (!allowPrompt) {
    throw new Error(
      `multiple jumphosts match ${q(query)}: ${matches.map((m) => m.name).join(", ")}; specify exact name`,
    );
  }
  return promptChoice(matches, "jumphosts", io);
}

export type SSHTarget =
  | { kind: "server"; server: SSHServer }
  | { kind: "jumphost"; jump: Jumphost };

/** Server names take precedence; fall back to direct jumphost login. */
export async function resolveTarget(
  cfg: Config,
  query: string,
  allowPrompt: boolean,
  io: ResolverIO,
): Promise<SSHTarget> {
  try {
    return { kind: "server", server: await resolveServer(cfg, query, allowPrompt, io) };
  } catch {
    try {
      return { kind: "jumphost", jump: await resolveJumphost(cfg, query, allowPrompt, io) };
    } catch {
      throw new Error(`no server or jumphost matches ${q(query)}`);
    }
  }
}
