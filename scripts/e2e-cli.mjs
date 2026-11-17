import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dist = path.resolve("dist/index.js");
const home = mkdtempSync(path.join(tmpdir(), "myssh-e2e-"));
// Isolate Agent detection from the real user configs (HOME on POSIX,
// USERPROFILE on Windows) so doctor's result depends only on this run.
const userHome = mkdtempSync(path.join(tmpdir(), "myssh-e2e-user-"));
const env = {
  ...process.env,
  SSHMNG_HOME: home,
  HOME: userHome,
  USERPROFILE: userHome,
};
let failed = 0;

function run(args) {
  const result = spawnSync(process.execPath, [dist, ...args], {
    env,
    encoding: "utf8",
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

function check(name, condition, detail = "") {
  if (condition) {
    process.stdout.write(`ok ${name}\n`);
    return;
  }
  failed += 1;
  process.stdout.write(`FAIL ${name}\n${detail}\n`);
}

try {
  const version = run(["version"]);
  check("version exit", version.code === 0, version.err);
  check("version text", version.out.startsWith("sshmng "), version.out);

  const help = run(["help"]);
  check("help exit", help.code === 0, help.err);
  check("help mentions install", help.out.includes("myssh install"), help.out);

  const install = run(["install", "--yes", "--skip-agents", "--home", home]);
  check("install exit", install.code === 0, install.out + install.err);
  check("install complete", install.out.includes("Setup complete!"), install.out);
  check(
    "config skeleton",
    readFileSync(path.join(home, "config.json"), "utf8").includes('"servers": []'),
  );

  const doctor = run(["doctor"]);
  check("doctor exit", doctor.code === 0, doctor.out + doctor.err);
  check("doctor summary", doctor.out.includes("Summary: "), doctor.out);

  const list = run(["server", "list"]);
  check("server list exit", list.code === 0, list.err);
  check("server list empty", list.out === "No servers found.\n", list.out);

  const unknown = run(["wat"]);
  check("unknown exit 2", unknown.code === 2, String(unknown.code));
} finally {
  rmSync(home, { recursive: true, force: true });
  rmSync(userHome, { recursive: true, force: true });
}

if (failed > 0) {
  process.stdout.write(`\n${failed} e2e check(s) failed\n`);
  process.exit(1);
}
process.stdout.write("\nall e2e checks passed\n");
