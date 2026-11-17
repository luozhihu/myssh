import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { main, type IO } from "../../src/cli/main.js";
import { tempDir, writeConfig } from "../helpers/config.js";
import { FakeSshServer } from "../helpers/fake_ssh.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.reverse()) await fn();
  cleanups.length = 0;
});

function capture(extra: Partial<IO> = {}) {
  let out = "";
  let err = "";
  const io: IO = {
    out: (text) => { out += text; },
    err: (text) => { err += text; },
    env: {},
    platform: "darwin",
    stderrIsTTY: false,
    readLine: async () => null,
    ...extra,
  };
  return { io, get out() { return out; }, get err() { return err; } };
}

async function app(servers: unknown[], jumphosts: unknown[] = []) {
  const temp = await tempDir();
  cleanups.push(temp.cleanup);
  const file = await writeConfig(temp.dir, {
    version: "1",
    idle_timeout_s: 300,
    jumphosts,
    proxies: [],
    servers,
  });
  return { dir: temp.dir, file };
}

describe("myssh ssh", () => {
  it("runs a command non-interactively and returns its exit code", async () => {
    const fake = await FakeSshServer.start({});
    cleanups.push(() => fake.close());
    const { file } = await app([
      { name: "srv", addr: fake.addr, user: "test", auth: { password: "secret" } },
    ]);
    const ok = capture();
    expect(await main(["ssh", "srv", "echo hi", "--config", file], ok.io)).toBe(0);
    expect(ok.out).toBe("hi");

    const fail = capture();
    expect(await main(["ssh", "srv", "false", "--config", file], fail.io)).toBe(1);
  });

  it("rejects commands for raw devices before dialing", async () => {
    const { file } = await app([
      {
        name: "switch",
        addr: "127.0.0.1:1",
        user: "admin",
        auth: { password: "x" },
        raw: true,
      },
    ]);
    const c = capture();
    expect(await main(["ssh", "switch", "show version", "--config", file], c.io)).toBe(1);
    expect(c.out).toBe(
      "Error: raw device: no unix shell, non-interactive mode not supported; use interactive mode\n",
    );
  });

  it("rejects commands for bastions with the exact guidance", async () => {
    const { file } = await app([], [
      {
        name: "edge", addr: "127.0.0.1:1", user: "ops",
        auth: { password: "x" }, ssh_j: false,
      },
    ]);
    const c = capture();
    expect(await main(["ssh", "edge", "uptime", "--config", file], c.io)).toBe(1);
    expect(c.out).toBe(
      'Error: non-interactive command not supported for bastion "edge" (ssh_j=false lands on an interactive menu, not a shell); use interactive mode: sshmng ssh edge\n',
    );
  });

  it("validates positional arguments", async () => {
    const none = capture();
    expect(await main(["ssh"], none.io)).toBe(2);
    expect(none.out).toBe("Usage: myssh ssh <name> [command]\n");

    const many = capture();
    expect(await main(["ssh", "a", "b", "c"], many.io)).toBe(2);
    expect(many.out).toBe(
      "Usage: myssh ssh <name> [command]\n" +
      "Error: expected 1 or 2 positional args, got 3 ([a b c])\n",
    );
  });

  it("relays an interactive session and restores the terminal", async () => {
    const fake = await FakeSshServer.start({});
    cleanups.push(() => fake.close());
    const { file } = await app([
      { name: "srv", addr: fake.addr, user: "test", auth: { password: "secret" } },
    ]);
    let out = "";
    let raw = false;
    let resolveRaw!: () => void;
    const rawOn = new Promise<void>((resolve) => { resolveRaw = resolve; });
    const stdin = new PassThrough();
    const stdout = new Writable({
      write(chunk, _enc, cb) { out += chunk.toString(); cb(); },
    });
    const c = capture({
      terminal: {
        stdin,
        stdout,
        isTTY: true,
        getWindowSize: () => ({ rows: 24, cols: 80 }),
        setRawMode: (value: boolean) => { raw = value; if (value) resolveRaw(); },
      },
    });

    const running = main(["ssh", "srv", "--config", file], c.io);
    await rawOn;
    stdin.write("echo hi\r");
    const deadline = Date.now() + 3000;
    while (!out.includes("hi") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(out).toContain("hi");
    stdin.end();
    expect(await running).toBe(0);
    expect(raw).toBe(false);
  });
});
