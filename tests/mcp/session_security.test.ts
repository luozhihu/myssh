import { readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import ssh2 from "ssh2";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../../src/config/store.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { Service } from "../../src/mcp/service.js";
import { tempDir, writeConfig } from "../helpers/config.js";
import { FakeSshServer, type FakeSshOptions } from "../helpers/fake_ssh.js";

const { utils } = ssh2;

function textOf(result: unknown): string {
  const r = result as { content?: Array<{ type: string; text?: string }> };
  return r.content?.find((c) => c.type === "text")?.text ?? "";
}

async function connect(store: Store) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(new Service(store));
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return { client, server };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  return {
    isError: !!(result as { isError?: boolean }).isError,
    text: textOf(result),
    json: () => JSON.parse(textOf(result)),
  };
}

interface AppOptions {
  fake?: FakeSshOptions;
  server?: Record<string, unknown>;
  proxies?: unknown[];
  jumphosts?: unknown[];
}

async function startApp(options: AppOptions = {}) {
  const fake = await FakeSshServer.start(options.fake ?? {});
  const temp = await tempDir();
  const file = await writeConfig(temp.dir, {
    version: "1",
    idle_timeout_s: 300,
    jumphosts: options.jumphosts ?? [],
    proxies: options.proxies ?? [],
    servers: [{
      name: "local",
      addr: fake.addr,
      user: "test",
      auth: { password: "secret" },
      ...options.server,
    }],
  });
  const { client } = await connect(new Store(file));
  return { fake, dir: temp.dir, client, cleanup: temp.cleanup };
}

/** 最小 HTTP CONNECT 代理：读完请求头后连接目标并双向转发。 */
async function startHttpProxy() {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffered = "";
    const onData = (chunk: Buffer) => {
      buffered += chunk.toString("latin1");
      const end = buffered.indexOf("\r\n\r\n");
      if (end < 0) return;
      socket.off("data", onData);
      const target = /^CONNECT (\S+) HTTP\/1\.1/.exec(buffered)?.[1];
      const [host, portText] = target?.split(":") ?? [];
      if (!host || !portText) {
        socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
        return;
      }
      const upstream = net.connect(Number(portText), host, () => {
        socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
        const rest = buffered.slice(end + 4);
        if (rest) upstream.write(rest);
        socket.pipe(upstream).pipe(socket);
      });
      sockets.add(upstream);
      upstream.on("close", () => sockets.delete(upstream));
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
    };
    socket.on("data", onData);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    addr: `127.0.0.1:${port}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

let cleanupFns: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanupFns.reverse()) await fn();
  cleanupFns = [];
});

describe("session security and transport options", () => {
  it("refuses a changed host key and leaves known_hosts untouched", async () => {
    const { fake, dir, client, cleanup } = await startApp();
    cleanupFns.push(cleanup, () => fake.close());
    const knownHosts = path.join(dir, "known_hosts");

    const first = await call(client, "login", { name: "local" });
    expect(first.isError).toBe(false);
    await call(client, "close_session", { sid: first.json().sid });

    const other = utils.generateKeyPairSync("ed25519");
    const parsed = utils.parseKey(other.private);
    if (parsed instanceof Error) throw parsed;
    writeFileSync(
      knownHosts,
      `${fake.addr} ${parsed.getPublicSSH().toString("base64")}\n`,
      { mode: 0o600 },
    );

    const second = await call(client, "login", { name: "local" });
    expect(second.isError).toBe(true);
    expect(second.text).toContain(`host key changed for ${fake.addr}`);
    expect(readFileSync(knownHosts, "utf8")).toContain(fake.addr);
  });

  it("skips known_hosts when host_key_verify is false", async () => {
    const { fake, dir, client, cleanup } = await startApp({
      server: { host_key_verify: false },
    });
    cleanupFns.push(cleanup, () => fake.close());
    const login = await call(client, "login", { name: "local" });
    expect(login.isError).toBe(false);
    expect(() => readFileSync(path.join(dir, "known_hosts"))).toThrow();
  });

  it("logs in through an HTTP CONNECT proxy", async () => {
    const proxy = await startHttpProxy();
    const { fake, client, cleanup } = await startApp({
      server: { proxy: "corp" },
      proxies: [{ name: "corp", type: "HTTP", addr: proxy.addr }],
    });
    cleanupFns.push(cleanup, () => fake.close(), () => proxy.close());
    const login = await call(client, "login", { name: "local" });
    expect(login.isError).toBe(false);
    const sid = login.json().sid;
    const run = await call(client, "run_in_session", { sid, cmd: "echo via-proxy" });
    expect(run.json().output).toBe("via-proxy");
  });

  it("reports sftp availability from the server", async () => {
    const { fake, client, cleanup } = await startApp({ fake: { allowSftp: true } });
    cleanupFns.push(cleanup, () => fake.close());
    const login = await call(client, "login", { name: "local" });
    expect(login.isError).toBe(false);
    expect(login.json().sftp_available).toBe(true);
  });

});
