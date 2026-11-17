import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  getJumphost,
  getProxy,
  getSSHServer,
  listJumphosts,
  listProxies,
  listSSHServers,
  updateJumphost,
  updateProxy,
  updateSSHServer,
} from "../config/crud.js";
import type { Config } from "../config/types.js";
import { errorResult, redactAuth, textResult, toPlain } from "./result.js";
import type { Service } from "./service.js";

export interface ListArgs {
  query?: string;
}

export interface GetArgs {
  name: string;
}

export interface UpdateArgs {
  name: string;
  patch?: unknown;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function listEntities<T>(
  svc: Service,
  list: (cfg: Config, query: string) => T[],
  query: string | undefined,
): Promise<CallToolResult> {
  return svc.runExclusive(async () => {
    let cfg: Config;
    try {
      cfg = await svc.store.load();
    } catch (err) {
      return errorResult(`load config: ${message(err)}`);
    }
    return textResult(list(cfg, query ?? "").map((item) => redactAuth(toPlain(item))));
  });
}

function getEntity<T>(
  svc: Service,
  get: (cfg: Config, name: string) => T,
  name: string,
): Promise<CallToolResult> {
  return svc.runExclusive(async () => {
    let cfg: Config;
    try {
      cfg = await svc.store.load();
    } catch (err) {
      return errorResult(`load config: ${message(err)}`);
    }
    try {
      return textResult(get(cfg, name));
    } catch (err) {
      return errorResult(message(err));
    }
  });
}

function updateEntity<T>(
  svc: Service,
  update: (cfg: Config, name: string, patch: unknown) => void,
  get: (cfg: Config, name: string) => T,
  args: UpdateArgs,
  label: string,
): Promise<CallToolResult> {
  return svc.runExclusive(async () => {
    let cfg: Config;
    try {
      cfg = await svc.store.load();
    } catch (err) {
      return errorResult(`load config: ${message(err)}`);
    }
    const patch = args.patch === undefined ? null : args.patch;
    try {
      update(cfg, args.name, patch);
    } catch (err) {
      return errorResult(`${label}: ${message(err)}`);
    }
    try {
      await svc.store.save(cfg);
    } catch (err) {
      return errorResult(`save config: ${message(err)}`);
    }
    try {
      return textResult(get(cfg, args.name));
    } catch {
      return textResult({ name: args.name, deleted: true });
    }
  });
}

export function listSSHServersTool(svc: Service, args: ListArgs): Promise<CallToolResult> {
  return listEntities(svc, listSSHServers, args.query);
}

export function getSSHServerTool(svc: Service, args: GetArgs): Promise<CallToolResult> {
  return getEntity(svc, getSSHServer, args.name);
}

export function updateSSHServerTool(svc: Service, args: UpdateArgs): Promise<CallToolResult> {
  return updateEntity(svc, updateSSHServer, getSSHServer, args, "update ssh server");
}

export function listJumphostsTool(svc: Service, args: ListArgs): Promise<CallToolResult> {
  return listEntities(svc, listJumphosts, args.query);
}

export function getJumphostTool(svc: Service, args: GetArgs): Promise<CallToolResult> {
  return getEntity(svc, getJumphost, args.name);
}

export function updateJumphostTool(svc: Service, args: UpdateArgs): Promise<CallToolResult> {
  return updateEntity(svc, updateJumphost, getJumphost, args, "update jumphost");
}

export function listProxiesTool(svc: Service, args: ListArgs): Promise<CallToolResult> {
  return listEntities(svc, listProxies, args.query);
}

export function getProxyTool(svc: Service, args: GetArgs): Promise<CallToolResult> {
  return getEntity(svc, getProxy, args.name);
}

export function updateProxyTool(svc: Service, args: UpdateArgs): Promise<CallToolResult> {
  return updateEntity(svc, updateProxy, getProxy, args, "update proxy");
}
