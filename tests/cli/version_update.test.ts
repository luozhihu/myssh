import { describe, expect, it } from "vitest";
import { main } from "../../src/cli/main.js";
import { isNewer } from "../../src/cli/semver.js";
import { VERSION, goArch } from "../../src/version.js";

function capture(fetchImpl?: typeof fetch) {
  let out = "";
  return {
    io: {
      out: (text: string) => { out += text; },
      err: () => {},
      env: {},
      platform: "darwin" as const,
      stderrIsTTY: false,
      fetchImpl,
    },
    text: () => out,
  };
}

function response(version: string): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ version }),
  } as Response;
}

describe("isNewer", () => {
  it("compares dotted versions with an optional v prefix", () => {
    expect(isNewer("0.2.0", "0.1.0")).toBe(true);
    expect(isNewer("v0.2.0", "0.1.0")).toBe(true);
    expect(isNewer("0.1.0", "0.1.0")).toBe(false);
    expect(isNewer("0.1.0", "0.1.1")).toBe(false);
    expect(isNewer("1.0.0", "0.9.9")).toBe(true);
  });
});

describe("version --check", () => {
  it("prints the three version lines", async () => {
    const c = capture();
    expect(await main(["version"], c.io)).toBe(0);
    expect(c.text()).toBe(
      `sshmng ${VERSION} (darwin/${goArch(process.arch)})\ncommit: dev\nbuilt:  unknown\n`,
    );
  });

  it("reports a newer npm release", async () => {
    const c = capture(async () => response("9.9.9"));
    expect(await main(["version", "--check"], c.io)).toBe(0);
    expect(c.text()).toContain("Checking latest release ... latest is 9.9.9\n");
    expect(c.text()).toContain(`Update available: ${VERSION} -> 9.9.9\n`);
    expect(c.text()).toContain("Run 'myssh update' to apply.\n");
  });

  it("reports when already at latest", async () => {
    const c = capture(async () => response(VERSION));
    expect(await main(["version", "--check"], c.io)).toBe(0);
    expect(c.text()).toContain("Checking latest release ... already at latest\n");
  });

  it("warns but exits 0 when the registry is unreachable", async () => {
    const c = capture(async () => { throw new Error("offline"); });
    expect(await main(["version", "--check"], c.io)).toBe(0);
    expect(c.text()).toContain("[WARN] remote check failed: offline\n");
  });
});

describe("update", () => {
  it("explains the npx model instead of self-updating", async () => {
    const c = capture();
    expect(await main(["update"], c.io)).toBe(0);
    const text = c.text();
    expect(text.startsWith("myssh update - checking for updates\n\n")).toBe(true);
    expect(text).toContain(`Current version: ${VERSION}\n`);
    expect(text).toContain("Agent configs use \"npx -y myssh@latest\"");
    expect(text).toContain("npx -y myssh@latest version");
  });

  it("rejects unknown flags with exit 2", async () => {
    const c = capture();
    expect(await main(["update", "--nope"], c.io)).toBe(2);
    expect(c.text()).toContain("unknown flag: --nope");
  });
});

describe("dispatch", () => {
  it("prints help with no args and returns 0", async () => {
    const c = capture();
    expect(await main([], c.io)).toBe(0);
    expect(c.text()).toContain("myssh - SSH session manager\n");
    expect(c.text()).toContain("myssh install [...]            First-time setup\n");
    expect(c.text()).toContain("myssh ssh <name> [command]");
    expect(c.text()).toContain("myssh file <upload|download|upload-dir|download-dir|relay>");
  });

  it("returns 2 for unknown commands", async () => {
    const c = capture();
    expect(await main(["wat"], c.io)).toBe(2);
    expect(c.text()).toBe('Unknown command "wat". Run \'myssh help\' for usage.\n');
  });
});
