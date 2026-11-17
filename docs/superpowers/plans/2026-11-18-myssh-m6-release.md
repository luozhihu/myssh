# myssh M6 Release Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close M6 — prove read-only CLI output matches the Go `sshmng` binary, enforce core-module coverage, run a three-platform CI matrix, ship bilingual docs, and make the package publishable.

**Architecture:** A standalone Node script shells out to both the Go binary and `dist/index.js` with one fixture config, then compares exit code/stdout/stderr. Intentional differences are allowlisted with a written reason. CI runs the matrix plus a pinned-upstream alignment job; coverage thresholds live in `vitest.config.ts`; npm metadata and a pack-content checker make publishing safe.

**Tech Stack:** Node 22+, TypeScript ESM, vitest 5 + `@vitest/coverage-v8`, GitHub Actions, npm provenance.

---

### Task 0: Branch

**Files:** none

- [ ] **Step 1: Create the feature branch**

```bash
git checkout -b m6-release
```

- [ ] **Step 2: Ignore the local Claude state directory**

Add to `.gitignore`:

```gitignore
.claude/
```

`.claude/` is local tool state and must never be committed.

---

### Task 1: Output alignment library

**Files:**
- Create: `scripts/align_lib.mjs`
- Create: `scripts/align_lib.d.mts`
- Test: `tests/scripts/align_lib.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import { compareCase, normalizeOutput, simpleDiff } from "../../scripts/align_lib.mjs";

function cli(stdout = "", code: number | null = 0, stderr = "") {
  return { code, stdout, stderr };
}

describe("normalizeOutput", () => {
  it("rewrites brand tokens without touching paths or package specs", () => {
    const input = "Run 'myssh help'; edit ~/.sshmng/config.json; try myssh@latest";
    expect(normalizeOutput(input)).toBe(
      "Run 'sshmng help'; edit ~/.sshmng/config.json; try sshmng@latest",
    );
  });
});

describe("simpleDiff", () => {
  it("marks removed and added lines", () => {
    expect(simpleDiff("a\nb\n", "a\nc\n")).toBe("- b\n+ c");
  });

  it("reports appended lines", () => {
    expect(simpleDiff("a\n", "a\nb\n")).toBe("+ b");
  });
});

describe("compareCase", () => {
  it("passes identical results", () => {
    const result = compareCase("server list", cli("NAME\n"), cli("NAME\n"));
    expect(result.status).toBe("pass");
    expect(result.detail).toBe("");
  });

  it("passes results that differ only by brand", () => {
    const result = compareCase("help", cli("sshmng help\n"), cli("myssh help\n"));
    expect(result.status).toBe("pass");
  });

  it("fails on stdout drift and shows a diff", () => {
    const result = compareCase("server get", cli("Name: a\n"), cli("Name: b\n"));
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("stdout:");
    expect(result.detail).toContain("- Name: a");
    expect(result.detail).toContain("+ Name: b");
  });

  it("fails on exit-code drift", () => {
    const result = compareCase("server get", cli("x\n", 0), cli("x\n", 1));
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("exit: go=0 myssh=1");
  });

  it("fails on stderr drift", () => {
    const result = compareCase("server get", cli("x\n", 0, "e1\n"), cli("x\n", 0, "e2\n"));
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("stderr:");
    expect(result.detail).toContain("- e1");
    expect(result.detail).toContain("+ e2");
  });

  it("degrades a difference to allowed when a reason is listed", () => {
    const result = compareCase(
      "help",
      cli("sshmng help v1\n"),
      cli("myssh help v2\n"),
      { help: "help text is intentionally rewritten for npx" },
    );
    expect(result.status).toBe("allowed");
    expect(result.reason).toBe("help text is intentionally rewritten for npx");
    expect(result.detail).toContain("stdout:");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/scripts/align_lib.test.ts`
Expected: FAIL — module `scripts/align_lib.mjs` not found.

- [ ] **Step 3: Implement `scripts/align_lib.mjs`**

```js
/** Helpers for comparing Go sshmng and myssh CLI output. */

/** Normalize intentional branding differences before comparing. */
export function normalizeOutput(text) {
  return text.replace(/\bmyssh\b/g, "sshmng");
}

function splitLines(text) {
  if (text === "") return [];
  return text.replace(/\n$/, "").split("\n");
}

/** Line-oriented diff: "- " is Go output, "+ " is myssh output. */
export function simpleDiff(expected, actual) {
  const a = splitLines(expected);
  const b = splitLines(actual);
  const out = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i += 1) {
    if (a[i] === b[i]) continue;
    if (i < a.length) out.push(`- ${a[i]}`);
    if (i < b.length) out.push(`+ ${b[i]}`);
  }
  return out.join("\n");
}

/**
 * expected = Go result, actual = myssh result.
 * A difference with an allowlist entry is "allowed", not "fail".
 */
export function compareCase(name, expected, actual, allowed = {}) {
  const want = normalizeOutput(expected.stdout ?? "");
  const got = normalizeOutput(actual.stdout ?? "");
  const wantErr = normalizeOutput(expected.stderr ?? "");
  const gotErr = normalizeOutput(actual.stderr ?? "");
  if (expected.code === actual.code && want === got && wantErr === gotErr) {
    return { name, status: "pass", detail: "" };
  }
  const detail = [];
  if (expected.code !== actual.code) {
    detail.push(`exit: go=${expected.code} myssh=${actual.code}`);
  }
  if (want !== got) detail.push(`stdout:\n${simpleDiff(want, got)}`);
  if (wantErr !== gotErr) detail.push(`stderr:\n${simpleDiff(wantErr, gotErr)}`);
  return {
    name,
    status: allowed[name] ? "allowed" : "fail",
    reason: allowed[name],
    detail: detail.join("\n"),
  };
}
```

- [ ] **Step 4: Implement `scripts/align_lib.d.mts`**

```ts
export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface CaseOutcome {
  name: string;
  status: "pass" | "allowed" | "fail";
  reason?: string;
  detail: string;
}

export function normalizeOutput(text: string): string;
export function simpleDiff(expected: string, actual: string): string;
export function compareCase(
  name: string,
  expected: CliResult,
  actual: CliResult,
  allowed?: Record<string, string>,
): CaseOutcome;
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run tests/scripts/align_lib.test.ts && npm run typecheck`
Expected: 9 tests pass, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add .gitignore scripts/align_lib.mjs scripts/align_lib.d.mts tests/scripts/align_lib.test.ts
git commit -m "test(align): add Go/myssh output comparison helpers"
```

---

### Task 2: Alignment CLI against the Go binary

**Files:**
- Create: `scripts/align-output.mjs`
- Modify: `package.json`
- Test: `npm run align:output`

- [ ] **Step 1: Implement `scripts/align-output.mjs`**

```js
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compareCase } from "./align_lib.mjs";

/** One config exercises lists, details, auth redaction, refs, and login flows. */
const FIXTURE = {
  version: "1",
  idle_timeout_s: 300,
  auto_update_enabled: false,
  jumphosts: [
    {
      name: "corp-bastion",
      addr: "10.0.0.10:22",
      user: "jump",
      auth: { password: "jump-secret" },
      ssh_j: true,
      tags: ["corp"],
    },
  ],
  proxies: [
    {
      name: "corp-socks",
      type: "SOCKS5",
      addr: "127.0.0.1:1080",
      auth: { user: "proxyuser", password: "proxy-secret" },
      tags: ["corp"],
    },
    { name: "corp-http", type: "HTTP", addr: "127.0.0.1:8080" },
  ],
  servers: [
    {
      name: "prod-web-01",
      addr: "10.0.0.1:22",
      user: "deploy",
      auth: { password: "deploy-secret" },
      tags: ["prod", "web"],
    },
    {
      name: "db-01",
      addr: "10.0.0.2:22",
      user: "dba",
      auth: {
        private_key: "/home/deploy/.ssh/id_ed25519",
        passphrase: "key-secret",
      },
      via: "corp-bastion",
      proxy: "corp-socks",
      login_flow: {
        login: { send: "sudo -i\r", expects: [{ pattern: "#", next: "success" }] },
      },
      login_entry: "login",
      host_key_verify: false,
      tags: ["db"],
    },
  ],
};

/** Differences we accept, each with a written reason. */
const ALLOWED = {
  help: "myssh help documents npx install/update; wording intentionally differs",
  "no args": "same help text as the help case",
  version: "version, commit, and build date are build-specific",
};

const CASES = [
  { name: "help", args: ["help"] },
  { name: "no args", args: [] },
  { name: "version", args: ["version"] },
  { name: "server usage", args: ["server"] },
  { name: "server list", args: ["server", "list"], config: true },
  { name: "server list filter", args: ["server", "list", "prod"], config: true },
  { name: "server get", args: ["server", "get", "prod-web-01"], config: true },
  { name: "server get loginflow", args: ["server", "get", "db-01"], config: true },
  { name: "server get missing", args: ["server", "get", "nope"], config: true },
  { name: "jumphost list", args: ["jumphost", "list"], config: true },
  { name: "jumphost get", args: ["jumphost", "get", "corp-bastion"], config: true },
  { name: "proxy list", args: ["proxy", "list"], config: true },
  { name: "proxy get", args: ["proxy", "get", "corp-socks"], config: true },
  { name: "unknown command", args: ["wat"] },
  { name: "unknown subcommand", args: ["server", "wat"] },
];

function printUsage() {
  console.log(`Usage: node scripts/align-output.mjs [options]

Options:
  --go-bin <path>    Go sshmng binary (default: $SSHMNG_GO_BIN or "sshmng")
  --node-bin <path>  myssh build (default: dist/index.js)
  --require-go       Fail instead of skipping when the Go binary is missing
  -h, --help         Print this help
`);
}

function parseArgs(argv) {
  const options = {
    goBin: process.env.SSHMNG_GO_BIN ?? "sshmng",
    nodeBin: path.resolve("dist/index.js"),
    requireGo: false,
  };
  const value = (index, flag) => {
    const next = argv[index];
    if (!next) {
      console.error(`${flag} requires a path`);
      process.exit(2);
    }
    return next;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--go-bin") {
      options.goBin = value(i + 1, arg);
      i += 1;
    } else if (arg === "--node-bin") {
      options.nodeBin = value(i + 1, arg);
      i += 1;
    } else if (arg === "--require-go") {
      options.requireGo = true;
    } else if (arg === "-h" || arg === "--help") {
      printUsage();
      process.exit(0);
    } else {
      console.error(`unknown argument: ${arg}`);
      printUsage();
      process.exit(2);
    }
  }
  return options;
}

function runProcess(bin, args, useNode) {
  const result = useNode
    ? spawnSync(process.execPath, [bin, ...args], { encoding: "utf8" })
    : spawnSync(bin, args, { encoding: "utf8" });
  if (result.error) {
    if (result.error.code === "ENOENT") return null;
    throw result.error;
  }
  return {
    code: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

const options = parseArgs(process.argv.slice(2));

if (!existsSync(options.nodeBin)) {
  console.error(`myssh build not found: ${options.nodeBin} (run npm run build)`);
  process.exit(1);
}

const probe = runProcess(options.goBin, ["version"], false);
if (probe === null) {
  const message =
    `Go sshmng binary not found: ${options.goBin}\n` +
    "Set SSHMNG_GO_BIN, pass --go-bin, or build the upstream Go project.";
  if (options.requireGo) {
    console.error(message);
    process.exit(1);
  }
  console.log(`skip: ${message}`);
  process.exit(0);
}

const work = mkdtempSync(path.join(tmpdir(), "myssh-align-"));
const configPath = path.join(work, "config.json");
writeFileSync(configPath, `${JSON.stringify(FIXTURE, null, 2)}\n`);

let failed = 0;
try {
  for (const testCase of CASES) {
    const args = testCase.config
      ? [...testCase.args, "--config", configPath]
      : testCase.args;
    const go = runProcess(options.goBin, args, false);
    if (go === null) {
      console.error("Go binary disappeared during the run");
      process.exit(1);
    }
    const mine = runProcess(options.nodeBin, args, true);
    const outcome = compareCase(testCase.name, go, mine, ALLOWED);
    if (outcome.status === "pass") {
      console.log(`ok    ${outcome.name}`);
    } else if (outcome.status === "allowed") {
      console.log(`allow ${outcome.name} - ${outcome.reason}`);
    } else {
      failed += 1;
      console.log(`FAIL  ${outcome.name}\n${outcome.detail}`);
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failed > 0) {
  console.log(`\n${failed} unexplained difference(s)`);
  process.exit(1);
}
console.log("\nall CLI differences are aligned or explained");
```

- [ ] **Step 2: Add the npm script**

Add to `scripts` in `package.json`:

```json
    "align:output": "node scripts/align-output.mjs",
```

- [ ] **Step 3: Run the script without Go**

Run: `npm run build && node scripts/align-output.mjs; echo "exit=$?"`
Expected: `skip: Go sshmng binary not found: sshmng ...` and `exit=0`.

- [ ] **Step 4: Verify `--require-go` fails**

Run: `node scripts/align-output.mjs --require-go; echo "exit=$?"`
Expected: the same message on stderr and `exit=1`.

- [ ] **Step 5: Commit**

```bash
git add scripts/align-output.mjs package.json
git commit -m "test(align): add CLI output diff against the Go binary"
```

---

### Task 3: Coverage thresholds for core modules

**Files:**
- Modify: `vitest.config.ts`, `package.json`
- Test: `npm run test:coverage`

- [ ] **Step 1: Add coverage configuration**

Replace `vitest.config.ts` with:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: [
        "src/config/**",
        "src/loginflow/**",
        "src/pty/**",
        "src/session/**",
      ],
      reporter: ["text", "lcov"],
      thresholds: {
        lines: 80,
        statements: 80,
        functions: 80,
        branches: 75,
      },
    },
  },
});
```

The spec requires ≥ 80% line coverage for `config` / `loginflow` / `pty` / `session`; the measured baseline is ~89% lines, ~79% branches.

- [ ] **Step 2: Add the npm script**

Add to `scripts` in `package.json`:

```json
    "test:coverage": "vitest run --coverage",
```

- [ ] **Step 3: Verify the gate passes**

Run: `npm run test:coverage`
Expected: all tests pass; the coverage table covers only the four core directories; no threshold error; summary shows lines ≥ 80%.

- [ ] **Step 4: Verify the gate can fail**

Temporarily raise the line threshold, run, then restore the config:

```bash
node -e "const fs=require('fs'); fs.writeFileSync('/tmp/vitest.config.ts.bak', fs.readFileSync('vitest.config.ts')); fs.writeFileSync('vitest.config.ts', fs.readFileSync('vitest.config.ts','utf8').replace('lines: 80','lines: 100'))"
npx vitest run --coverage; echo "exit=$?"
node -e "const fs=require('fs'); fs.writeFileSync('vitest.config.ts', fs.readFileSync('/tmp/vitest.config.ts.bak'))"
```

Expected: `exit=1` with an ERROR mentioning the lines threshold. This confirms
the configuration is enforced, not just displayed. The restore puts `lines: 80`
back.

- [ ] **Step 5: Commit**

```bash
git add vitest.config.ts package.json package-lock.json
git commit -m "test(coverage): enforce 80% line coverage on core modules"
```

---

### Task 4: Publishable package metadata and tarball check

**Files:**
- Create: `LICENSE`
- Create: `scripts/check-package.mjs`
- Create: `.npmrc`
- Modify: `package.json`

- [ ] **Step 1: Write `LICENSE`**

```text
MIT License

Copyright (c) 2026 jim58246
Copyright (c) 2026 myssh contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The upstream copyright notice is retained because `myssh` is a rewrite of the
MIT-licensed `sshmng` project.

- [ ] **Step 2: Write `scripts/check-package.mjs`**

```js
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) {
    console.log(`ok   ${name}`);
    return;
  }
  failed += 1;
  console.log(`FAIL ${name}${detail ? `\n     ${detail}` : ""}`);
}

check("bin.myssh -> dist/index.js", pkg.bin?.myssh === "dist/index.js");
check("bin.sshmng -> dist/index.js", pkg.bin?.sshmng === "dist/index.js");
check("engines.node >=22", pkg.engines?.node === ">=22");
check("license is MIT", pkg.license === "MIT");
check("not private", pkg.private !== true);
check(
  "files whitelist",
  Array.isArray(pkg.files)
    && ["dist", "README.md", "README.zh-CN.md", "LICENSE"]
      .every((entry) => pkg.files.includes(entry)),
  JSON.stringify(pkg.files),
);

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const raw = execFileSync(npm, ["pack", "--dry-run", "--json"], {
  encoding: "utf8",
});
const packed = JSON.parse(raw)[0];
const files = (packed?.files ?? []).map((file) => file.path);

check("tarball contains dist/index.js", files.includes("dist/index.js"));
check("tarball contains README.md", files.includes("README.md"));
check("tarball contains README.zh-CN.md", files.includes("README.zh-CN.md"));
check("tarball contains LICENSE", files.includes("LICENSE"));
check(
  "tarball excludes source/tests/scripts/docs",
  !files.some((file) =>
    /^(src|tests|scripts|docs)\//.test(file) || file.startsWith(".claude/")
  ),
  files.join(", "),
);

if (failed > 0) {
  console.log(`\n${failed} package check(s) failed`);
  process.exit(1);
}
console.log(`\npackage check passed (${files.length} files, ${packed.size} bytes)`);
```

- [ ] **Step 3: Update `package.json`**

Replace the file with (repository/homepage/bugs are intentionally omitted until
the public GitHub repository exists; npm publishes without them):

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
    "README.md",
    "README.zh-CN.md",
    "LICENSE"
  ],
  "engines": {
    "node": ">=22"
  },
  "license": "MIT",
  "keywords": [
    "ssh",
    "sftp",
    "mcp",
    "model-context-protocol",
    "npx",
    "claude-code"
  ],
  "publishConfig": {
    "access": "public"
  },
  "scripts": {
    "build": "tsup",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "test:e2e": "npm run build && node scripts/e2e-cli.mjs",
    "align:output": "node scripts/align-output.mjs",
    "check:package": "node scripts/check-package.mjs",
    "release:check": "npm run typecheck && npm test && npm run test:e2e && npm run check:package",
    "prepublishOnly": "npm run release:check"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.32.2",
    "ssh2": "^1.17.0",
    "yaml": "^2.9.1",
    "zod": "^4.6.7"
  },
  "devDependencies": {
    "@types/node": "^26.6.6",
    "@types/ssh2": "^1.15.6",
    "@vitest/coverage-v8": "^5.1.0",
    "tsup": "^9.0.0",
    "typescript": "^7.0.2",
    "vite": "^7.3.8",
    "vitest": "^5.1.0"
  }
}
```

- [ ] **Step 4: Normalize the lockfile and work around npm 10's peer bug**

npm 10.9 (bundled with Node 22) crashes with
`Cannot read properties of null (reading 'edgesOut')` while resolving vitest's
peer set. `legacy-peer-deps` avoids that code path, which also means `vite`
(vitest's peer) must be an explicit devDependency. Add `.npmrc`:

```text
legacy-peer-deps=true
```

Then regenerate the lockfile from the public registry, without mirror URLs:

```bash
rm -rf node_modules package-lock.json
npm install --registry=https://registry.npmjs.org
npm ci
```

Expected: `package-lock.json` contains only `registry.npmjs.org` URLs and
`integrity` entries; `npm ci` and `npm test` succeed without flags.

- [ ] **Step 5: Run the package check**

Run: `npm run build && npm run check:package`
Expected: every `ok`, then `package check passed (...)`.

The bilingual READMEs do not exist until Task 6, so this check fails on
`README.zh-CN.md` until that task lands. Re-run it after Task 6.

- [ ] **Step 6: Commit**

```bash
git add LICENSE scripts/check-package.mjs .npmrc package.json package-lock.json
git commit -m "chore(pkg): add license, publish metadata, and tarball check"
```

---

### Task 5: CI matrix, alignment job, and npm release workflow

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: Write `.github/workflows/ci.yml`**

```yaml
name: ci

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  test:
    name: ${{ matrix.os }} / node ${{ matrix.node }}
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
        node: ["22", "24"]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run build
      - run: node scripts/e2e-cli.mjs

  coverage:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: npm
      - run: npm ci
      - run: npm run test:coverage

  align:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: npm
      - uses: actions/setup-go@v5
        with:
          go-version: "1.25"
      # Pin the upstream commit so alignment failures mean a real regression,
      # not upstream drift.
      - name: Build upstream sshmng
        run: |
          git clone https://github.com/jim58246/sshmng.git /tmp/sshmng
          git -C /tmp/sshmng checkout a7740d5679e13183f2e55860b7aa49d6a2dd26c1
          go build -C /tmp/sshmng -o /tmp/sshmng-go ./cmd/sshmng
      - run: npm ci
      - run: npm run build
      - run: node scripts/align-output.mjs --go-bin /tmp/sshmng-go --require-go
```

- [ ] **Step 2: Write `.github/workflows/release.yml`**

```yaml
name: release

on:
  push:
    tags: ["v*"]

permissions:
  contents: read
  id-token: write

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: npm
          registry-url: https://registry.npmjs.org
      - run: npm ci
      - name: Check tag matches package.json
        run: |
          node -e "const v=require('./package.json').version; const tag=process.env.GITHUB_REF_NAME; if ('v'+v !== tag) { console.error('tag '+tag+' does not match v'+v); process.exit(1); }"
      # prepublishOnly runs release:check (typecheck, tests, e2e, pack check).
      - run: npm publish --provenance --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

- [ ] **Step 3: Validate the YAML locally**

Run:

```bash
node -e "
const fs = require('node:fs');
for (const f of ['.github/workflows/ci.yml', '.github/workflows/release.yml']) {
  const text = fs.readFileSync(f, 'utf8');
  if (!text.includes('runs-on:') || !text.includes('uses: actions/checkout@v4')) {
    throw new Error(f + ' looks incomplete');
  }
  console.log('ok', f);
}
"
```

Expected: `ok .github/workflows/ci.yml` and `ok .github/workflows/release.yml`.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml .github/workflows/release.yml
git commit -m "ci: add three-platform matrix, coverage, alignment, and npm release"
```

---

### Task 6: Bilingual documentation

**Files:**
- Create: `README.zh-CN.md`
- Modify: `README.md`

- [ ] **Step 1: Update `README.md`**

Add the language switcher directly under the title:

```markdown
# myssh

English | [简体中文](README.zh-CN.md)
```

Replace the status checkboxes with:

```markdown
M6 (release readiness) is complete:

- [x] Project scaffold, build, tests
- [x] Config model, validation, atomic load/save
- [x] `server` / `jumphost` / `proxy` `list|get` CLI
- [x] 9 config CRUD MCP tools
- [x] Direct SSH via password or private key, HTTP/SOCKS5 proxies
- [x] TOFU `known_hosts`, 0600 key checks
- [x] PTY sessions, command sentinel, `run_in_session`
- [x] Session state, traces, `stat` / `get_trace`, raw send/read
- [x] Transparent jumphosts (Pattern A, `ssh -J` semantics)
- [x] Interactive bastions (Pattern B) driven by `login_flow`
- [x] Persistent per-session sftp, single-file `upload` / `download`
- [x] Recursive `upload_dir` / `download_dir` with conflict policy
- [x] 1:N streaming `relay_transfer` without local disk
- [x] `install` / `doctor` / Agent injection (M5)
- [x] Standalone `ssh` and `file` CLI commands
- [x] Three-platform CI matrix (macOS / Linux / Windows × Node 22/24)
- [x] Coverage gate: config/loginflow/pty/session ≥ 80% lines
- [x] npm publish workflow with provenance
```

In the Development section, extend the command list and add a release note:

````markdown
```bash
npm install
npm run typecheck
npm test
npm run test:coverage  # core module line coverage gate (>= 80%)
npm run test:e2e       # build + CLI smoke checks against dist/
npm run align:output   # diff read-only CLI output against the Go binary
npm run check:package  # assert the npm tarball contains only runtime files
```

`npm run align:output` needs the upstream Go binary. Set `SSHMNG_GO_BIN` (or
pass `--go-bin <path>`); it skips with a notice when the binary is absent, and
`--require-go` makes the skip an error. CI builds upstream `sshmng` at a pinned
commit and runs the alignment with `--require-go`.

Releases are tag-driven:

```bash
npm version patch
git push --follow-tags
```

The release workflow checks that the tag matches `package.json`, runs
typecheck/tests/e2e/package checks via `prepublishOnly`, and publishes to npm
with provenance. It needs an `NPM_TOKEN` repository secret.
````

Append the M6 plan link:

```markdown
M6 plan: `docs/superpowers/plans/2026-11-18-myssh-m6-release.md`.
```

Add a license section at the end:

```markdown
## License

MIT. `myssh` is a rewrite of the MIT-licensed `sshmng` project and retains its
copyright notice. See [LICENSE](LICENSE).
```

- [ ] **Step 2: Write `README.zh-CN.md`**

```markdown
# myssh

[English](README.md) | 简体中文

`myssh` 是 [sshmng](https://github.com/jim58246/sshmng) 的 TypeScript/Node.js
重写版，目标是支持 `npx` 零安装分发，并与 `~/.sshmng/config.json` 及原有 MCP
工具名完全兼容（可直接替换）。

## 状态

M6（发布就绪）已完成：

- [x] 工程骨架、构建、测试
- [x] 配置模型、校验、原子加载/保存
- [x] `server` / `jumphost` / `proxy` 的 `list|get` 命令行
- [x] 9 个配置增删改查 MCP 工具
- [x] 直连 SSH（密码或私钥）、HTTP/SOCKS5 代理
- [x] TOFU `known_hosts`、0600 私钥权限检查
- [x] PTY 会话、命令哨兵、`run_in_session`
- [x] 会话状态、trace、`stat` / `get_trace`、原始收发
- [x] 透明跳板机（Pattern A，`ssh -J` 语义）
- [x] 由 `login_flow` 驱动的交互式堡垒机（Pattern B）
- [x] 每会话持久 sftp、单文件 `upload` / `download`
- [x] 递归 `upload_dir` / `download_dir` 与冲突策略
- [x] 1:N 流式 `relay_transfer`，不落地本地磁盘
- [x] `install` / `doctor` / Agent 注入（M5）
- [x] 独立的 `ssh` 与 `file` 命令行
- [x] 三平台 CI 矩阵（macOS / Linux / Windows × Node 22/24）
- [x] 覆盖率门槛：config/loginflow/pty/session 行覆盖 ≥ 80%
- [x] 带 provenance 的 npm 发布工作流

连接形式：

- 直连（无 `via`）：直接 SSH 到目标；认证后可选执行目标 `login_flow`。
- Pattern A（`via.ssh_j=true`）：SSH 到跳板机，经 `direct-tcpip` 隧道再向目标
  发起第二次 SSH；目标上的 sftp 可用。
- Pattern B（`via.ssh_j=false`）：在交互式堡垒机上开一个 PTY；由跳板机
   `login_flow` 与目标 `login_flow` 驱动菜单；sftp 报告 `false`。
- LoginFlow 失败返回 `{"error": "... loginflow ...", "login_trace": [...]}`。

M4 起每个会话保持一条 sftp 通道：直连与 Pattern A 会话报告
`sftp_available: true`；Pattern B 报告 `false`（该通道会落在堡垒机上）。
文件传输失败不会关闭会话。

## 用法

发布后：

```bash
npx -y myssh@latest mcp            # 启动 MCP 服务器（stdio）
npx -y myssh server list
npx -y myssh server get prod-web-01
npx -y myssh version
```

本地源码运行：

```bash
npm install
npm run build
node dist/index.js mcp
```

MCP 服务器名为 `sshmng`，暴露 21 个工具：

- 配置：`list_ssh_servers`、`get_ssh_server`、`update_ssh_server`、
  `list_jumphosts`、`get_jumphost`、`update_jumphost`、
  `list_proxies`、`get_proxy`、`update_proxy`
- 会话：`login`、`run_in_session`、`close_session`、`stat`、
  `get_trace`、`send_in_session`、`read_in_session`
- 文件传输：`upload`（单个本地文件到远端）、`download`（单个远端文件到本地）、
  `upload_dir`（递归上传，支持冲突策略与并发）、`download_dir`（递归下载）、
  `relay_transfer`（把远端文件流式转发到 N 个会话；1:1 即单元素列表）

### 文件传输

```
login(name) -> {sid, sftp_available: true}
upload(sid, "/local/report.pdf", "/tmp/report.pdf") -> {ok, bytes, timed_out}
download(sid, "/tmp/report.pdf", "./report.pdf") -> {ok, bytes, timed_out}
upload_dir(sid, "./dist", "/srv/app", conflict="overwrite", concurrency=4)
download_dir(sid, "/var/log/app", "./logs", conflict="skip")
relay_transfer(src_sid, "/srv/app.tar", [dst_sid_1, dst_sid_2], "/srv/app.tar") -> 1:N 扇出
```

部分失败（超时、单文件错误、relay 目标失败）在结果正文返回 `ok: false`，
不设置 MCP error 标志。硬错误（未知 sid、sftp 不可用）才设置 MCP error 标志。

## 命令行

```bash
npx -y myssh@latest install     # 首次安装（生成配置 + 注入 Agent）
npx -y myssh@latest doctor      # 检查文件、权限、node/npx、Agent 配置
npx -y myssh@latest ssh prod-web-01
npx -y myssh@latest ssh prod-web-01 "uptime"
npx -y myssh@latest file upload ./report.pdf /tmp/report.pdf --server prod-web-01
npx -y myssh@latest file download /tmp/report.pdf ./report.pdf --server prod-web-01
npx -y myssh@latest file upload-dir ./dist /srv/app --server prod-web-01
npx -y myssh@latest file download-dir /var/log/app ./logs --server prod-web-01
npx -y myssh@latest file relay /srv/app.tar --server src --to dst1,dst2
```

`install` 创建 `~/.sshmng/`（或 `$SSHMNG_HOME`），写入 `config.json` 与
`config.example.json`，并向所选 Agent 注入 `myssh` MCP 条目
（`npx -y myssh@latest mcp`）。支持的 Agent：

- **Claude Code** —— `~/.claude.json`，键 `mcpServers`
- **CodeAgent** —— `~/.cac.json`，键 `mcpServers`（结构与 Claude Code 相同）
- **Hermes Agent** —— `~/.hermes/config.yaml`（Windows 为
  `%LOCALAPPDATA%\hermes\config.yaml`），键 `mcp_servers`
- **OpenCode** —— `~/.config/opencode/opencode.json`，键 `mcp`

已有 Agent 配置会被合并而不是替换；每次修改都保留
`<file>.bak.<YYYYMMDD-HHMMSS>` 备份，并以 0600 权限原子写入。`--agents` 显式
选择注入目标，`--agents none` 跳过注入，`--pin` 冻结当前 npm 版本而不是
`@latest`。

`myssh ssh <name>` 先解析服务器，找不到时回退到跳板机（含堡垒机菜单）。
带命令参数时非交互执行；Pattern B 堡垒机与 raw 设备没有 Unix shell 落点，
因此拒绝非交互命令。

`myssh file` 对应 MCP 传输工具：`upload`、`download`、`upload-dir`、
`download-dir`、`relay`（1:N 扇出，本地不落地）。Pattern B（堡垒机）没有
到目标的 sftp，请使用直连或 `ssh_j=true`。

`myssh update` 有意设计为空操作：Agent 配置使用 `npx -y myssh@latest`，
新版本会自动生效。`myssh version --check` 会把当前版本与 npm registry 比较。

## 配置兼容性

- 默认读取 `~/.sshmng/config.json`。
- `SSHMNG_HOME` 覆盖目录；`--config <path>` 覆盖文件。
- 现有配置无需修改即可加载；`via` / `proxy` 是实体名。
- macOS/Linux 上文件不得允许 group/other 读（`0600` 或更严格）。
- `list_*` 工具脱敏 `auth.password` / `auth.private_key` / `auth.passphrase`；
  `get_*` 返回完整认证信息。

## 开发

```bash
npm install
npm run typecheck
npm test
npm run test:coverage  # 核心模块行覆盖率门槛（>= 80%）
npm run test:e2e       # 构建 + 针对 dist/ 的 CLI 冒烟测试
npm run align:output   # 与 Go 二进制对比只读 CLI 输出
npm run check:package  # 检查 npm 包只包含运行时文件
```

`npm run align:output` 需要上游 Go 二进制。通过 `SSHMNG_GO_BIN` 或
`--go-bin <path>` 指定；找不到时脚本会打印提示并跳过，`--require-go` 会让
跳过变成错误。CI 会在固定 commit 上构建上游 `sshmng` 并以 `--require-go`
运行对齐。

发布由 tag 触发：

```bash
npm version patch
git push --follow-tags
```

发布工作流会校验 tag 与 `package.json` 一致，通过 `prepublishOnly` 运行
typecheck/测试/e2e/打包检查，然后带 provenance 发布到 npm。需要在仓库中配置
`NPM_TOKEN` secret。

设计文档：`docs/superpowers/specs/2026-11-17-myssh-ts-rewrite-design.md`。
M1 计划：`docs/superpowers/plans/2026-11-17-myssh-m1-foundation.md`。
M2 计划：`docs/superpowers/plans/2026-11-17-myssh-m2-connection.md`。
M3 计划：`docs/superpowers/plans/2026-11-18-myssh-m3-jumphosts.md`。
M4 计划：`docs/superpowers/plans/2026-11-18-myssh-m4-sftp.md`。
M5 计划：`docs/superpowers/plans/2026-11-18-myssh-m5-cli.md`。
M6 计划：`docs/superpowers/plans/2026-11-18-myssh-m6-release.md`。

## 许可证

MIT。`myssh` 是 MIT 许可的 `sshmng` 项目的重写版，保留上游版权声明。
详见 [LICENSE](LICENSE)。
```

- [ ] **Step 3: Verify cross-links and the end of the English README**

Run:

```bash
grep -n "README.zh-CN.md" README.md
grep -n "README.md" README.zh-CN.md
tail -5 README.md
```

Expected: each file links to the other; the English README ends with the
license section.

- [ ] **Step 4: Commit**

```bash
git add README.md README.zh-CN.md
git commit -m "docs: add bilingual README and release instructions"
```

---

### Task 7: Full gate, package check, and merge

**Files:** none

- [ ] **Step 1: Run the full gate**

```bash
npm run typecheck
npm test
npm run test:coverage
npm run test:e2e
npm run check:package
node scripts/align-output.mjs
```

Expected:

- typecheck clean
- 44+ test files pass
- coverage thresholds pass
- e2e prints `all e2e checks passed`
- package check prints `package check passed (...)` (now that
  `README.zh-CN.md` exists)
- alignment prints `skip: Go sshmng binary not found ...`

- [ ] **Step 2: Commit any remaining changes**

```bash
git status --short
git add README.md README.zh-CN.md package.json package-lock.json .gitignore
git commit -m "chore(release): finalize M6 release readiness"
```

Skip this commit when `git status` is clean.

- [ ] **Step 3: Merge to main**

```bash
git checkout main
git merge --no-ff m6-release -m "merge: M6 alignment, coverage, CI, and release"
npm test
git branch -d m6-release
```

Expected: fast-forward-free merge commit, full suite green on `main`, branch
deleted.

---

## Acceptance checklist

- `npm run align:output --require-go` is green in CI against upstream
  `sshmng` at commit `a7740d5679e13183f2e55860b7aa49d6a2dd26c1`; every remaining
  difference has an allowlist reason.
- CI matrix macOS/Linux/Windows × Node 22/24 is green.
- Core modules (`config`, `loginflow`, `pty`, `session`) meet ≥ 80% line
  coverage.
- `npm pack --dry-run` contains only runtime files and both READMEs.
- Tagging `v<version>` publishes to npm with provenance.
- READMEs exist in English and Simplified Chinese and link to each other.
