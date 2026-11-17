import {
  chmodSync,
  existsSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import ssh2 from "ssh2";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Dialer, loadAuth } from "../../src/ssh/dialer.js";
import { KnownHostsStore } from "../../src/ssh/known_hosts.js";
import { tempDir } from "../helpers/config.js";
import { FakeSshServer } from "../helpers/fake_ssh.js";

const { utils } = ssh2;

describe("loadAuth", () => {
  it("requires password or private key", () => {
    expect(() => loadAuth({})).toThrow(
      "no auth method available (need password or private_key)",
    );
  });

  it("prefers the private key over the password without falling back", () => {
    expect(() =>
      loadAuth({ password: "ignored", private_key: "/nonexistent" }),
    ).toThrow("stat private key /nonexistent:");
  });

  it("rejects a world-readable private key", () => {
    if (process.platform === "win32") return;
    const dir = process.env.TMPDIR ?? "/tmp";
    const file = path.join(dir, `myssh-key-${process.pid}-${Date.now()}`);
    const { private: key } = utils.generateKeyPairSync("ed25519");
    writeFileSync(file, key);
    chmodSync(file, 0o644);
    try {
      expect(() => loadAuth({ private_key: file })).toThrow(
        `private key ${file} permissions too open: 644, want 0600 or stricter (no group/other access)`,
      );
    } finally {
      chmodSync(file, 0o600);
      unlinkSync(file);
    }
  });
});

describe("Dialer", () => {
  let server: FakeSshServer;
  let dir: string;
  let cleanup: () => Promise<void>;
  let knownHosts: KnownHostsStore;
  let knownHostsFile: string;

  beforeEach(async () => {
    server = await FakeSshServer.start();
    const temp = await tempDir();
    dir = temp.dir;
    cleanup = temp.cleanup;
    knownHostsFile = path.join(dir, "known_hosts");
    knownHosts = new KnownHostsStore(knownHostsFile);
  });

  afterEach(async () => {
    await server.close();
    await cleanup();
  });

  const options = (extra: Record<string, unknown> = {}) => ({
    addr: server.addr,
    user: "test",
    auth: { password: "secret" },
    hostKeyVerify: true,
    ...extra,
  });

  it("connects with a password and records the host key (TOFU)", async () => {
    const first = await new Dialer(knownHosts).dial(options());
    first.end();
    const lines = readFileSync(knownHostsFile, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.startsWith(`${server.addr} `)).toBe(true);
    const second = await new Dialer(knownHosts).dial(options());
    second.end();
    expect(readFileSync(knownHostsFile, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("rejects a changed host key", async () => {
    await new Dialer(knownHosts).dial(options()).then((client) => client.end());
    writeFileSync(
      knownHostsFile,
      `${server.addr} ${Buffer.from("different-key").toString("base64")}\n`,
      { mode: 0o600 },
    );
    await expect(new Dialer(knownHosts).dial(options())).rejects.toThrow(
      `host key changed for ${server.addr}: possible MITM attack`,
    );
  });

  it("skips known_hosts entirely when verification is disabled", async () => {
    const client = await new Dialer(knownHosts).dial(
      options({ hostKeyVerify: false }),
    );
    client.end();
    expect(existsSync(knownHostsFile)).toBe(false);
  });

  it("surfaces authentication failures", async () => {
    await expect(
      new Dialer(knownHosts).dial(options({ auth: { password: "wrong" } })),
    ).rejects.toThrow(`ssh connect to ${server.addr}:`);
  });

  it("authenticates with a private key", async () => {
    const keyPath = path.join(dir, "id_ed25519");
    const { private: key } = utils.generateKeyPairSync("ed25519");
    writeFileSync(keyPath, key, { mode: 0o600 });
    chmodSync(keyPath, 0o600);
    await server.close();
    server = await FakeSshServer.start({ allowPublicKey: true });
    const client = await new Dialer(knownHosts).dial(
      options({ addr: server.addr, auth: { private_key: keyPath } }),
    );
    client.end();
  });

  it("probes a proxy and connects through it", async () => {
    const net = await import("node:net");
    const proxy = net.createServer((socket) => {
      let data = Buffer.alloc(0);
      const onData = (chunk: Buffer) => {
        data = Buffer.concat([data, chunk]);
        if (data.indexOf("\r\n\r\n") < 0) return;
        socket.off("data", onData);
        socket.write("HTTP/1.1 200 OK\r\n\r\n");
        const upstream = net.connect(server.port, "127.0.0.1");
        socket.pipe(upstream).pipe(socket);
      };
      socket.on("data", onData);
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const port = (proxy.address() as import("node:net").AddressInfo).port;
    try {
      const client = await new Dialer(knownHosts).dial(
        options({ proxy: { name: "p", type: "HTTP", addr: `127.0.0.1:${port}` } }),
      );
      client.end();
    } finally {
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });
});
