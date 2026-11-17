import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runInstall } from "../../src/cli/install.js";
import { VERSION } from "../../src/version.js";
import { tempDir } from "../helpers/config.js";

function capture(lines: Array<string | null>, homeDir: string) {
  let out = "";
  let index = 0;
  return {
    io: {
      out: (text: string) => { out += text; },
      err: () => {},
      env: {},
      homeDir,
      platform: "darwin" as const,
      stderrIsTTY: false,
      readLine: async () => lines[index++] ?? null,
    },
    text: () => out,
  };
}

const deps = { findNpx: async () => "/usr/bin/npx", nodeVersion: "22.11.0" };

describe("install", () => {
  it("non-interactive install scaffolds files and injects selected agents", async () => {
    const home = await tempDir();
    const user = await tempDir();
    try {
      const c = capture([], user.dir);
      const code = await runInstall(
        ["--yes", "--pin", "--agents", "claude-code,codeagent", "--home", home.dir],
        c.io,
        deps,
      );
      expect(code).toBe(0);
      expect(await fs.readFile(path.join(home.dir, "config.json"), "utf8")).toContain('"version": "1"');
      const claude = JSON.parse(await fs.readFile(path.join(user.dir, ".claude.json"), "utf8"));
      expect(claude.mcpServers.sshmng).toEqual({
        command: "npx",
        args: ["-y", `@lzh-dev/myssh@${VERSION}`, "mcp"],
        env: { SSHMNG_HOME: home.dir },
      });
      expect(existsSync(path.join(user.dir, ".cac.json"))).toBe(true);
      expect(existsSync(path.join(user.dir, ".hermes", "config.yaml"))).toBe(false);
      const text = c.text();
      expect(text).toContain("Executing:\n");
      expect(text).toContain(`  [ok] Created ${home.dir} (0700)\n`);
      expect(text).toContain(`  [ok] Injected sshmng into ${path.join(user.dir, ".claude.json")}\n`);
      expect(text).toContain("Verifying (doctor):\n");
      expect(text).toContain("Setup complete!\n");
      expect(text).toContain("  1. Restart your Agent to load the new MCP config\n");
    } finally {
      await home.cleanup();
      await user.cleanup();
    }
  });

  it("skips agents with --agents none", async () => {
    const home = await tempDir();
    const user = await tempDir();
    try {
      const c = capture([], user.dir);
      expect(await runInstall(["--yes", "--agents", "none", "--home", home.dir], c.io, deps))
        .toBe(0);
      expect(existsSync(path.join(user.dir, ".claude.json"))).toBe(false);
      expect(c.text()).not.toContain("Injected");
    } finally {
      await home.cleanup();
      await user.cleanup();
    }
  });

  it("interactive install shows detected agents and confirms", async () => {
    const home = await tempDir();
    const user = await tempDir();
    try {
      await fs.writeFile(path.join(user.dir, ".claude.json"), "{}");
      // enter (accept detection), then "y" to proceed
      const c = capture(["", "y"], user.dir);
      expect(await runInstall(["--home", home.dir], c.io, deps)).toBe(0);
      const text = c.text();
      expect(text).toContain("Detected Agents:\n");
      expect(text).toContain("  [*] 1. Claude Code");
      expect(text).toContain("Toggle (1-N), 's' to skip, enter to confirm: ");
      expect(text).toContain("Review:\n");
      expect(text).toContain("Proceed? [y/N]: ");
      expect(text).toContain("Setup complete!\n");
    } finally {
      await home.cleanup();
      await user.cleanup();
    }
  });

  it("aborts cleanly on a declined prompt", async () => {
    const home = await tempDir();
    const user = await tempDir();
    try {
      const c = capture(["", "n"], user.dir);
      expect(await runInstall(["--home", home.dir], c.io, deps)).toBe(0);
      expect(c.text()).toContain("Aborted.\n");
      expect(existsSync(path.join(home.dir, "config.json"))).toBe(false);
    } finally {
      await home.cleanup();
      await user.cleanup();
    }
  });

  it("returns 1 when doctor fails", async () => {
    const home = await tempDir();
    const user = await tempDir();
    try {
      const c = capture([], user.dir);
      const code = await runInstall(["--yes", "--agents", "none", "--home", home.dir], c.io, {
        findNpx: async () => null,
        nodeVersion: "22.11.0",
      });
      expect(code).toBe(1);
      expect(c.text()).toContain("Setup completed with errors. Run 'sshmng doctor' for details.\n");
    } finally {
      await home.cleanup();
      await user.cleanup();
    }
  });
});
