import { describe, expect, it } from "vitest";
import type { Config } from "../../src/config/types.js";
import { resolveReferences, validateConfig } from "../../src/config/validate.js";

const base = (): Config => ({
  version: "1",
  idle_timeout_s: 300,
  jumphosts: [],
  proxies: [],
  servers: [],
});

describe("resolveReferences", () => {
  it("rejects duplicate jumphost and proxy names", () => {
    const cfg = base();
    cfg.jumphosts.push(
      { name: "j", addr: "1.1.1.1:22", user: "u", auth: { password: "p" }, ssh_j: true },
      { name: "j", addr: "2.2.2.2:22", user: "u", auth: { password: "p" }, ssh_j: true },
    );
    expect(() => resolveReferences(cfg)).toThrow('duplicate jumphost name: "j"');
  });

  it("rejects unknown via and proxy references", () => {
    const cfg = base();
    cfg.servers.push({
      name: "s", addr: "1.1.1.1:22", user: "u", auth: { password: "p" }, via: "missing",
    });
    expect(() => resolveReferences(cfg)).toThrow(
      'server "s" references unknown jumphost "missing"',
    );
  });
});

describe("validateConfig", () => {
  it("requires auth on jumphosts", () => {
    const cfg = base();
    cfg.jumphosts.push({ name: "j", addr: "1.1.1.1:22", user: "u", auth: {}, ssh_j: true });
    expect(() => validateConfig(cfg)).toThrow('jumphost "j": auth is required');
  });

  it("enforces ssh_j=true empty login flow", () => {
    const cfg = base();
    cfg.jumphosts.push({
      name: "j", addr: "1.1.1.1:22", user: "u", auth: { password: "p" }, ssh_j: true,
      login_flow: { a: { expects: [{ pattern: "x", next: "success" }] } },
      login_entry: "a",
    });
    expect(() => validateConfig(cfg)).toThrow(
      'jumphost "j": ssh_j=true requires empty login_flow',
    );
  });

  it("enforces bastion login_flow and login_entry", () => {
    const cfg = base();
    cfg.jumphosts.push({ name: "j", addr: "1.1.1.1:22", user: "u", auth: { password: "p" }, ssh_j: false });
    expect(() => validateConfig(cfg)).toThrow(
      'jumphost "j": ssh_j=false requires non-empty login_flow',
    );
  });

  it("rejects success as login flow key", () => {
    const cfg = base();
    cfg.jumphosts.push({
      name: "j", addr: "1.1.1.1:22", user: "u", auth: { password: "p" }, ssh_j: false,
      login_flow: { success: { expects: [{ pattern: "x", next: "success" }] } },
      login_entry: "success",
    });
    expect(() => validateConfig(cfg)).toThrow(
      'jumphost "j": "success" is reserved, cannot be used as login_flow key',
    );
  });

  it("validates expect.next targets", () => {
    const cfg = base();
    cfg.jumphosts.push({
      name: "j", addr: "1.1.1.1:22", user: "u", auth: { password: "p" }, ssh_j: false,
      login_flow: { a: { expects: [{ pattern: "x", next: "nope" }] } },
      login_entry: "a",
    });
    expect(() => validateConfig(cfg)).toThrow(
      'jumphost "j": login_flow["a"].expects[0].next "nope" not found in login_flow',
    );
  });

  it("requires empty auth and non-empty flow for Pattern B targets", () => {
    const cfg = base();
    cfg.jumphosts.push({
      name: "bastion", addr: "1.1.1.1:22", user: "u", auth: { password: "p" }, ssh_j: false,
      login_flow: { a: { expects: [{ pattern: "x", next: "success" }] } },
      login_entry: "a",
    });
    cfg.servers.push({
      name: "s", addr: "2.2.2.2:22", user: "u", auth: { password: "p" }, via: "bastion",
    });
    expect(() => validateConfig(cfg)).toThrow(
      'server "s": pattern B (via.ssh_j=false) requires empty auth; put credentials in login_flow.send',
    );
  });

  it("requires auth for Pattern A targets", () => {
    const cfg = base();
    cfg.servers.push({ name: "s", addr: "1.1.1.1:22", user: "u", auth: {} });
    expect(() => validateConfig(cfg)).toThrow(
      'server "s": pattern A requires auth (used for SSH auth to target)',
    );
  });

  it("rejects proxy on Pattern A targets", () => {
    const cfg = base();
    cfg.jumphosts.push({
      name: "j", addr: "1.1.1.1:22", user: "u", auth: { password: "p" }, ssh_j: true,
    });
    cfg.proxies.push({ name: "p", type: "HTTP", addr: "3.3.3.3:8080" });
    cfg.servers.push({
      name: "s", addr: "2.2.2.2:22", user: "u", auth: { password: "p" },
      via: "j", proxy: "p",
    });
    expect(() => validateConfig(cfg)).toThrow(
      'server "s": pattern A (via.ssh_j=true) does not support server.proxy; direct-tcpip tunnels through jumphost\'s SSH channel, a separate transport proxy is meaningless',
    );
  });
});
