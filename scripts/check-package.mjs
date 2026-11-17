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
// --ignore-scripts keeps prepack's build output out of the JSON stream; the
// release gate builds dist/ before this check runs.
const raw = execFileSync(npm, ["pack", "--dry-run", "--json", "--ignore-scripts"], {
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
