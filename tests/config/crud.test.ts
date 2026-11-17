import { describe, expect, it } from "vitest";
import {
  getJumphost,
  getProxy,
  getSSHServer,
  listJumphosts,
  listProxies,
  listSSHServers,
  mergePatch,
  updateJumphost,
  updateProxy,
  updateSSHServer,
} from "../../src/config/crud.js";
import type { Config } from "../../src/config/types.js";
import { revalidate } from "../../src/config/validate.js";

function base(): Config {
  return {
    version: "1",
    idle_timeout_s: 300,
    jumphosts: [],
    proxies: [],
    servers: [],
  };
}

describe("list and get", () => {
  it("AND-matches keywords against name, addr and tags", () => {
    const cfg = base();
    cfg.servers.push(
      {
        name: "prod-web-01", addr: "10.0.0.1:22", user: "u",
        auth: { password: "p" }, tags: ["nginx", "linux"],
      },
      {
        name: "prod-db-01", addr: "10.0.0.2:22", user: "u",
        auth: { password: "p" }, tags: ["mysql"],
      },
    );
    expect(listSSHServers(cfg, "prod web").map((s) => s.name)).toEqual(["prod-web-01"]);
    expect(listSSHServers(cfg, "10.0.0.2").map((s) => s.name)).toEqual(["prod-db-01"]);
    expect(listSSHServers(cfg, "NGINX").map((s) => s.name)).toEqual(["prod-web-01"]);
    expect(listSSHServers(cfg, "  ")).toHaveLength(2);
  });

  it("lists jumphosts and proxies and gets by name", () => {
    const cfg = base();
    cfg.jumphosts.push({
      name: "j", addr: "1.1.1.1:22", user: "u", auth: { password: "p" }, ssh_j: true,
    });
    cfg.proxies.push({ name: "p", type: "SOCKS5", addr: "3.3.3.3:1080" });
    expect(listJumphosts(cfg, "1.1").map((j) => j.name)).toEqual(["j"]);
    expect(listProxies(cfg, "").map((p) => p.name)).toEqual(["p"]);
    expect(getJumphost(cfg, "j").name).toBe("j");
    expect(getProxy(cfg, "p").name).toBe("p");
  });

  it("returns not-found errors with the original wording", () => {
    const cfg = base();
    expect(() => getSSHServer(cfg, "x")).toThrow('ssh server "x" not found');
    expect(() => getJumphost(cfg, "x")).toThrow('jumphost "x" not found');
    expect(() => getProxy(cfg, "x")).toThrow('proxy "x" not found');
  });
});

describe("mergePatch", () => {
  it("recursively merges and deletes null keys", () => {
    const merged = mergePatch(
      { name: "s", auth: { password: "p", private_key: "k" }, tags: ["a"] },
      { auth: { private_key: null }, tags: ["b"], raw: true },
    );
    expect(merged).toEqual({ name: "s", auth: { password: "p" }, tags: ["b"], raw: true });
  });

  it("rejects non-object patches", () => {
    expect(() => mergePatch({ name: "s" }, "bad")).toThrow(
      "patch must be object or null, got string",
    );
  });
});

describe("update", () => {
  it("creates an entity and forces the name from the argument", () => {
    const cfg = base();
    updateSSHServer(cfg, "s", {
      addr: "1.1.1.1:22", user: "u", auth: { password: "p" }, name: "ignored",
    });
    revalidate(cfg);
    expect(cfg.servers[0]?.name).toBe("s");
  });

  it("merges into an existing entity", () => {
    const cfg = base();
    cfg.servers.push({
      name: "s", addr: "1.1.1.1:22", user: "u", auth: { password: "p" }, tags: ["old"],
    });
    updateSSHServer(cfg, "s", { tags: ["new"], auth: { passphrase: null } });
    expect(cfg.servers[0]).toMatchObject({
      name: "s", addr: "1.1.1.1:22", tags: ["new"], auth: { password: "p" },
    });
    expect(cfg.servers[0]?.auth).not.toHaveProperty("passphrase");
  });

  it("deletes with null and treats missing delete as no-op", () => {
    const cfg = base();
    cfg.proxies.push({ name: "p", type: "HTTP", addr: "3.3.3.3:8080" });
    updateProxy(cfg, "p", null);
    expect(cfg.proxies).toHaveLength(0);
    expect(() => updateProxy(cfg, "p", null)).not.toThrow();
  });

  it("rolls back when validation fails", () => {
    const cfg = base();
    cfg.servers.push({
      name: "s", addr: "1.1.1.1:22", user: "u", auth: { password: "p" },
    });
    expect(() => updateSSHServer(cfg, "s", { auth: null })).toThrow("pattern A requires auth");
    expect(cfg.servers[0]?.auth.password).toBe("p");
  });

  it("rolls back a deletion that would leave a dangling reference", () => {
    const cfg = base();
    cfg.jumphosts.push({
      name: "j", addr: "1.1.1.1:22", user: "u", auth: { password: "p" }, ssh_j: true,
    });
    cfg.servers.push({
      name: "s", addr: "2.2.2.2:22", user: "u", auth: { password: "p" }, via: "j",
    });
    expect(() => updateJumphost(cfg, "j", null)).toThrow(
      'server "s" references unknown jumphost "j"',
    );
    expect(cfg.jumphosts).toHaveLength(1);
  });

  it("updates jumphosts and proxies", () => {
    const cfg = base();
    updateJumphost(cfg, "j", {
      addr: "1.1.1.1:22", user: "u", auth: { password: "p" }, ssh_j: true,
    });
    updateProxy(cfg, "p", { type: "SOCKS5", addr: "3.3.3.3:1080" });
    revalidate(cfg);
    expect(cfg.jumphosts[0]?.name).toBe("j");
    expect(cfg.proxies[0]?.type).toBe("SOCKS5");
  });
});
