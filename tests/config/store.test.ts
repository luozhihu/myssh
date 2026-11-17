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
