export type ProxyType = "HTTP" | "SOCKS5";

export interface ProxyAuth {
  user?: string;
  password?: string;
}

export interface Proxy {
  name: string;
  type: ProxyType;
  addr: string;
  auth?: ProxyAuth;
  tags?: string[];
}

export interface SSHAuth {
  password?: string;
  private_key?: string;
  passphrase?: string;
}

export interface Expect {
  pattern: string;
  next: string;
}

export interface LoginAction {
  send?: string;
  expects: Expect[];
  timeout_ms?: number;
}

export interface Jumphost {
  name: string;
  addr: string;
  user: string;
  auth: SSHAuth;
  ssh_j: boolean;
  login_flow?: Record<string, LoginAction>;
  login_entry?: string;
  max_steps?: number;
  global_timeout_ms?: number;
  host_key_verify?: boolean;
  via?: string;
  proxy?: string;
  tags?: string[];
}

export interface SSHServer {
  name: string;
  addr: string;
  user: string;
  auth: SSHAuth;
  login_flow?: Record<string, LoginAction>;
  login_entry?: string;
  max_steps?: number;
  global_timeout_ms?: number;
  host_key_verify?: boolean;
  raw?: boolean;
  via?: string;
  proxy?: string;
  tags?: string[];
}

export interface Config {
  version: string;
  idle_timeout_s: number;
  log_level?: string;
  log_path?: string;
  auto_update_enabled?: boolean;
  update_url?: string;
  jumphosts: Jumphost[];
  proxies: Proxy[];
  servers: SSHServer[];
}
