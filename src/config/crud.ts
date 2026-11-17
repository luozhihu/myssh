import type { Config, Jumphost, Proxy, SSHServer } from "./types.js";
import { revalidate } from "./validate.js";

function q(value: string): string {
  return JSON.stringify(value);
}

function fields(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

function matchesQuery(query: string, name: string, addr: string, tags: string[] | undefined): boolean {
  const keywords = fields(query);
  if (keywords.length === 0) {
    return true;
  }
  const n = name.toLowerCase();
  const a = addr.toLowerCase();
  const t = (tags ?? []).map((tag) => tag.toLowerCase());
  return keywords.every((kw) => n.includes(kw) || a.includes(kw) || t.some((tag) => tag.includes(kw)));
}

export function listSSHServers(cfg: Config, query: string): SSHServer[] {
  return cfg.servers.filter((s) => matchesQuery(query, s.name, s.addr, s.tags));
}

export function listJumphosts(cfg: Config, query: string): Jumphost[] {
  return cfg.jumphosts.filter((j) => matchesQuery(query, j.name, j.addr, j.tags));
}

export function listProxies(cfg: Config, query: string): Proxy[] {
  return cfg.proxies.filter((p) => matchesQuery(query, p.name, p.addr, p.tags));
}

export function getSSHServer(cfg: Config, name: string): SSHServer {
  const found = cfg.servers.find((s) => s.name === name);
  if (!found) {
    throw new Error(`ssh server ${q(name)} not found`);
  }
  return found;
}

export function getJumphost(cfg: Config, name: string): Jumphost {
  const found = cfg.jumphosts.find((j) => j.name === name);
  if (!found) {
    throw new Error(`jumphost ${q(name)} not found`);
  }
  return found;
}

export function getProxy(cfg: Config, name: string): Proxy {
  const found = cfg.proxies.find((p) => p.name === name);
  if (!found) {
    throw new Error(`proxy ${q(name)} not found`);
  }
  return found;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function goType(value: unknown): string {
  if (value === null) return "<nil>";
  if (Array.isArray(value)) return "[]interface {}";
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "float64";
    case "boolean":
      return "bool";
    case "object":
      return "map[string]interface {}";
    default:
      return typeof value;
  }
}

function mergeMaps(
  original: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...original };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete result[key];
      continue;
    }
    if (isPlainObject(value)) {
      const current = result[key];
      result[key] = mergeMaps(isPlainObject(current) ? current : {}, value);
      continue;
    }
    result[key] = value;
  }
  return result;
}

export function mergePatch(original: unknown, patch: unknown): Record<string, unknown> {
  if (!isPlainObject(patch)) {
    throw new Error(`patch must be object or null, got ${goType(patch)}`);
  }
  const base = isPlainObject(original) ? original : {};
  return mergeMaps(base, patch);
}

function updateList<T extends { name: string }>(
  items: T[],
  name: string,
  patch: unknown,
  validate: () => void,
): void {
  if (patch === null) {
    const index = items.findIndex((item) => item.name === name);
    if (index < 0) {
      return;
    }
    const original = items.slice();
    items.splice(index, 1);
    try {
      validate();
    } catch (err) {
      items.splice(0, items.length, ...original);
      throw err;
    }
    return;
  }
  const index = items.findIndex((item) => item.name === name);
  const original = index >= 0 ? structuredClone(items[index]) : undefined;
  let merged: Record<string, unknown>;
  try {
    merged = mergePatch(original, patch);
  } catch (err) {
    throw new Error(`merge patch: ${err instanceof Error ? err.message : String(err)}`);
  }
  merged.name = name;
  const next = merged as unknown as T;
  if (index >= 0) {
    items[index] = next;
  } else {
    items.push(next);
  }
  try {
    validate();
  } catch (err) {
    if (index >= 0 && original) {
      items[index] = original;
    } else {
      items.pop();
    }
    throw err;
  }
}

export function updateSSHServer(cfg: Config, name: string, patch: unknown): void {
  updateList(cfg.servers, name, patch, () => revalidate(cfg));
}

export function updateJumphost(cfg: Config, name: string, patch: unknown): void {
  updateList(cfg.jumphosts, name, patch, () => revalidate(cfg));
}

export function updateProxy(cfg: Config, name: string, patch: unknown): void {
  updateList(cfg.proxies, name, patch, () => revalidate(cfg));
}
