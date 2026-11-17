# myssh M1：工程骨架 + config + CRUD + 配置类 MCP 工具

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立可构建、可测试的 TypeScript 项目骨架，并实现与原 Go 版兼容的配置模型、加载/保存、校验、CRUD 与 9 个配置类 MCP 工具。

**Architecture:** 配置层保持纯函数 + 一个只管文件读写的 `Store`；MCP 层用 Service 的执行队列串行化所有调用；CLI 通过可注入的 IO 接口便于测试。所有工具返回值用 2 空格缩进 JSON 文本，错误走 `isError: true`。

**Tech Stack:** TypeScript 7 strict + ESM、Node ≥ 22、tsup、vitest、`@modelcontextprotocol/sdk` 1.x、zod 4。

**参考文档：**
- 设计 spec：`docs/superpowers/specs/2026-11-17-myssh-ts-rewrite-design.md`
- 原项目：`/Users/luozhihu/workspace/sshmng`

---

## 文件结构（M1）

```
package.json
tsconfig.json
tsup.config.ts
vitest.config.ts
.gitignore
src/
├── index.ts                 # bin 入口（top-level await）
├── version.ts               # VERSION / COMMIT / BUILD_DATE + 平台名映射
├── cli/
│   └── main.ts              # dispatch: help/version/mcp/entity
├── config/
│   ├── types.ts             # Config / Jumphost / SSHServer / Proxy
│   ├── log_level.ts         # parseLogLevel
│   ├── validate.ts          # resolveReferences / validateConfig / revalidate
│   ├── store.ts             # resolveConfigPath / defaultConfig / Store
│   └── crud.ts              # list/get/update + mergePatch
└── mcp/
    ├── result.ts            # textResult / errorResult / redactAuth
    ├── service.ts           # Service（store + 串行队列）
    ├── tools_config.ts      # 9 个配置工具 handler
    └── server.ts            # McpServer 注册 + stdio 启动
tests/
├── helpers/config.ts        # 临时目录 / 写配置 / 构造 service
├── cli/main.test.ts
├── config/log_level.test.ts
├── config/validate.test.ts
├── config/store.test.ts
├── config/crud.test.ts
└── mcp/tools_config.test.ts
```

---

### Task 1: 工程骨架与 CLI 入口

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`, `.gitignore`
- Create: `src/index.ts`, `src/version.ts`, `src/cli/main.ts`
- Test: `tests/cli/main.test.ts`

- [ ] **Step 1: 写失败的 CLI 测试**

`tests/cli/main.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { main } from "../../src/cli/main.js";

function capture() {
  let out = "";
  let err = "";
  return {
    io: {
      out: (s: string) => { out += s; },
      err: (s: string) => { err += s; },
    },
    get out() { return out; },
    get err() { return err; },
  };
}

describe("cli skeleton", () => {
  it("prints help with no args and exits 0", async () => {
    const c = capture();
    const code = await main([], c.io);
    expect(code).toBe(0);
    expect(c.out).toContain("myssh - SSH session manager");
    expect(c.out).toContain("myssh mcp");
  });

  it("prints version", async () => {
    const c = capture();
    const code = await main(["version"], c.io);
    expect(code).toBe(0);
    expect(c.out).toContain("sshmng 0.1.0");
    expect(c.out).toContain("commit: dev");
  });

  it("returns 2 for an unknown command", async () => {
    const c = capture();
    const code = await main(["nope"], c.io);
    expect(code).toBe(2);
    expect(c.out).toContain('Unknown command "nope"');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/cli/main.test.ts`
Expected: FAIL，`Cannot find module '../../src/cli/main.js'`（此时依赖与源码都还不存在）

- [ ] **Step 3: 创建工程文件**

`package.json`：

```json
{
  "name": "myssh",
  "version": "0.1.0",
  "description": "Unified SSH session manager (MCP server + CLI), drop-in compatible with sshmng",
  "type": "module",
  "bin": {
    "myssh": "dist/index.js",
    "sshmng": "dist/index.js"
  },
  "files": [
    "dist",
    "README.md"
  ],
  "engines": {
    "node": ">=22"
  },
  "scripts": {
    "build": "tsup",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.32.2",
    "zod": "^4.6.7"
  },
  "devDependencies": {
    "@types/node": "^26.6.6",
    "tsup": "^9.0.0",
    "typescript": "^7.0.2",
    "vitest": "^5.1.0"
  }
}
```

`tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "outDir": "dist",
    "types": ["node"]
  },
  "include": ["src", "tests"]
}
```

`tsup.config.ts`：

```ts
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  clean: true,
  sourcemap: true,
  banner: { js: "#!/usr/bin/env node" },
});
```

`vitest.config.ts`：

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
```

`.gitignore`：

```
node_modules/
dist/
coverage/
*.log
.DS_Store
```

`src/version.ts`：

```ts
export const VERSION = "0.1.0";
export const COMMIT = "dev";
export const BUILD_DATE = "unknown";

export function goOS(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "windows" : platform;
}

export function goArch(arch: string = process.arch): string {
  switch (arch) {
    case "x64": return "amd64";
    case "ia32": return "386";
    case "arm64": return "arm64";
    default: return arch;
  }
}
```

`src/index.ts`：

```ts
import { main } from "./cli/main.js";

process.exitCode = await main(process.argv.slice(2));
```

`src/cli/main.ts`：

```ts
import { BUILD_DATE, COMMIT, goArch, goOS, VERSION } from "../version.js";

export interface IO {
  out: (text: string) => void;
  err: (text: string) => void;
}

const defaultIO: IO = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

const helpText = `myssh - SSH session manager

Usage:
  myssh                          Print this help and exit
  myssh mcp [--config <path>]    Start MCP server (stdio)
  myssh version                  Print version
  myssh server <list|get> [...]  List or view SSH servers
  myssh jumphost <list|get> [...]  List or view jumphosts
  myssh proxy <list|get> [...]   List or view proxies
  myssh help | -h | --help       Print this help
`;

export async function main(args: string[], io: IO = defaultIO): Promise<number> {
  if (args.length === 0 || args[0] === "help" || args[0] === "-h" || args[0] === "--help") {
    io.out(helpText);
    return 0;
  }
  switch (args[0]) {
    case "version":
      io.out(`sshmng ${VERSION} (${goOS()}/${goArch()})\n`);
      io.out(`commit: ${COMMIT}\n`);
      io.out(`built:  ${BUILD_DATE}\n`);
      return 0;
    default:
      io.out(`Unknown command ${JSON.stringify(args[0])}. Run 'myssh help' for usage.\n`);
      return 2;
  }
}
```

- [ ] **Step 4: 安装依赖并跑测试**

Run:
```bash
npm install
npm test -- tests/cli/main.test.ts
```
Expected: PASS（3 tests）

- [ ] **Step 5: 验证构建产物**

Run: `npm run build`
Expected: 成功生成 `dist/index.js`，文件第一行为 `#!/usr/bin/env node`

- [ ] **Step 6: 提交**

```bash
git add package.json package-lock.json tsconfig.json tsup.config.ts vitest.config.ts .gitignore src/index.ts src/version.ts src/cli/main.ts tests/cli/main.test.ts
git commit -m "feat: scaffold TypeScript CLI skeleton"
```

---

### Task 2: 配置类型与日志级别

**Files:**
- Create: `src/config/types.ts`, `src/config/log_level.ts`
- Test: `tests/config/log_level.test.ts`

- [ ] **Step 1: 写失败的测试**

`tests/config/log_level.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { parseLogLevel } from "../../src/config/log_level.js";

describe("parseLogLevel", () => {
  it("returns info for empty values", () => {
    expect(parseLogLevel(undefined)).toBe("info");
    expect(parseLogLevel("")).toBe("info");
    expect(parseLogLevel("  ")).toBe("info");
  });

  it("accepts documented abbreviations case-insensitively", () => {
    expect(parseLogLevel("debug")).toBe("debug");
    expect(parseLogLevel("DBG")).toBe("debug");
    expect(parseLogLevel("d")).toBe("debug");
    expect(parseLogLevel("inf")).toBe("info");
    expect(parseLogLevel("i")).toBe("info");
    expect(parseLogLevel("warning")).toBe("warn");
    expect(parseLogLevel("w")).toBe("warn");
    expect(parseLogLevel("err")).toBe("error");
    expect(parseLogLevel("e")).toBe("error");
  });

  it("rejects unknown values instead of falling back", () => {
    expect(() => parseLogLevel("trace")).toThrow(
      'unknown log level "trace" (supported: debug/dbg/d, info/inf/i, warn/warning/w, error/err/e)',
    );
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/config/log_level.test.ts`
Expected: FAIL，`Cannot find module '../../src/config/log_level.js'`

- [ ] **Step 3: 实现类型与日志级别**

`src/config/types.ts`：

```ts
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
```

`src/config/log_level.ts`：

```ts
export type LogLevel = "debug" | "info" | "warn" | "error";

export function parseLogLevel(value: string | undefined): LogLevel {
  const v = (value ?? "").trim().toLowerCase();
  switch (v) {
    case "":
      return "info";
    case "debug":
    case "dbg":
    case "d":
      return "debug";
    case "info":
    case "inf":
    case "i":
      return "info";
    case "warn":
    case "warning":
    case "w":
      return "warn";
    case "error":
    case "err":
    case "e":
      return "error";
    default:
      throw new Error(
        `unknown log level ${JSON.stringify(value)} (supported: debug/dbg/d, info/inf/i, warn/warning/w, error/err/e)`,
      );
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- tests/config/log_level.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 5: 提交**

```bash
git add src/config/types.ts src/config/log_level.ts tests/config/log_level.test.ts
git commit -m "feat(config): add data types and log level parsing"
```

---

### Task 3: 引用解析与配置校验

**Files:**
- Create: `src/config/validate.ts`
- Test: `tests/config/validate.test.ts`

- [ ] **Step 1: 写失败的测试**

`tests/config/validate.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import type { Config } from "../../src/config/types.js";
import { resolveReferences, validateConfig } from "../../src/config/validate.js";

const base = (): Config => ({
  version: "1",
  idle_timeout_s: 300,
  jumphosts: [],
  proxies: [],
  servers: [],
});

describe("resolveReferences", () => {
  it("rejects duplicate jumphost and proxy names", () => {
    const cfg = base();
    cfg.jumphosts.push(
      { name: "j", addr: "1.1.1.1:22", user: "u", auth: { password: "p" }, ssh_j: true },
      { name: "j", addr: "2.2.2.2:22", user: "u", auth: { password: "p" }, ssh_j: true },
    );
    expect(() => resolveReferences(cfg)).toThrow('duplicate jumphost name: "j"');
  });

  it("rejects unknown via and proxy references", () => {
    const cfg = base();
    cfg.servers.push({
      name: "s", addr: "1.1.1.1:22", user: "u", auth: { password: "p" }, via: "missing",
    });
    expect(() => resolveReferences(cfg)).toThrow(
      'server "s" references unknown jumphost "missing"',
    );
  });
});

describe("validateConfig", () => {
  it("requires auth on jumphosts", () => {
    const cfg = base();
    cfg.jumphosts.push({ name: "j", addr: "1.1.1.1:22", user: "u", auth: {}, ssh_j: true });
    expect(() => validateConfig(cfg)).toThrow('jumphost "j": auth is required');
  });

  it("enforces ssh_j=true empty login flow", () => {
    const cfg = base();
    cfg.jumphosts.push({
      name: "j", addr: "1.1.1.1:22", user: "u", auth: { password: "p" }, ssh_j: true,
      login_flow: { a: { expects: [{ pattern: "x", next: "success" }] } },
      login_entry: "a",
    });
    expect(() => validateConfig(cfg)).toThrow(
      'jumphost "j": ssh_j=true requires empty login_flow',
    );
  });

  it("enforces bastion login_flow and login_entry", () => {
    const cfg = base();
    cfg.jumphosts.push({ name: "j", addr: "1.1.1.1:22", user: "u", auth: { password: "p" }, ssh_j: false });
    expect(() => validateConfig(cfg)).toThrow(
      'jumphost "j": ssh_j=false requires non-empty login_flow',
    );
  });

  it("rejects success as login flow key", () => {
    const cfg = base();
    cfg.jumphosts.push({
      name: "j", addr: "1.1.1.1:22", user: "u", auth: { password: "p" }, ssh_j: false,
      login_flow: { success: { expects: [{ pattern: "x", next: "success" }] } },
      login_entry: "success",
    });
    expect(() => validateConfig(cfg)).toThrow(
      'jumphost "j": "success" is reserved, cannot be used as login_flow key',
    );
  });

  it("validates expect.next targets", () => {
    const cfg = base();
    cfg.jumphosts.push({
      name: "j", addr: "1.1.1.1:22", user: "u", auth: { password: "p" }, ssh_j: false,
      login_flow: { a: { expects: [{ pattern: "x", next: "nope" }] } },
      login_entry: "a",
    });
    expect(() => validateConfig(cfg)).toThrow(
      'jumphost "j": login_flow["a"].expects[0].next "nope" not found in login_flow',
    );
  });

  it("requires empty auth and non-empty flow for Pattern B targets", () => {
    const cfg = base();
    cfg.jumphosts.push({
      name: "bastion", addr: "1.1.1.1:22", user: "u", auth: { password: "p" }, ssh_j: false,
      login_flow: { a: { expects: [{ pattern: "x", next: "success" }] } },
      login_entry: "a",
    });
    cfg.servers.push({
      name: "s", addr: "2.2.2.2:22", user: "u", auth: { password: "p" }, via: "bastion",
    });
    expect(() => validateConfig(cfg)).toThrow(
      'server "s": pattern B (via.ssh_j=false) requires empty auth; put credentials in login_flow.send',
    );
  });

  it("requires auth for Pattern A targets", () => {
    const cfg = base();
    cfg.servers.push({ name: "s", addr: "1.1.1.1:22", user: "u", auth: {} });
    expect(() => validateConfig(cfg)).toThrow(
      'server "s": pattern A requires auth (used for SSH auth to target)',
    );
  });

  it("rejects proxy on Pattern A targets", () => {
    const cfg = base();
    cfg.jumphosts.push({
      name: "j", addr: "1.1.1.1:22", user: "u", auth: { password: "p" }, ssh_j: true,
    });
    cfg.proxies.push({ name: "p", type: "HTTP", addr: "3.3.3.3:8080" });
    cfg.servers.push({
      name: "s", addr: "2.2.2.2:22", user: "u", auth: { password: "p" },
      via: "j", proxy: "p",
    });
    expect(() => validateConfig(cfg)).toThrow(
      'server "s": pattern A (via.ssh_j=true) does not support server.proxy; direct-tcpip tunnels through jumphost\'s SSH channel, a separate transport proxy is meaningless',
    );
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/config/validate.test.ts`
Expected: FAIL，`Cannot find module '../../src/config/validate.js'`

- [ ] **Step 3: 实现引用解析与校验**

`src/config/validate.ts`：

```ts
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- tests/config/validate.test.ts`
Expected: PASS（9 tests）

- [ ] **Step 5: 提交**

```bash
git add src/config/validate.ts tests/config/validate.test.ts
git commit -m "feat(config): add reference resolution and validation"
```

---

### Task 4: 配置 Store（路径、加载、原子保存）

**Files:**
- Create: `src/config/store.ts`
- Test: `tests/config/store.test.ts`, `tests/helpers/config.ts`

- [ ] **Step 1: 写失败的测试**

`tests/helpers/config.ts`：

```ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export async function tempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "myssh-test-"));
  return {
    dir,
    cleanup: async () => { await rm(dir, { recursive: true, force: true }); },
  };
}

export async function writeConfig(dir: string, value: unknown): Promise<string> {
  const file = path.join(dir, "config.json");
  await writeFile(file, JSON.stringify(value, null, 2), { mode: 0o600 });
  return file;
}
```

`tests/config/store.test.ts`：

```ts
import { chmod, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig, resolveConfigPath, Store } from "../../src/config/store.js";
import { tempDir, writeConfig } from "../helpers/config.js";

describe("resolveConfigPath", () => {
  it("prefers explicit path, then SSHMNG_HOME, then ~/.sshmng", () => {
    expect(resolveConfigPath("/tmp/x.json", {})).toBe("/tmp/x.json");
    expect(resolveConfigPath("", { SSHMNG_HOME: "/tmp/home" })).toBe("/tmp/home/config.json");
    expect(resolveConfigPath("", {})).toMatch(/\.sshmng[\\/]config\.json$/);
  });
});

describe("Store", () => {
  it("returns default config when file is missing and creates nothing", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const store = new Store(path.join(dir, "config.json"));
      const cfg = await store.load();
      expect(cfg).toEqual({
        version: "1",
        idle_timeout_s: 300,
        auto_update_enabled: true,
        jumphosts: [],
        proxies: [],
        servers: [],
      });
    } finally {
      await cleanup();
    }
  });

  it("loads JSON, applies defaults, and resolves references", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const file = await writeConfig(dir, {
        version: "1",
        jumphosts: [{
          name: "j", addr: "1.1.1.1:22", user: "u", auth: { password: "p" }, ssh_j: true,
        }],
        proxies: [],
        servers: [{
          name: "s", addr: "2.2.2.2:22", user: "u", auth: { password: "p" }, via: "j",
        }],
      });
      const cfg = await new Store(file).load();
      expect(cfg.idle_timeout_s).toBe(300);
      expect(cfg.servers[0]?.via).toBe("j");
    } finally {
      await cleanup();
    }
  });

  it("rejects a config without version", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const file = await writeConfig(dir, { jumphosts: [], proxies: [], servers: [] });
      await expect(new Store(file).load()).rejects.toThrow('missing "version" field');
    } finally {
      await cleanup();
    }
  });

  it("rejects an unknown log level", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const file = await writeConfig(dir, {
        version: "1", log_level: "trace", jumphosts: [], proxies: [], servers: [],
      });
      await expect(new Store(file).load()).rejects.toThrow('unknown log level "trace"');
    } finally {
      await cleanup();
    }
  });

  it.skipIf(process.platform === "win32")("rejects group/other permissions", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const file = await writeConfig(dir, {
        version: "1", jumphosts: [], proxies: [], servers: [],
      });
      await chmod(file, 0o644);
      await expect(new Store(file).load()).rejects.toThrow(
        /config file permissions too open: 644, want 0600 or stricter/,
      );
    } finally {
      await cleanup();
    }
  });

  it.skipIf(process.platform === "win32")("saves atomically with 0600 permissions", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const file = path.join(dir, "config.json");
      const cfg = defaultConfig();
      await new Store(file).save(cfg);
      const info = await stat(file);
      expect(info.mode & 0o777).toBe(0o600);
      const loaded = await new Store(file).load();
      expect(loaded.version).toBe("1");
    } finally {
      await cleanup();
    }
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/config/store.test.ts`
Expected: FAIL，`Cannot find module '../../src/config/store.js'`

- [ ] **Step 3: 实现 Store**

`src/config/store.ts`：

```ts
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseLogLevel } from "./log_level.js";
import type { Config } from "./types.js";
import { resolveReferences } from "./validate.js";

export function resolveConfigPath(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (explicit) {
    return explicit;
  }
  if (env.SSHMNG_HOME) {
    return path.join(env.SSHMNG_HOME, "config.json");
  }
  return path.join(homedir(), ".sshmng", "config.json");
}

export function defaultConfig(): Config {
  return {
    version: "1",
    idle_timeout_s: 300,
    auto_update_enabled: true,
    jumphosts: [],
    proxies: [],
    servers: [],
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function normalizeConfig(cfg: Config): Config {
  if (!cfg.version) {
    throw new Error('missing "version" field');
  }
  if (!cfg.idle_timeout_s) {
    cfg.idle_timeout_s = 300;
  }
  parseLogLevel(cfg.log_level);
  cfg.jumphosts ??= [];
  cfg.proxies ??= [];
  cfg.servers ??= [];
  resolveReferences(cfg);
  return cfg;
}

export class Store {
  constructor(readonly path: string) {}

  async load(): Promise<Config> {
    let info;
    try {
      info = await fs.stat(this.path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return defaultConfig();
      }
      throw new Error(`stat config: ${errorMessage(err)}`);
    }
    if (process.platform !== "win32") {
      const perm = info.mode & 0o777;
      if (perm & 0o077) {
        throw new Error(
          `config file permissions too open: ${perm.toString(8)}, want 0600 or stricter (no group/other access)`,
        );
      }
    }
    let data: string;
    try {
      data = await fs.readFile(this.path, "utf8");
    } catch (err) {
      throw new Error(`read config: ${errorMessage(err)}`);
    }
    let parsed: Config;
    try {
      parsed = JSON.parse(data) as Config;
    } catch (err) {
      throw new Error(`parse config: ${errorMessage(err)}`);
    }
    try {
      return normalizeConfig(parsed);
    } catch (err) {
      throw new Error(`parse config: ${errorMessage(err)}`);
    }
  }

  async save(cfg: Config): Promise<void> {
    const data = JSON.stringify(cfg, null, 2);
    const dir = path.dirname(this.path);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(
      dir,
      `.config.json.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`,
    );
    try {
      await fs.writeFile(tmp, data, { mode: 0o600 });
      await fs.chmod(tmp, 0o600);
      await fs.rename(tmp, this.path);
    } catch (err) {
      await fs.rm(tmp, { force: true });
      if (process.platform === "win32") {
        try {
          await fs.writeFile(this.path, data, { mode: 0o600 });
          return;
        } catch (fallbackErr) {
          throw new Error(
            `rename temp to config: ${errorMessage(err)} (fallback write also failed: ${errorMessage(fallbackErr)})`,
          );
        }
      }
      throw new Error(`rename temp to config: ${errorMessage(err)}`);
    }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- tests/config/store.test.ts`
Expected: PASS（5 passed，1 skipped on Windows）

- [ ] **Step 5: 提交**

```bash
git add src/config/store.ts tests/config/store.test.ts tests/helpers/config.ts
git commit -m "feat(config): add store with atomic save and permission checks"
```

---

### Task 5: CRUD（列表、查询、Merge Patch 更新）

**Files:**
- Create: `src/config/crud.ts`
- Test: `tests/config/crud.test.ts`

- [ ] **Step 1: 写失败的测试**

`tests/config/crud.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import {
  getJumphost,
  getProxy,
  getSSHServer,
  listJumphosts,
  listProxies,
  listSSHServers,
  mergePatch,
  updateJumphost,
  updateProxy,
  updateSSHServer,
} from "../../src/config/crud.js";
import type { Config } from "../../src/config/types.js";
import { revalidate } from "../../src/config/validate.js";

function base(): Config {
  return {
    version: "1",
    idle_timeout_s: 300,
    jumphosts: [],
    proxies: [],
    servers: [],
  };
}

describe("list and get", () => {
  it("AND-matches keywords against name, addr and tags", () => {
    const cfg = base();
    cfg.servers.push(
      {
        name: "prod-web-01", addr: "10.0.0.1:22", user: "u",
        auth: { password: "p" }, tags: ["nginx", "linux"],
      },
      {
        name: "prod-db-01", addr: "10.0.0.2:22", user: "u",
        auth: { password: "p" }, tags: ["mysql"],
      },
    );
    expect(listSSHServers(cfg, "prod web").map((s) => s.name)).toEqual(["prod-web-01"]);
    expect(listSSHServers(cfg, "10.0.0.2").map((s) => s.name)).toEqual(["prod-db-01"]);
    expect(listSSHServers(cfg, "NGINX").map((s) => s.name)).toEqual(["prod-web-01"]);
    expect(listSSHServers(cfg, "  ")).toHaveLength(2);
  });

  it("lists jumphosts and proxies and gets by name", () => {
    const cfg = base();
    cfg.jumphosts.push({
      name: "j", addr: "1.1.1.1:22", user: "u", auth: { password: "p" }, ssh_j: true,
    });
    cfg.proxies.push({ name: "p", type: "SOCKS5", addr: "3.3.3.3:1080" });
    expect(listJumphosts(cfg, "1.1").map((j) => j.name)).toEqual(["j"]);
    expect(listProxies(cfg, "").map((p) => p.name)).toEqual(["p"]);
    expect(getJumphost(cfg, "j").name).toBe("j");
    expect(getProxy(cfg, "p").name).toBe("p");
  });

  it("returns not-found errors with the original wording", () => {
    const cfg = base();
    expect(() => getSSHServer(cfg, "x")).toThrow('ssh server "x" not found');
    expect(() => getJumphost(cfg, "x")).toThrow('jumphost "x" not found');
    expect(() => getProxy(cfg, "x")).toThrow('proxy "x" not found');
  });
});

describe("mergePatch", () => {
  it("recursively merges and deletes null keys", () => {
    const merged = mergePatch(
      { name: "s", auth: { password: "p", private_key: "k" }, tags: ["a"] },
      { auth: { private_key: null }, tags: ["b"], raw: true },
    );
    expect(merged).toEqual({ name: "s", auth: { password: "p" }, tags: ["b"], raw: true });
  });

  it("rejects non-object patches", () => {
    expect(() => mergePatch({ name: "s" }, "bad")).toThrow(
      "patch must be object or null, got string",
    );
  });
});

describe("update", () => {
  it("creates an entity and forces the name from the argument", () => {
    const cfg = base();
    updateSSHServer(cfg, "s", {
      addr: "1.1.1.1:22", user: "u", auth: { password: "p" }, name: "ignored",
    });
    revalidate(cfg);
    expect(cfg.servers[0]?.name).toBe("s");
  });

  it("merges into an existing entity", () => {
    const cfg = base();
    cfg.servers.push({
      name: "s", addr: "1.1.1.1:22", user: "u", auth: { password: "p" }, tags: ["old"],
    });
    updateSSHServer(cfg, "s", { tags: ["new"], auth: { passphrase: null } });
    expect(cfg.servers[0]).toMatchObject({
      name: "s", addr: "1.1.1.1:22", tags: ["new"], auth: { password: "p" },
    });
    expect(cfg.servers[0]?.auth).not.toHaveProperty("passphrase");
  });

  it("deletes with null and treats missing delete as no-op", () => {
    const cfg = base();
    cfg.proxies.push({ name: "p", type: "HTTP", addr: "3.3.3.3:8080" });
    updateProxy(cfg, "p", null);
    expect(cfg.proxies).toHaveLength(0);
    expect(() => updateProxy(cfg, "p", null)).not.toThrow();
  });

  it("rolls back when validation fails", () => {
    const cfg = base();
    cfg.proxies.push({ name: "p", type: "HTTP", addr: "3.3.3.3:8080" });
    expect(() => updateProxy(cfg, "p", { type: "BOGUS" })).toThrow();
    expect(cfg.proxies[0]?.type).toBe("HTTP");
  });

  it("updates jumphosts and proxies", () => {
    const cfg = base();
    updateJumphost(cfg, "j", {
      addr: "1.1.1.1:22", user: "u", auth: { password: "p" }, ssh_j: true,
    });
    updateProxy(cfg, "p", { type: "SOCKS5", addr: "3.3.3.3:1080" });
    revalidate(cfg);
    expect(cfg.jumphosts[0]?.name).toBe("j");
    expect(cfg.proxies[0]?.type).toBe("SOCKS5");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/config/crud.test.ts`
Expected: FAIL，`Cannot find module '../../src/config/crud.js'`

- [ ] **Step 3: 实现 CRUD**

`src/config/crud.ts`：

```ts
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
    case "string": return "string";
    case "number": return "float64";
    case "boolean": return "bool";
    case "object": return "map[string]interface {}";
    default: return typeof value;
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

function updateItem<T extends { name: string }>(
  cfg: Config,
  list: "servers" | "jumphosts" | "proxies",
  name: string,
  patch: unknown,
  prefix: string,
): void {
  const items = cfg[list] as T[];
  if (patch === null) {
    const index = items.findIndex((item) => item.name === name);
    if (index < 0) {
      return;
    }
    const original = items.slice();
    items.splice(index, 1);
    try {
      revalidate(cfg);
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
    revalidate(cfg);
  } catch (err) {
    if (index >= 0 && original) {
      items[index] = original as T;
    } else if (index < 0) {
      items.pop();
    }
    throw err;
  }
  void prefix;
}

export function updateSSHServer(cfg: Config, name: string, patch: unknown): void {
  updateItem<SSHServer>(cfg, "servers", name, patch, "server");
}

export function updateJumphost(cfg: Config, name: string, patch: unknown): void {
  updateItem<Jumphost>(cfg, "jumphosts", name, patch, "jumphost");
}

export function updateProxy(cfg: Config, name: string, patch: unknown): void {
  updateItem<Proxy>(cfg, "proxies", name, patch, "proxy");
}
```

> 说明：`prefix` 参数仅为保持三个 update 函数签名对称；错误文案与原 Go 版保持一致（由 `revalidate` 生成）。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- tests/config/crud.test.ts`
Expected: PASS（12 tests）

- [ ] **Step 5: 提交**

```bash
git add src/config/crud.ts tests/config/crud.test.ts
git commit -m "feat(config): add list/get/update with RFC 7396 merge patch"
```

---

### Task 6: MCP 结果辅助与 Service 串行队列

**Files:**
- Create: `src/mcp/result.ts`, `src/mcp/service.ts`
- Test: 由 Task 7 的协议测试覆盖（本任务先提交小步实现）

- [ ] **Step 1: 实现结果辅助**

`src/mcp/result.ts`：

```ts
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export function textResult(value: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

export function errorResult(message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

export function toPlain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

export function redactAuth(value: unknown): unknown {
  const clone = structuredClone(value) as Record<string, unknown>;
  const auth = clone.auth;
  if (typeof auth === "object" && auth !== null) {
    const a = auth as Record<string, unknown>;
    delete a.password;
    delete a.private_key;
    delete a.passphrase;
  }
  return clone;
}
```

- [ ] **Step 2: 实现 Service**

`src/mcp/service.ts`：

```ts
import type { Store } from "../config/store.js";

export class Service {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(readonly store: Store) {}

  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
```

- [ ] **Step 3: 类型检查**

Run: `npm run typecheck`
Expected: PASS（无输出）

- [ ] **Step 4: 提交**

```bash
git add src/mcp/result.ts src/mcp/service.ts
git commit -m "feat(mcp): add result helpers and serialized service queue"
```

---

### Task 7: 9 个配置类 MCP 工具与协议测试

**Files:**
- Create: `src/mcp/tools_config.ts`, `src/mcp/server.ts`
- Test: `tests/mcp/tools_config.test.ts`

- [ ] **Step 1: 写失败的协议测试**

`tests/mcp/tools_config.test.ts`：

```ts
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Store } from "../../src/config/store.js";
import { Service } from "../../src/mcp/service.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { tempDir, writeConfig } from "../helpers/config.js";

async function connect(store: Store) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(new Service(store));
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return { client, server };
}

function textOf(result: { content?: Array<{ type: string; text?: string }> }): string {
  return result.content?.find((c) => c.type === "text")?.text ?? "";
}

const sample = {
  version: "1",
  idle_timeout_s: 300,
  jumphosts: [{
    name: "bastion", addr: "1.1.1.1:22", user: "ops", auth: { password: "secret" },
    ssh_j: true, tags: ["edge"],
  }],
  proxies: [{ name: "proxy-a", type: "SOCKS5", addr: "3.3.3.3:1080" }],
  servers: [{
    name: "prod-web-01", addr: "10.0.0.1:22", user: "deploy",
    auth: { password: "pw", private_key: "/id_rsa", passphrase: "pp" },
    via: "bastion", tags: ["prod", "web"],
  }],
};

describe("config MCP tools", () => {
  it("registers all 9 config tools", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const file = await writeConfig(dir, sample);
      const { client } = await connect(new Store(file));
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name).sort()).toEqual([
        "get_jumphost", "get_proxy", "get_ssh_server",
        "list_jumphosts", "list_proxies", "list_ssh_servers",
        "update_jumphost", "update_proxy", "update_ssh_server",
      ]);
    } finally {
      await cleanup();
    }
  });

  it("lists servers with AND query and redacts auth", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const file = await writeConfig(dir, sample);
      const { client } = await connect(new Store(file));
      const result = await client.callTool({
        name: "list_ssh_servers",
        arguments: { query: "prod web" },
      });
      const rows = JSON.parse(textOf(result));
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe("prod-web-01");
      expect(rows[0].auth).toBeUndefined();
      expect(rows[0].via).toBe("bastion");
    } finally {
      await cleanup();
    }
  });

  it("gets a server with full auth", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const file = await writeConfig(dir, sample);
      const { client } = await connect(new Store(file));
      const result = await client.callTool({
        name: "get_ssh_server",
        arguments: { name: "prod-web-01" },
      });
      const row = JSON.parse(textOf(result));
      expect(row.auth.password).toBe("pw");
      expect(row.auth.private_key).toBe("/id_rsa");
      expect(row.auth.passphrase).toBe("pp");
    } finally {
      await cleanup();
    }
  });

  it("creates, merges and deletes a proxy, persisting to disk", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const file = await writeConfig(dir, sample);
      const store = new Store(file);
      const { client } = await connect(store);

      const created = await client.callTool({
        name: "update_proxy",
        arguments: {
          name: "new-proxy",
          patch: { type: "HTTP", addr: "4.4.4.4:8080", tags: ["new"] },
        },
      });
      expect(JSON.parse(textOf(created)).name).toBe("new-proxy");

      const merged = await client.callTool({
        name: "update_proxy",
        arguments: { name: "proxy-a", patch: { auth: { user: "alice", password: "pw" } } },
      });
      expect(JSON.parse(textOf(merged)).auth.user).toBe("alice");

      const deleted = await client.callTool({
        name: "update_proxy",
        arguments: { name: "proxy-a", patch: null },
      });
      expect(JSON.parse(textOf(deleted))).toEqual({ name: "proxy-a", deleted: true });

      const loaded = await store.load();
      expect(loaded.proxies.map((p) => p.name)).toEqual(["new-proxy"]);
    } finally {
      await cleanup();
    }
  });

  it("returns isError=true for load and not-found failures", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const file = await writeConfig(dir, {
        version: "1", log_level: "trace", jumphosts: [], proxies: [], servers: [],
      });
      const { client } = await connect(new Store(file));
      const bad = await client.callTool({
        name: "list_ssh_servers", arguments: {},
      });
      expect(bad.isError).toBe(true);
      expect(textOf(bad)).toContain("load config:");
    } finally {
      await cleanup();
    }
  });

  it("rejects an invalid update and keeps the original file", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const file = await writeConfig(dir, sample);
      const store = new Store(file);
      const { client } = await connect(store);
      const result = await client.callTool({
        name: "update_ssh_server",
        arguments: { name: "prod-web-01", patch: { auth: {} } },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("pattern A requires auth");
      const loaded = await store.load();
      expect(loaded.servers[0]?.auth.password).toBe("pw");
    } finally {
      await cleanup();
    }
  });
});
```

> `sample` 中 `prod-web-01` 通过 `ssh_j=true` 的 bastion 走 Pattern A，合法。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/mcp/tools_config.test.ts`
Expected: FAIL，`Cannot find module '../../src/mcp/server.js'`

- [ ] **Step 3: 实现 9 个工具 handler**

`src/mcp/tools_config.ts`：

```ts
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

async function loadConfig(svc: Service): Promise<Config> {
  return svc.store.load();
}

function listEntities<T>(
  svc: Service,
  list: (cfg: Config, query: string) => T[],
  query: string | undefined,
): Promise<CallToolResult> {
  return svc.runExclusive(async () => {
    let cfg: Config;
    try {
      cfg = await loadConfig(svc);
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
      cfg = await loadConfig(svc);
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
      cfg = await loadConfig(svc);
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
```

- [ ] **Step 4: 实现 MCP server 注册**

`src/mcp/server.ts`：

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { VERSION } from "../version.js";
import type { Service } from "./service.js";
import {
  getJumphostTool,
  getProxyTool,
  getSSHServerTool,
  listJumphostsTool,
  listProxiesTool,
  listSSHServersTool,
  updateJumphostTool,
  updateProxyTool,
  updateSSHServerTool,
} from "./tools_config.js";

const instructions = `SSH session manager (config tools).
Entity model:
- SSHServer: name, addr (host:port), user, auth, login_flow?, via?, proxy?, tags, host_key_verify?.
- Jumphost: ssh_j=true -> transparent (ssh -J); ssh_j=false -> interactive bastion (login_flow required).
- Proxy: transport HTTP/SOCKS5.
Relationships: SSHServer.via -> Jumphost.name; *.proxy -> Proxy.name.
Query tools: space-separated keywords, AND semantics on name/addr/tags.
Update tools: RFC 7396 JSON Merge Patch; null deletes, object merges or creates.`;

const listSchema = {
  query: z.string().optional().describe(
    "optional, space-separated keywords with AND semantics; each keyword substring-matches name/addr/tags (case-insensitive)",
  ),
};

const getSchema = {
  name: z.string().describe("entity name"),
};

const updateSchema = {
  name: z.string().describe("entity name; if not exist, create"),
  patch: z.any().describe(
    "RFC 7396 JSON Merge Patch; null deletes the entity, object merges (or creates if name not found)",
  ),
};

export function createMcpServer(svc: Service): McpServer {
  const server = new McpServer(
    { name: "sshmng", version: VERSION },
    { instructions },
  );

  server.registerTool("list_ssh_servers", {
    description: "List SSH servers, optionally filtered by query. Query is space-separated keywords with AND semantics: each keyword substring-matches name/addr/tags (case-insensitive), and ALL keywords must match. Empty/whitespace query returns all. Sensitive auth fields are redacted. Use get_ssh_server for full auth.",
    inputSchema: listSchema,
  }, (args) => listSSHServersTool(svc, args));

  server.registerTool("get_ssh_server", {
    description: "Get a single SSH server by name, including full auth. Use to inspect LoginFlow structure or auth method before login.",
    inputSchema: getSchema,
  }, (args) => getSSHServerTool(svc, args));

  server.registerTool("update_ssh_server", {
    description: "Apply RFC 7396 JSON Merge Patch to an SSH server. Patch=null deletes the entity; object merges (or creates if name not found). Patch structure mirrors get_ssh_server output; via/proxy fields reference entity names (strings).",
    inputSchema: updateSchema,
  }, (args) => updateSSHServerTool(svc, args));

  server.registerTool("list_jumphosts", {
    description: "List jumphosts, optionally filtered by query. Query is space-separated keywords with AND semantics (each keyword substring-matches name/addr/tags, case-insensitive; all must match). ssh_j=true means transparent forwarding (ssh -J semantics); ssh_j=false means interactive bastion (login_flow required).",
    inputSchema: listSchema,
  }, (args) => listJumphostsTool(svc, args));

  server.registerTool("get_jumphost", {
    description: "Get a single jumphost by name, including full auth.",
    inputSchema: getSchema,
  }, (args) => getJumphostTool(svc, args));

  server.registerTool("update_jumphost", {
    description: "Apply RFC 7396 JSON Merge Patch to a jumphost. Patch=null deletes; object merges (or creates if name not found). Patch structure mirrors get_jumphost output; via/proxy fields reference entity names.",
    inputSchema: updateSchema,
  }, (args) => updateJumphostTool(svc, args));

  server.registerTool("list_proxies", {
    description: "List transport-layer proxies (HTTP/SOCKS5), optionally filtered by query. Query is space-separated keywords with AND semantics (each keyword substring-matches name/addr/tags, case-insensitive; all must match). Proxies are not SSH jumps — they proxy the underlying TCP connection.",
    inputSchema: listSchema,
  }, (args) => listProxiesTool(svc, args));

  server.registerTool("get_proxy", {
    description: "Get a single proxy by name.",
    inputSchema: getSchema,
  }, (args) => getProxyTool(svc, args));

  server.registerTool("update_proxy", {
    description: "Apply RFC 7396 JSON Merge Patch to a proxy. Patch=null deletes; object merges (or creates if name not found).",
    inputSchema: updateSchema,
  }, (args) => updateProxyTool(svc, args));

  return server;
}

export async function runStdioServer(svc: Service): Promise<void> {
  const server = createMcpServer(svc);
  await server.connect(new StdioServerTransport());
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npm test -- tests/mcp/tools_config.test.ts`
Expected: PASS（6 tests）

如果 `z.any()` 触发 schema 生成警告，改用 `z.unknown()`；工具入参行为不变。

- [ ] **Step 6: 类型检查并提交**

Run: `npm run typecheck`
Expected: PASS

```bash
git add src/mcp/tools_config.ts src/mcp/server.ts tests/mcp/tools_config.test.ts
git commit -m "feat(mcp): register 9 config CRUD tools"
```

---

### Task 8: CLI mcp 与实体查询命令

**Files:**
- Modify: `src/cli/main.ts`
- Create: `src/cli/entity_cmd.ts`
- Test: `tests/cli/entity.test.ts`

- [ ] **Step 1: 写失败的测试**

`tests/cli/entity.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { main } from "../../src/cli/main.js";
import { tempDir, writeConfig } from "../helpers/config.js";

function capture() {
  let out = "";
  let err = "";
  return {
    io: {
      out: (s: string) => { out += s; },
      err: (s: string) => { err += s; },
    },
    get out() { return out; },
    get err() { return err; },
  };
}

const sample = {
  version: "1",
  jumphosts: [{
    name: "bastion", addr: "1.1.1.1:22", user: "ops", auth: { password: "p" },
    ssh_j: true, tags: ["edge"],
  }],
  proxies: [{ name: "proxy-a", type: "SOCKS5", addr: "3.3.3.3:1080" }],
  servers: [{
    name: "prod-web-01", addr: "10.0.0.1:22", user: "deploy",
    auth: { password: "pw", private_key: "/id_rsa" }, via: "bastion",
    tags: ["prod", "web"],
  }],
};

describe("entity CLI", () => {
  it("lists servers as a table with redacted auth", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const file = await writeConfig(dir, sample);
      const c = capture();
      const code = await main(["server", "list", "--config", file], c.io);
      expect(code).toBe(0);
      expect(c.out).toContain("NAME");
      expect(c.out).toContain("prod-web-01");
      expect(c.out).toContain("bastion");
      expect(c.out).not.toContain("pw");
    } finally {
      await cleanup();
    }
  });

  it("filters with multiple positional keywords", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const file = await writeConfig(dir, sample);
      const c = capture();
      const code = await main(["server", "list", "prod", "web", "--config", file], c.io);
      expect(code).toBe(0);
      expect(c.out).toContain("prod-web-01");
    } finally {
      await cleanup();
    }
  });

  it("gets a server detail without leaking the password", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const file = await writeConfig(dir, sample);
      const c = capture();
      const code = await main(["server", "get", "prod-web-01", "--config", file], c.io);
      expect(code).toBe(0);
      expect(c.out).toContain("Name:           prod-web-01");
      expect(c.out).toContain("password=***");
      expect(c.out).not.toContain("pw");
      expect(c.out).toContain("Via:            bastion");
    } finally {
      await cleanup();
    }
  });

  it("returns 1 when the entity is missing", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const file = await writeConfig(dir, sample);
      const c = capture();
      const code = await main(["server", "get", "missing", "--config", file], c.io);
      expect(code).toBe(1);
      expect(c.out).toContain('Error: ssh server "missing" not found');
    } finally {
      await cleanup();
    }
  });

  it("returns 2 for missing entity subcommand", async () => {
    const c = capture();
    const code = await main(["server"], c.io);
    expect(code).toBe(2);
    expect(c.out).toContain("Usage: sshmng server <list|get> [...]");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/cli/entity.test.ts`
Expected: FAIL，`Unknown command "server"`（main 尚未路由）

- [ ] **Step 3: 实现实体命令**

`src/cli/entity_cmd.ts`：

```ts
import { getJumphost, getProxy, getSSHServer, listJumphosts, listProxies, listSSHServers } from "../config/crud.js";
import { Store, resolveConfigPath } from "../config/store.js";
import type { Config, Jumphost, Proxy, SSHServer, SSHAuth } from "../config/types.js";
import type { IO } from "./main.js";

type EntityType = "server" | "jumphost" | "proxy";

function takeConfigFlag(args: string[]): { config?: string; rest: string[] } {
  const rest: string[] = [];
  let config: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--config") {
      const value = args[i + 1];
      if (!value) {
        throw new Error("--config requires a path");
      }
      config = value;
      i += 1;
    } else if (arg.startsWith("--config=")) {
      config = arg.slice("--config=".length);
    } else {
      rest.push(arg);
    }
  }
  return { config, rest };
}

async function load(configPath: string | undefined): Promise<Config> {
  const path = resolveConfigPath(configPath);
  return new Store(path).load();
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
    io.out(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  const query = parsed.rest.join(" ");
  let cfg: Config;
  try {
    cfg = await load(parsed.config);
  } catch (err) {
    io.out(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
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
    io.out(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
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
    io.out(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
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
    io.out(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
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
  return length === 0 ? "(none)" : `${length} actions, entry=${JSON.stringify(entry)}`;
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
```

- [ ] **Step 4: 在 main 中接入 mcp 与实体路由**

将 `src/cli/main.ts` 更新为：

```ts
import { resolveConfigPath, Store } from "../config/store.js";
import { Service } from "../mcp/service.js";
import { runStdioServer } from "../mcp/server.js";
import { BUILD_DATE, COMMIT, goArch, goOS, VERSION } from "../version.js";
import { runEntityCmd } from "./entity_cmd.js";

export interface IO {
  out: (text: string) => void;
  err: (text: string) => void;
}

const defaultIO: IO = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

const helpText = `myssh - SSH session manager

Usage:
  myssh                          Print this help and exit
  myssh mcp [--config <path>]    Start MCP server (stdio)
  myssh version                  Print version
  myssh server <list|get> [...]  List or view SSH servers
  myssh jumphost <list|get> [...]  List or view jumphosts
  myssh proxy <list|get> [...]   List or view proxies
  myssh help | -h | --help       Print this help
`;

function takeConfigFlag(args: string[]): { config?: string; rest: string[] } {
  const rest: string[] = [];
  let config: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--config") {
      const value = args[i + 1];
      if (!value) {
        throw new Error("--config requires a path");
      }
      config = value;
      i += 1;
    } else if (arg.startsWith("--config=")) {
      config = arg.slice("--config=".length);
    } else {
      rest.push(arg);
    }
  }
  return { config, rest };
}

export async function main(args: string[], io: IO = defaultIO): Promise<number> {
  if (args.length === 0 || args[0] === "help" || args[0] === "-h" || args[0] === "--help") {
    io.out(helpText);
    return 0;
  }
  switch (args[0]) {
    case "version":
      io.out(`sshmng ${VERSION} (${goOS()}/${goArch()})\n`);
      io.out(`commit: ${COMMIT}\n`);
      io.out(`built:  ${BUILD_DATE}\n`);
      return 0;
    case "mcp": {
      let config: string | undefined;
      try {
        config = takeConfigFlag(args.slice(1)).config;
      } catch (err) {
        io.err(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        return 2;
      }
      const store = new Store(resolveConfigPath(config));
      try {
        await store.load();
        await runStdioServer(new Service(store));
        return 0;
      } catch (err) {
        io.err(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        return 1;
      }
    }
    case "server":
      return runEntityCmd("server", args.slice(1), io);
    case "jumphost":
      return runEntityCmd("jumphost", args.slice(1), io);
    case "proxy":
      return runEntityCmd("proxy", args.slice(1), io);
    default:
      io.out(`Unknown command ${JSON.stringify(args[0])}. Run 'myssh help' for usage.\n`);
      return 2;
  }
}
```

- [ ] **Step 5: 运行全部测试**

Run: `npm test`
Expected: PASS（全部测试）

- [ ] **Step 6: 构建并手动冒烟**

Run:
```bash
npm run build
node dist/index.js version
node dist/index.js server list --config /tmp/does-not-exist.json
```
Expected:
- 版本三行输出
- 实体列表输出 `No servers found.`（文件不存在时使用默认空配置）

- [ ] **Step 7: 提交**

```bash
git add src/cli/main.ts src/cli/entity_cmd.ts tests/cli/entity.test.ts
git commit -m "feat(cli): add mcp and entity list/get commands"
```

---

### Task 9: M1 验收与文档

**Files:**
- Create: `README.md`
- Modify: `docs/superpowers/plans/2026-11-17-myssh-m1-foundation.md`（勾选完成项）

- [ ] **Step 1: 跑完整验收**

Run:
```bash
npm run typecheck
npm test
npm run build
```
Expected: 全部通过。

- [ ] **Step 2: 用真实 MCP 客户端协议冒烟**

Run:
```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  | node dist/index.js mcp
```
Expected: 输出包含 `"serverInfo":{"name":"sshmng"`，然后进程等待更多输入（Ctrl-C 结束）。

- [ ] **Step 3: 写 README（M1 状态）**

`README.md`：

```markdown
# myssh

`myssh` is a TypeScript/Node.js rewrite of [sshmng](https://github.com/jim58246/sshmng),
targeting zero-install distribution via `npx` and drop-in compatibility with
`~/.sshmng/config.json` and the original MCP tool names.

## Status (M1)

- [x] Project scaffold, build, tests
- [x] Config model, validation, atomic load/save
- [x] entity list/get CLI (`server` / `jumphost` / `proxy`)
- [x] 9 config CRUD MCP tools
- [ ] SSH connections, sessions, PTY, LoginFlow, sftp (M2–M4)
- [ ] install / doctor / Agent injection (M5)

## Usage

```bash
npx -y myssh mcp            # start MCP server (stdio)
npx -y myssh server list
npx -y myssh server get prod-web-01
npx -y myssh version
```

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```
```

- [ ] **Step 4: 提交**

```bash
git add README.md docs/superpowers/plans/2026-11-17-myssh-m1-foundation.md
git commit -m "docs: add M1 README and mark milestone complete"
```

---

## 自审记录

- **Spec 覆盖（M1 范围）**：
  - 工程骨架 / Node ≥ 22 / tsup / vitest → Task 1
  - 配置字段与日志级别 → Task 2
  - 引用完整性、Pattern A/B、LoginFlow 校验 → Task 3
  - 配置路径、`SSHMNG_HOME`、权限检查、原子保存 → Task 4
  - 多关键词 AND 查询、get、Merge Patch、回滚 → Task 5
  - 串行化与结果封装 → Task 6
  - 9 个配置类 MCP 工具、脱敏、错误语义、stdio → Task 7
  - CLI `mcp` / 实体查询 / 版本 / 帮助 → Task 8
  - M1 验收与文档 → Task 9
- **未覆盖但属于后续里程碑**：SSH dialer、session、PTY、sftp、install/doctor、Agent 注入、update/version --check（M2–M6）。
- **占位符检查**：无 TODO/TBD；所有代码步骤均为可执行内容。
- **类型一致性**：`Config` / `Jumphost` / `SSHServer` / `Proxy` 字段在类型、Store、CRUD、MCP、CLI 中一致；`via` / `proxy` 在内存中统一为名字字符串（与原 JSON 表示相同），不再使用指针。
- **已知差异**：MCP `instructions` 在 M1 只描述配置类工具，M6 会替换为与原版一致的完整文本；`patch` 缺失时按 `null` 处理（与 Go 的零值行为一致）。
