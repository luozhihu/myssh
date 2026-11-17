import type { Config, Jumphost, LoginAction, SSHServer } from "./types.js";

const SUCCESS = "success";

function q(value: string): string {
  return JSON.stringify(value);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function authIsEmpty(auth: SSHServer["auth"]): boolean {
  return !auth.password && !auth.private_key && !auth.passphrase;
}

export function resolveReferences(cfg: Config): void {
  const jumphosts = new Map<string, Jumphost>();
  for (const j of cfg.jumphosts) {
    if (jumphosts.has(j.name)) {
      throw new Error(`duplicate jumphost name: ${q(j.name)}`);
    }
    jumphosts.set(j.name, j);
  }
  const proxies = new Map<string, Config["proxies"][number]>();
  for (const p of cfg.proxies) {
    if (proxies.has(p.name)) {
      throw new Error(`duplicate proxy name: ${q(p.name)}`);
    }
    proxies.set(p.name, p);
  }
  for (const j of cfg.jumphosts) {
    if (j.via && !jumphosts.has(j.via)) {
      throw new Error(`jumphost ${q(j.name)} references unknown jumphost ${q(j.via)}`);
    }
    if (j.proxy && !proxies.has(j.proxy)) {
      throw new Error(`jumphost ${q(j.name)} references unknown proxy ${q(j.proxy)}`);
    }
  }
  for (const s of cfg.servers) {
    if (s.via && !jumphosts.has(s.via)) {
      throw new Error(`server ${q(s.name)} references unknown jumphost ${q(s.via)}`);
    }
    if (s.proxy && !proxies.has(s.proxy)) {
      throw new Error(`server ${q(s.name)} references unknown proxy ${q(s.proxy)}`);
    }
  }
}

export function validateConfig(cfg: Config): void {
  const jumphosts = new Map(cfg.jumphosts.map((j) => [j.name, j] as const));
  for (const j of cfg.jumphosts) {
    try {
      validateJumphost(j);
    } catch (err) {
      throw new Error(`jumphost ${q(j.name)}: ${message(err)}`);
    }
  }
  for (const s of cfg.servers) {
    try {
      validateSSHServer(s, jumphosts.get(s.via ?? ""));
    } catch (err) {
      throw new Error(`server ${q(s.name)}: ${message(err)}`);
    }
  }
}

export function revalidate(cfg: Config): void {
  resolveReferences(cfg);
  validateConfig(cfg);
}

function validateJumphost(j: Jumphost): void {
  if (authIsEmpty(j.auth)) {
    throw new Error("auth is required");
  }
  const flow = j.login_flow ?? {};
  if (j.ssh_j) {
    if (Object.keys(flow).length > 0) {
      throw new Error("ssh_j=true requires empty login_flow");
    }
    if (j.login_entry) {
      throw new Error("ssh_j=true requires empty login_entry");
    }
    return;
  }
  if (Object.keys(flow).length === 0) {
    throw new Error("ssh_j=false requires non-empty login_flow");
  }
  validateLoginFlow(flow, j.login_entry);
}

function validateSSHServer(s: SSHServer, via: Jumphost | undefined): void {
  const flow = s.login_flow ?? {};
  const patternB = via !== undefined && !via.ssh_j;
  if (patternB) {
    if (!authIsEmpty(s.auth)) {
      throw new Error("pattern B (via.ssh_j=false) requires empty auth; put credentials in login_flow.send");
    }
    if (Object.keys(flow).length === 0) {
      throw new Error("pattern B (via.ssh_j=false) requires non-empty login_flow to log in to target");
    }
    validateLoginFlow(flow, s.login_entry);
    return;
  }
  if (authIsEmpty(s.auth)) {
    throw new Error("pattern A requires auth (used for SSH auth to target)");
  }
  if (via?.ssh_j && s.proxy) {
    throw new Error(
      "pattern A (via.ssh_j=true) does not support server.proxy; direct-tcpip tunnels through jumphost's SSH channel, a separate transport proxy is meaningless",
    );
  }
  if (Object.keys(flow).length > 0) {
    validateLoginFlow(flow, s.login_entry);
  }
}

function validateLoginFlow(flow: Record<string, LoginAction>, entry: string | undefined): void {
  if (Object.hasOwn(flow, SUCCESS)) {
    throw new Error(`${q(SUCCESS)} is reserved, cannot be used as login_flow key`);
  }
  if (!entry) {
    throw new Error("login_entry is required when login_flow is non-empty");
  }
  if (!Object.hasOwn(flow, entry)) {
    throw new Error(`login_entry ${q(entry)} not found in login_flow`);
  }
  for (const [name, action] of Object.entries(flow)) {
    if (action.expects.length === 0) {
      throw new Error(`login_flow[${q(name)}]: expects must have at least one pattern`);
    }
    action.expects.forEach((exp, index) => {
      if (!exp.pattern) {
        throw new Error(`login_flow[${q(name)}].expects[${index}]: pattern is empty`);
      }
      if (!exp.next) {
        throw new Error(`login_flow[${q(name)}].expects[${index}]: next is empty`);
      }
      if (exp.next !== SUCCESS && !Object.hasOwn(flow, exp.next)) {
        throw new Error(
          `login_flow[${q(name)}].expects[${index}].next ${q(exp.next)} not found in login_flow`,
        );
      }
    });
  }
}
