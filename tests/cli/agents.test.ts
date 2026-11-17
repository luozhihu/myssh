import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import type { AgentContext } from "../../src/cli/agent/types.js";
import { buildEntry, expectedEntries } from "../../src/cli/agent/entry.js";
import { createInjectors } from "../../src/cli/agent/registry.js";
import { tempDir } from "../helpers/config.js";

function ctx(homeDir: string, platform: NodeJS.Platform = "darwin", env: NodeJS.ProcessEnv = {}): AgentContext {
  return { homeDir, env, platform };
}

const entry = {
  command: "npx",
  args: ["-y", "myssh@latest", "mcp"],
  env: { SSHMNG_HOME: "/home/u/.sshmng" },
};

describe("buildEntry", () => {
  it("uses npx latest by default and a pinned version when asked", () => {
    expect(buildEntry("/h", false)).toEqual({
      command: "npx",
      args: ["-y", "myssh@latest", "mcp"],
      env: { SSHMNG_HOME: "/h" },
    });
    expect(buildEntry("/h", true, "1.2.3").args).toEqual(["-y", "myssh@1.2.3", "mcp"]);
    expect(expectedEntries("/h", "1.2.3").map((e) => e.args[1]))
      .toEqual(["myssh@latest", "myssh@1.2.3"]);
  });
});

describe("registry", () => {
  it("lists the four injectors in canonical order", () => {
    const injectors = createInjectors(ctx("/home/u"));
    expect(injectors.map((i) => i.name)).toEqual([
      "claude-code", "codeagent", "hermes", "opencode",
    ]);
  });

  it("resolves each config path per platform", () => {
    const unix = createInjectors(ctx("/home/u"));
    expect(unix.map((i) => i.configPath(ctx("/home/u")))).toEqual([
      "/home/u/.claude.json",
      "/home/u/.cac.json",
      "/home/u/.hermes/config.yaml",
      path.join("/home/u", ".config", "opencode", "opencode.json"),
    ]);

    const winCtx = ctx("C:\\Users\\u", "win32", {
      LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
    });
    const win = createInjectors(winCtx);
    expect(win[2]!.configPath(winCtx)).toBe(
      path.win32.join("C:\\Users\\u\\AppData\\Local", "hermes", "config.yaml"),
    );
  });
});

describe("Claude Code / CodeAgent JSON injection", () => {
  it("merges mcpServers, keeps other content, backs up, and verifies", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const claude = createInjectors(ctx(dir))[0]!;
      const file = claude.configPath(ctx(dir));
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify({
        theme: "dark",
        mcpServers: { other: { command: "x" } },
      }));

      await claude.inject(file, entry);
      const parsed = JSON.parse(await readFile(file, "utf8"));
      expect(parsed.theme).toBe("dark");
      expect(parsed.mcpServers.other).toEqual({ command: "x" });
      expect(parsed.mcpServers.sshmng).toEqual(entry);
      expect((await stat(file)).mode & 0o777).toBe(0o600);

      const backups = (await readdir(dir)).filter((name) => name.startsWith(".claude.json.bak."));
      expect(backups).toHaveLength(1);
      expect(backups[0]).toMatch(/\.bak\.\d{8}-\d{6}$/);

      await expect(claude.verify(file, entry)).resolves.toBeUndefined();
      const staleCommand = await claude.verify(file, { ...entry, command: "node" });
      expect(staleCommand?.message).toBe('stale: expected command "node", got "npx"');
    } finally {
      await cleanup();
    }
  });

  it("uses ~/.cac.json for CodeAgent with the Claude Code schema", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const codeagent = createInjectors(ctx(dir))[1]!;
      expect(codeagent.name).toBe("codeagent");
      expect(codeagent.displayName).toBe("CodeAgent");
      const file = codeagent.configPath(ctx(dir));
      await codeagent.inject(file, entry);
      const parsed = JSON.parse(await readFile(file, "utf8"));
      expect(parsed.mcpServers.sshmng).toEqual(entry);
      await expect(codeagent.verify(file, entry)).resolves.toBeUndefined();
      const staleArgs = await codeagent.verify(file, { ...entry, args: ["mcp"] });
      expect(staleArgs?.message).toContain("stale: expected args");
    } finally {
      await cleanup();
    }
  });

  it("reports missing keys with the Go-compatible messages", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const claude = createInjectors(ctx(dir))[0]!;
      const file = path.join(dir, ".claude.json");
      await writeFile(file, "{}");
      expect((await claude.verify(file, entry))?.message)
        .toBe(`no mcpServers key in ${file}`);
      await writeFile(file, '{"mcpServers":{}}');
      expect((await claude.verify(file, entry))?.message)
        .toBe("no sshmng entry in mcpServers");
    } finally {
      await cleanup();
    }
  });
});

describe("Hermes YAML injection", () => {
  it("writes mcp_servers and preserves unrelated YAML keys", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const hermes = createInjectors(ctx(dir))[2]!;
      const file = hermes.configPath(ctx(dir));
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, "model: hermes-1\ntools:\n  enabled: true\n");
      await hermes.inject(file, entry);
      const parsed = parseYaml(await readFile(file, "utf8"));
      expect(parsed.model).toBe("hermes-1");
      expect(parsed.mcp_servers.sshmng).toEqual(entry);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      await expect(hermes.verify(file, entry)).resolves.toBeUndefined();
      const staleHome = await hermes.verify(file, { ...entry, env: { SSHMNG_HOME: "/other" } });
      expect(staleHome?.message)
        .toBe('stale: expected env.SSHMNG_HOME "/other", got "/home/u/.sshmng"');
    } finally {
      await cleanup();
    }
  });
});

describe("OpenCode injection", () => {
  it("uses the local command array schema and verifies it", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const opencode = createInjectors(ctx(dir))[3]!;
      const file = opencode.configPath(ctx(dir));
      await opencode.inject(file, entry);
      const parsed = JSON.parse(await readFile(file, "utf8"));
      expect(parsed.mcp.sshmng).toEqual({
        type: "local",
        command: ["npx", "-y", "myssh@latest", "mcp"],
        environment: { SSHMNG_HOME: "/home/u/.sshmng" },
        enabled: true,
      });
      await expect(opencode.verify(file, entry)).resolves.toBeUndefined();
      const staleCommand = await opencode.verify(file, { ...entry, command: "node" });
      expect(staleCommand?.message).toBe('stale: expected command[0] "node", got "npx"');
      const staleArgs = await opencode.verify(file, { ...entry, args: ["mcp"] });
      expect(staleArgs?.message).toContain("stale: expected command args");
    } finally {
      await cleanup();
    }
  });
});
