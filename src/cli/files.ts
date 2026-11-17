import { promises as fs } from "node:fs";
import path from "node:path";

export interface ScaffoldOptions {
  overwriteConfig?: boolean;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function writeSecureFile(filePath: string, data: string): Promise<void> {
  try {
    await fs.writeFile(filePath, data, { mode: 0o600 });
  } catch (err) {
    throw new Error(`write ${filePath}: ${message(err)}`);
  }
  if (process.platform !== "win32") {
    try {
      await fs.chmod(filePath, 0o600);
    } catch (err) {
      throw new Error(`chmod ${filePath}: ${message(err)}`);
    }
  }
}

/** Create <home>/, config.json (preserved), config.example.json (rewritten). */
export async function scaffoldHome(
  home: string,
  options: ScaffoldOptions,
): Promise<void> {
  try {
    await fs.mkdir(home, { recursive: true, mode: 0o700 });
  } catch (err) {
    throw new Error(`mkdir ${home}: ${message(err)}`);
  }
  if (process.platform !== "win32") {
    try {
      await fs.chmod(home, 0o700);
    } catch (err) {
      throw new Error(`chmod ${home}: ${message(err)}`);
    }
  }

  const configPath = path.join(home, "config.json");
  if (options.overwriteConfig) {
    await writeSecureFile(configPath, configJSONSkeleton);
  } else {
    try {
      await fs.stat(configPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      await writeSecureFile(configPath, configJSONSkeleton);
    }
  }

  await writeSecureFile(path.join(home, "config.example.json"), configExampleJSON);
}

export function defaultHome(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = process.env.HOME ?? process.env.USERPROFILE ?? "",
): string {
  if (env.SSHMNG_HOME) return env.SSHMNG_HOME;
  return path.join(homeDir, ".sshmng");
}

export const configJSONSkeleton = `{
  "version": "1",
  "idle_timeout_s": 300,
  "auto_update_enabled": true,
  "jumphosts": [],
  "proxies": [],
  "servers": []
}
`;

// Verbatim copy of internal/cli/files.go configExampleJSON. Keep the
// whitespace identical; M6 diffs this constant against the Go source.
export const configExampleJSON = `{
  "version": "1",
  "idle_timeout_s": 300,
  "log_level": "info",
  "log_path": "",
  "proxies": [
    {
      "name": "example-socks5",
      "type": "SOCKS5",
      "addr": "socks.corp:1080",
      "tags": ["example"]
    },
    {
      "name": "example-socks5-auth",
      "type": "SOCKS5",
      "addr": "socks.corp:1080",
      "auth": {"user": "proxy-user", "password": "<replace-me>"},
      "tags": ["example", "auth"]
    },
    {
      "name": "example-http-auth",
      "type": "HTTP",
      "addr": "proxy.corp:8080",
      "auth": {"user": "proxy-user", "password": "<replace-me>"},
      "tags": ["example", "auth"]
    }
  ],
  "jumphosts": [
    {
      "name": "example-jumphost-a",
      "addr": "10.0.0.254:22",
      "user": "ops",
      "auth": {"password": "<replace-me>"},
      "ssh_j": true,
      "tags": ["example", "pattern-a"]
    },
    {
      "name": "example-jumphost-a-via-proxy",
      "addr": "10.0.0.254:22",
      "user": "ops",
      "auth": {"password": "<replace-me>"},
      "ssh_j": true,
      "proxy": "example-socks5-auth",
      "tags": ["example", "pattern-a", "via-proxy"]
    },
    {
      "name": "example-jumphost-b",
      "addr": "10.0.0.254:22",
      "user": "ops",
      "auth": {"password": "<replace-me>"},
      "ssh_j": false,
      "login_flow": {
        "wait_menu": {
          "expects": [{"pattern": "Your choice:", "next": "success"}]
        }
      },
      "login_entry": "wait_menu",
      "tags": ["example", "pattern-b"]
    }
  ],
  "servers": [
    {
      "name": "example-server-a",
      "addr": "10.0.0.1:22",
      "user": "deploy",
      "auth": {"password": "<replace-me>"},
      "via": "example-jumphost-a",
      "tags": ["example", "pattern-a"]
    },
    {
      "name": "example-server-a-via-proxy",
      "addr": "10.0.0.1:22",
      "user": "deploy",
      "auth": {"password": "<replace-me>"},
      "via": "example-jumphost-a-via-proxy",
      "tags": ["example", "pattern-a", "via-proxy"]
    },
    {
      "name": "example-server-b",
      "addr": "10.0.0.1:22",
      "user": "deploy",
      "auth": null,
      "via": "example-jumphost-b",
      "login_flow": {
        "select_target": {"send": "1\\r", "expects": [{"pattern": "Password:", "next": "input_pass"}]},
        "input_pass": {"send": "<replace-me>\\r", "expects": [{"pattern": "$ ", "next": "success"}]}
      },
      "login_entry": "select_target",
      "tags": ["example", "pattern-b"]
    },
    {
      "name": "example-server-direct-password",
      "addr": "10.0.0.2:22",
      "user": "deploy",
      "auth": {"password": "<replace-me>"},
      "login_flow": {
        "wait_ps1": {
          "send": "",
          "expects": [{"pattern": "re:.*]# ", "next": "success"}]
        }
      },
      "login_entry": "wait_ps1",
      "tags": ["example", "direct", "login-flow"]
    },
    {
      "name": "example-server-direct-key",
      "addr": "10.0.0.3:22",
      "user": "deploy",
      "auth": {
        "private_key": "/home/user/.ssh/deploy_key",
        "passphrase": "<replace-me>"
      },
      "tags": ["example", "direct", "private-key"]
    }
  ]
}
`;
