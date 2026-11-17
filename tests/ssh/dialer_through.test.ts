import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Client } from "ssh2";
import { Dialer } from "../../src/ssh/dialer.js";
import { KnownHostsStore } from "../../src/ssh/known_hosts.js";
import { FakeSshServer } from "../helpers/fake_ssh.js";

const cleanupFns: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanupFns.reverse()) await fn();
  cleanupFns.length = 0;
});

async function setup(forwarding = true) {
  const dir = await mkdtemp(path.join(tmpdir(), "myssh-through-"));
  const target = await FakeSshServer.start();
  const jump = await FakeSshServer.start({ forwarding });
  cleanupFns.push(
    async () => rm(dir, { recursive: true, force: true }),
    () => target.close(),
    () => jump.close(),
  );
  const dialer = new Dialer(new KnownHostsStore(path.join(dir, "known_hosts")));
  const jumpClient = await dialer.dial({
    addr: jump.addr,
    user: "test",
    auth: { password: "secret" },
    hostKeyVerify: true,
  });
  return { dialer, jumpClient, target, jump };
}

async function shellEcho(client: Client): Promise<string> {
  return new Promise((resolve, reject) => {
    client.shell({ term: "xterm", rows: 24, cols: 80 }, {}, (err, stream) => {
      if (err) {
        reject(err);
        return;
      }
      let out = "";
      const timer = setTimeout(() => resolve(out), 1000);
      stream.on("data", (data: Buffer) => {
        out += data.toString("latin1");
        if (out.includes("through")) {
          clearTimeout(timer);
          resolve(out);
        }
      });
      stream.write("echo through\r");
    });
  });
}

describe("Dialer.dialThrough", () => {
  it("opens an SSH connection through a direct-tcpip channel", async () => {
    const { dialer, jumpClient, target } = await setup();
    const targetClient = await dialer.dialThrough(jumpClient, {
      addr: target.addr,
      user: "test",
      auth: { password: "secret" },
      hostKeyVerify: true,
    });
    expect(await shellEcho(targetClient)).toContain("through");
    targetClient.end();
    jumpClient.end();
  });

  it("reports forwardOpen rejection and unreachable targets", async () => {
    const { dialer, jumpClient, target } = await setup(false);
    await expect(
      dialer.dialThrough(jumpClient, {
        addr: target.addr,
        user: "test",
        auth: { password: "secret" },
        hostKeyVerify: true,
      }),
    ).rejects.toThrow(`dial ${target.addr} through jumphost:`);
    jumpClient.end();
  });
});
