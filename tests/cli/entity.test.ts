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

  it("prints jumphost and proxy tables", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const file = await writeConfig(dir, sample);
      const j = capture();
      expect(await main(["jumphost", "list", "--config", file], j.io)).toBe(0);
      expect(j.out).toContain("SSH_J");
      expect(j.out).toContain("bastion");
      const p = capture();
      expect(await main(["proxy", "list", "--config", file], p.io)).toBe(0);
      expect(p.out).toContain("SOCKS5");
      expect(p.out).toContain("proxy-a");
    } finally {
      await cleanup();
    }
  });

  it("prints a proxy detail with masked password", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const cfg = {
        ...sample,
        proxies: [{ name: "proxy-a", type: "SOCKS5", addr: "3.3.3.3:1080", auth: { user: "alice", password: "secret" } }],
      };
      const file = await writeConfig(dir, cfg);
      const c = capture();
      expect(await main(["proxy", "get", "proxy-a", "--config", file], c.io)).toBe(0);
      expect(c.out).toContain("Auth.User:      alice");
      expect(c.out).toContain("Auth.Password:  ***");
      expect(c.out).not.toContain("secret");
    } finally {
      await cleanup();
    }
  });
});
