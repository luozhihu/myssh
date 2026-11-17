import {
  getJumphost,
  getProxy,
  getSSHServer,
  listJumphosts,
  listProxies,
  listSSHServers,
} from "../config/crud.js";
import { Store, resolveConfigPath } from "../config/store.js";
import type { Config, Jumphost, Proxy, SSHAuth, SSHServer } from "../config/types.js";
import type { IO } from "./io.js";
import { takeConfigFlag } from "./flags.js";

type EntityType = "server" | "jumphost" | "proxy";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function load(configPath: string | undefined): Promise<Config> {
  const path = resolveConfigPath(configPath);
  try {
    return await new Store(path).load();
  } catch (err) {
    throw new Error(`load config ${path}: ${errorMessage(err)}`);
  }
}

export async function runEntityCmd(et: EntityType, args: string[], io: IO): Promise<number> {
  if (args.length === 0) {
    io.out(`Usage: sshmng ${et} <list|get> [...]\n`);
    return 2;
  }
  if (args[0] === "list") {
    return runEntityList(et, args.slice(1), io);
  }
  if (args[0] === "get") {
    return runEntityGet(et, args.slice(1), io);
  }
  io.out(`Unknown ${et} subcommand ${JSON.stringify(args[0])}. Use 'list' or 'get'.\n`);
  return 2;
}

async function runEntityList(et: EntityType, args: string[], io: IO): Promise<number> {
  let parsed: { config?: string; rest: string[] };
  try {
    parsed = takeConfigFlag(args);
  } catch (err) {
    io.out(`Error: ${errorMessage(err)}\n`);
    return 2;
  }
  const query = parsed.rest.join(" ");
  let cfg: Config;
  try {
    cfg = await load(parsed.config);
  } catch (err) {
    io.out(`Error: ${errorMessage(err)}\n`);
    return 1;
  }
  switch (et) {
    case "server":
      printServerList(listSSHServers(cfg, query), io);
      break;
    case "jumphost":
      printJumphostList(listJumphosts(cfg, query), io);
      break;
    case "proxy":
      printProxyList(listProxies(cfg, query), io);
      break;
  }
  return 0;
}

async function runEntityGet(et: EntityType, args: string[], io: IO): Promise<number> {
  let parsed: { config?: string; rest: string[] };
  try {
    parsed = takeConfigFlag(args);
  } catch (err) {
    io.out(`Error: ${errorMessage(err)}\n`);
    return 2;
  }
  if (parsed.rest.length !== 1) {
    io.out(`Usage: sshmng ${et} get <name>\n`);
    if (parsed.rest.length > 1) {
      io.out(`Error: expected exactly one name, got ${parsed.rest.length} (${parsed.rest.join(" ")})\n`);
    }
    return 2;
  }
  const name = parsed.rest[0]!;
  let cfg: Config;
  try {
    cfg = await load(parsed.config);
  } catch (err) {
    io.out(`Error: ${errorMessage(err)}\n`);
    return 1;
  }
  try {
    switch (et) {
      case "server":
        printServerDetail(getSSHServer(cfg, name), io);
        break;
      case "jumphost":
        printJumphostDetail(getJumphost(cfg, name), io);
        break;
      case "proxy":
        printProxyDetail(getProxy(cfg, name), io);
        break;
    }
  } catch (err) {
    io.out(`Error: ${errorMessage(err)}\n`);
    return 1;
  }
  return 0;
}

function pad(value: string, width: number): string {
  return value.padEnd(width);
}

function printServerList(items: SSHServer[], io: IO): void {
  if (items.length === 0) {
    io.out("No servers found.\n");
    return;
  }
  io.out(`${pad("NAME", 20)} ${pad("ADDR", 25)} ${pad("VIA", 15)} ${pad("PROXY", 15)} TAGS\n`);
  for (const s of items) {
    io.out(
      `${pad(s.name, 20)} ${pad(s.addr, 25)} ${pad(s.via ?? "-", 15)} ${pad(s.proxy ?? "-", 15)} ${(s.tags ?? []).join(",")}\n`,
    );
  }
}

function printJumphostList(items: Jumphost[], io: IO): void {
  if (items.length === 0) {
    io.out("No jumphosts found.\n");
    return;
  }
  io.out(`${pad("NAME", 20)} ${pad("ADDR", 25)} ${pad("SSH_J", 10)} ${pad("VIA", 15)} ${pad("PROXY", 15)} TAGS\n`);
  for (const j of items) {
    io.out(
      `${pad(j.name, 20)} ${pad(j.addr, 25)} ${pad(String(j.ssh_j), 10)} ${pad(j.via ?? "-", 15)} ${pad(j.proxy ?? "-", 15)} ${(j.tags ?? []).join(",")}\n`,
    );
  }
}

function printProxyList(items: Proxy[], io: IO): void {
  if (items.length === 0) {
    io.out("No proxies found.\n");
    return;
  }
  io.out(`${pad("NAME", 20)} ${pad("TYPE", 10)} ${pad("ADDR", 25)} ${pad("AUTH", 6)} TAGS\n`);
  for (const p of items) {
    const auth = p.auth && (p.auth.user || p.auth.password) ? "yes" : "-";
    io.out(`${pad(p.name, 20)} ${pad(p.type, 10)} ${pad(p.addr, 25)} ${pad(auth, 6)} ${(p.tags ?? []).join(",")}\n`);
  }
}

function redactAuth(auth: SSHAuth): string {
  const parts: string[] = [];
  if (auth.password) parts.push("password=***");
  if (auth.private_key) parts.push("private_key=***");
  if (auth.passphrase) parts.push("passphrase=***");
  return parts.length > 0 ? parts.join(", ") : "(none)";
}

function boolDesc(value: boolean | undefined): string {
  return value === undefined ? "true (default)" : String(value);
}

function flowDesc(length: number, entry: string | undefined): string {
  return length === 0 ? "(none)" : `${length} actions, entry=${JSON.stringify(entry ?? "")}`;
}

function printServerDetail(s: SSHServer, io: IO): void {
  io.out(`Name:           ${s.name}\n`);
  io.out(`Addr:           ${s.addr}\n`);
  io.out(`User:           ${s.user}\n`);
  io.out(`Auth:           ${redactAuth(s.auth)}\n`);
  io.out(`Via:            ${s.via ?? "-"}\n`);
  io.out(`Proxy:          ${s.proxy ?? "-"}\n`);
  io.out(`Tags:           ${(s.tags ?? []).join(", ")}\n`);
  io.out(`HostKeyVerify:  ${boolDesc(s.host_key_verify)}\n`);
  io.out(`LoginFlow:      ${flowDesc(Object.keys(s.login_flow ?? {}).length, s.login_entry)}\n`);
}

function printJumphostDetail(j: Jumphost, io: IO): void {
  io.out(`Name:           ${j.name}\n`);
  io.out(`Addr:           ${j.addr}\n`);
  io.out(`User:           ${j.user}\n`);
  io.out(`Auth:           ${redactAuth(j.auth)}\n`);
  io.out(`SSH_J:          ${j.ssh_j}\n`);
  io.out(`Via:            ${j.via ?? "-"}\n`);
  io.out(`Proxy:          ${j.proxy ?? "-"}\n`);
  io.out(`Tags:           ${(j.tags ?? []).join(", ")}\n`);
  io.out(`HostKeyVerify:  ${boolDesc(j.host_key_verify)}\n`);
  io.out(`LoginFlow:      ${flowDesc(Object.keys(j.login_flow ?? {}).length, j.login_entry)}\n`);
}

function printProxyDetail(p: Proxy, io: IO): void {
  io.out(`Name:           ${p.name}\n`);
  io.out(`Type:           ${p.type}\n`);
  io.out(`Addr:           ${p.addr}\n`);
  if (p.auth?.user) {
    io.out(`Auth.User:      ${p.auth.user}\n`);
    io.out("Auth.Password:  ***\n");
  }
  io.out(`Tags:           ${(p.tags ?? []).join(", ")}\n`);
}
