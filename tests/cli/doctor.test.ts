import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createInjectors } from "../../src/cli/agent/registry.js";
import { buildEntry } from "../../src/cli/agent/entry.js";
import { runDoctor } from "../../src/cli/doctor.js";
import { scaffoldHome } from "../../src/cli/files.js";
import { VERSION } from "../../src/version.js";
import { tempDir } from "../helpers/config.js";

interface Harness {
  io: {
    out: (text: string) => void;
    err: (text: string) => void;
    env: NodeJS.ProcessEnv;
    homeDir: string;
    platform: NodeJS.Platform;
    stderrIsTTY: boolean;
    readLine: () => Promise<string | null>;
  };
  text: () => string;
}

function harness(homeDir: string): Harness {
  let out = "";
  return {
    io: {
      out: (text) => { out += text; },
      err: () => {},
      env: {},
      homeDir,
      platform: "darwin",
      stderrIsTTY: false,
      readLine: async () => null,
    },
    text: () => out,
  };
}

const deps = {
  findNpx: async () => "/usr/local/bin/npx",
  nodeVersion: "22.11.0",
};

describe("doctor", () => {
  it("passes on a freshly scaffolded home", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      await scaffoldHome(dir, {});
      const h = harness(dir);
      expect(await runDoctor([], h.io, { home: dir, ...deps })).toBe(0);
      const text = h.text();
      expect(text.startsWith("sshmng doctor - verifying setup\n\nHome:\n")).toBe(true);
      expect(text).toContain(`[OK]  ${dir} exists, 0700`);
      expect(text).toContain(`[OK]  ${path.join(dir, "config.json")} exists, 0600, loads OK`);
      expect(text).toContain("[OK]  update_url: not configured (using GitHub Releases)");
      expect(text).toContain(`[OK]  version: ${VERSION}`);
      expect(text).toContain("[OK]  node 22.11.0");
      expect(text).toContain("[OK]  npx on PATH");
      expect(text).toContain("Summary: ");
      expect(text).not.toContain("[FAIL]");
    } finally {
      await cleanup();
    }
  });

  it("fails when the home directory is missing", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const missing = path.join(dir, "nope");
      const h = harness(dir);
      expect(await runDoctor([], h.io, { home: missing, ...deps })).toBe(1);
      expect(h.text()).toContain(`[FAIL]  ${missing} missing - run 'sshmng install' to create`);
    } finally {
      await cleanup();
    }
  });

  it("warns when only the example file is missing", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      await scaffoldHome(dir, {});
      await fs.rm(path.join(dir, "config.example.json"));
      const h = harness(dir);
      expect(await runDoctor([], h.io, { home: dir, ...deps })).toBe(2);
      expect(h.text()).toContain("[WARN]");
    } finally {
      await cleanup();
    }
  });

  it("rejects an update_url with credentials", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      await scaffoldHome(dir, {});
      await fs.writeFile(
        path.join(dir, "config.json"),
        JSON.stringify({ version: "1", update_url: "https://user:pw@example.com/x" }),
        { mode: 0o600 },
      );
      const h = harness(dir);
      expect(await runDoctor([], h.io, { home: dir, ...deps })).toBe(1);
      expect(h.text()).toContain("[FAIL]  invalid update_url: embedded credentials are not allowed");
    } finally {
      await cleanup();
    }
  });

  it("fails when npx is missing", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      await scaffoldHome(dir, {});
      const h = harness(dir);
      expect(await runDoctor([], h.io, {
        home: dir,
        findNpx: async () => null,
        nodeVersion: "22.11.0",
      })).toBe(1);
      expect(h.text()).toContain(
        "[FAIL]  npx not found on PATH - install Node.js >= 22 (includes npx)",
      );
    } finally {
      await cleanup();
    }
  });

  it("verifies detected agents against latest or pinned entries", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      await scaffoldHome(dir, {});
      const ctx = { homeDir: dir, env: {}, platform: "darwin" as const };
      const [claude, codeagent] = createInjectors(ctx);
      await claude!.inject(claude!.configPath(ctx), buildEntry(dir, false));
      await codeagent!.inject(codeagent!.configPath(ctx), buildEntry(dir, true));

      const h = harness(dir);
      expect(await runDoctor([], h.io, { home: dir, ...deps })).toBe(0);
      expect(h.text()).toContain("[OK]  Claude Code config has sshmng entry, command/args/env match");
      expect(h.text()).toContain("[OK]  CodeAgent config has sshmng entry, command/args/env match");
      expect(h.text()).toContain("Hermes Agent (");
      expect(h.text()).toContain(
        "    [SKIP]  not detected (install Hermes Agent or pass --agent hermes to force)",
      );
    } finally {
      await cleanup();
    }
  });

  it("fails a stale agent entry and honours --agent", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      await scaffoldHome(dir, {});
      const ctx = { homeDir: dir, env: {}, platform: "darwin" as const };
      const [claude] = createInjectors(ctx);
      await claude!.inject(claude!.configPath(ctx), {
        command: "node",
        args: ["mcp"],
        env: { SSHMNG_HOME: dir },
      });
      const h = harness(dir);
      expect(await runDoctor(["--agent", "claude-code"], h.io, { home: dir, ...deps })).toBe(1);
      expect(h.text()).toContain("[FAIL]  Claude Code: stale: expected command");
      expect(h.text()).not.toContain("CodeAgent (");
    } finally {
      await cleanup();
    }
  });

  it("reports a too-old node", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      await scaffoldHome(dir, {});
      const h = harness(dir);
      expect(await runDoctor([], h.io, { home: dir, ...deps, nodeVersion: "20.10.0" })).toBe(1);
      expect(h.text()).toContain("[FAIL]  node 20.10.0 is too old; install Node.js >= 22");
    } finally {
      await cleanup();
    }
  });
});
