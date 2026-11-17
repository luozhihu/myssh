import { describe, expect, it } from "vitest";
import { main } from "../../src/cli/main.js";

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

describe("cli skeleton", () => {
  it("prints help with no args and exits 0", async () => {
    const c = capture();
    const code = await main([], c.io);
    expect(code).toBe(0);
    expect(c.out).toContain("myssh - SSH session manager");
    expect(c.out).toContain("myssh mcp");
  });

  it("prints version", async () => {
    const c = capture();
    const code = await main(["version"], c.io);
    expect(code).toBe(0);
    expect(c.out).toContain("sshmng 0.1.0");
    expect(c.out).toContain("commit: dev");
  });

  it("returns 2 for an unknown command", async () => {
    const c = capture();
    const code = await main(["nope"], c.io);
    expect(code).toBe(2);
    expect(c.out).toContain('Unknown command "nope"');
  });
});
