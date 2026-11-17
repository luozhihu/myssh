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
