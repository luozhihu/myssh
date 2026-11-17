import { describe, expect, it } from "vitest";
import type { Config } from "../../src/config/types.js";
import { resolveJumphost, resolveServer, resolveTarget } from "../../src/cli/resolve.js";

function cfg(): Config {
  return {
    version: "1",
    idle_timeout_s: 300,
    jumphosts: [
      { name: "bastion-1", addr: "10.9.9.1:22", user: "ops", auth: { password: "x" }, ssh_j: true },
      { name: "bastion-2", addr: "10.9.9.2:22", user: "ops", auth: { password: "x" }, ssh_j: false },
    ],
    proxies: [],
    servers: [
      { name: "web-1", addr: "10.0.0.1:22", user: "deploy", auth: { password: "x" }, tags: ["prod"] },
      { name: "web-2", addr: "10.0.0.2:22", user: "deploy", auth: { password: "x" }, tags: ["prod"] },
      { name: "db-1", addr: "10.0.1.1:22", user: "deploy", auth: { password: "x" } },
    ],
  };
}

function ctx(lines: Array<string | null>) {
  const errors: string[] = [];
  let index = 0;
  return {
    errors,
    io: {
      err: (text: string) => { errors.push(text); },
      readLine: async () => lines[index++] ?? null,
    },
  };
}

describe("resolveServer", () => {
  it("returns exact matches without output", async () => {
    const c = ctx([]);
    const server = await resolveServer(cfg(), "web-1", true, c.io);
    expect(server.name).toBe("web-1");
    expect(c.errors).toEqual([]);
  });

  it("reports a single fuzzy match on stderr", async () => {
    const c = ctx([]);
    const server = await resolveServer(cfg(), "db", true, c.io);
    expect(server.name).toBe("db-1");
    expect(c.errors.join("")).toBe("matched: db-1\n");
  });

  it("rejects multiple matches when prompting is disabled", async () => {
    const c = ctx([]);
    await expect(resolveServer(cfg(), "web", false, c.io)).rejects.toThrow(
      'multiple servers match "web": web-1, web-2; specify exact name',
    );
  });

  it("prompts with a numbered list and accepts a selection", async () => {
    const c = ctx(["2"]);
    const server = await resolveServer(cfg(), "web", true, c.io);
    expect(server.name).toBe("web-2");
    const text = c.errors.join("");
    expect(text).toContain("Multiple servers match:\n");
    expect(text).toContain("  [1] web-1");
    expect(text).toContain("  [2] web-2");
    expect(text).toContain("Select [1-2]: ");
  });

  it("reports EOF and invalid selections", async () => {
    await expect(resolveServer(cfg(), "web", true, ctx([null]).io))
      .rejects.toThrow("no selection (EOF)");
    await expect(resolveServer(cfg(), "web", true, ctx(["9"]).io))
      .rejects.toThrow('invalid selection "9" (expected 1-2)');
  });
});

describe("resolveJumphost / resolveTarget", () => {
  it("resolves jumphosts with their own wording", async () => {
    const c = ctx([]);
    const jump = await resolveJumphost(cfg(), "bastion-1", true, c.io);
    expect(jump.name).toBe("bastion-1");
    await expect(resolveJumphost(cfg(), "nope", true, ctx([]).io))
      .rejects.toThrow('no jumphost matches "nope"');
  });

  it("falls back from servers to jumphosts", async () => {
    const c = ctx([]);
    const target = await resolveTarget(cfg(), "bastion-2", true, c.io);
    expect(target.kind).toBe("jumphost");
    await expect(resolveTarget(cfg(), "nothing", true, ctx([]).io))
      .rejects.toThrow('no server or jumphost matches "nothing"');
  });
});
