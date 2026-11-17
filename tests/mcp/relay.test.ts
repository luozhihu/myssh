import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../../src/config/store.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { Service } from "../../src/mcp/service.js";
import { tempDir, writeConfig } from "../helpers/config.js";
import { FakeSshServer, type FakeSshOptions } from "../helpers/fake_ssh.js";

const cleanupFns: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanupFns.reverse()) await fn();
  cleanupFns.length = 0;
});

function textOf(result: unknown): string {
  const r = result as { content?: Array<{ type: string; text?: string }> };
  return r.content?.find((c) => c.type === "text")?.text ?? "";
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = textOf(result);
  return {
    isError: !!(result as { isError?: boolean }).isError,
    text,
    json: () => JSON.parse(text),
  };
}

async function startRelayApp(
  specs: Array<{ name: string; fake: FakeSshOptions }>,
) {
  const servers = await Promise.all(
    specs.map((spec) => FakeSshServer.start(spec.fake)),
  );
  const temp = await tempDir();
  const local = await mkdtemp(path.join(tmpdir(), "myssh-relay-"));
  const file = await writeConfig(temp.dir, {
    version: "1",
    idle_timeout_s: 300,
    jumphosts: [],
    proxies: [],
    servers: specs.map((spec, index) => ({
      name: spec.name,
      addr: servers[index]!.addr,
      user: "test",
      auth: { password: "secret" },
    })),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = createMcpServer(new Service(new Store(file)));
  await mcp.connect(serverTransport);
  const client = new Client({ name: "relay-test", version: "0.0.0" });
  await client.connect(clientTransport);
  cleanupFns.push(
    ...servers.map((server) => () => server.close()),
    temp.cleanup,
    async () => rm(local, { recursive: true, force: true }),
  );
  return { servers, client, local };
}

async function loginSid(client: Client, name: string): Promise<string> {
  const login = await call(client, "login", { name });
  expect(login.isError).toBe(false);
  return login.json().sid as string;
}

describe("relay_transfer", () => {
  it("streams one source file to two destinations in order", async () => {
    const { servers, client } = await startRelayApp([
      { name: "src", fake: { allowSftp: true } },
      { name: "dst1", fake: { allowSftp: true } },
      { name: "dst2", fake: { allowSftp: true } },
    ]);
    await writeFile(path.join(servers[0]!.sftpRoot, "file.bin"), "relay-payload");
    const srcSid = await loginSid(client, "src");
    const dst1 = await loginSid(client, "dst1");
    const dst2 = await loginSid(client, "dst2");

    const result = await call(client, "relay_transfer", {
      src_sid: srcSid,
      src_path: "/file.bin",
      dst_sids: [dst1, dst2],
      dst_path: "/landed.bin",
    });
    expect(result.isError).toBe(false);
    expect(result.json()).toEqual({
      ok: true,
      downloaded_bytes: 13,
      timed_out: false,
      src_server: "src",
      destinations: [
        { dst_sid: dst1, dst_server: "dst1", ok: true, bytes: 13, timed_out: false },
        { dst_sid: dst2, dst_server: "dst2", ok: true, bytes: 13, timed_out: false },
      ],
    });
    expect(await readFile(path.join(servers[1]!.sftpRoot, "landed.bin"), "utf8"))
      .toBe("relay-payload");
    expect(await readFile(path.join(servers[2]!.sftpRoot, "landed.bin"), "utf8"))
      .toBe("relay-payload");
  });

  it("supports 1:1 with a single-element dst_sids", async () => {
    const { servers, client } = await startRelayApp([
      { name: "src", fake: { allowSftp: true } },
      { name: "dst", fake: { allowSftp: true } },
    ]);
    await writeFile(path.join(servers[0]!.sftpRoot, "one"), "1");
    const srcSid = await loginSid(client, "src");
    const dst = await loginSid(client, "dst");
    const result = await call(client, "relay_transfer", {
      src_sid: srcSid, src_path: "/one", dst_sids: [dst], dst_path: "/one",
    });
    expect(result.json().ok).toBe(true);
    expect(result.json().destinations).toHaveLength(1);
    expect(await readFile(path.join(servers[1]!.sftpRoot, "one"), "utf8")).toBe("1");
  });

  it("reports per-destination preflight failures without aborting the others", async () => {
    const { servers, client } = await startRelayApp([
      { name: "src", fake: { allowSftp: true } },
      { name: "good", fake: { allowSftp: true } },
      { name: "nosftp", fake: { allowSftp: false } },
    ]);
    await writeFile(path.join(servers[0]!.sftpRoot, "f"), "x");
    const srcSid = await loginSid(client, "src");
    const good = await loginSid(client, "good");
    const nosftp = await loginSid(client, "nosftp");
    const result = await call(client, "relay_transfer", {
      src_sid: srcSid,
      src_path: "/f",
      dst_sids: [srcSid, good, nosftp, "missing"],
      dst_path: "/out",
    });
    expect(result.isError).toBe(false);
    const body = result.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe("one or more relay destinations failed");
    expect(body.destinations[0]).toMatchObject({
      dst_sid: srcSid, ok: false, error: "cannot relay a session to itself",
    });
    expect(body.destinations[1]).toMatchObject({ ok: true, bytes: 1 });
    expect(body.destinations[2]).toMatchObject({
      dst_sid: nosftp, dst_server: "nosftp", ok: false,
      error: "sftp not available for this session",
    });
    expect(body.destinations[3]).toMatchObject({
      dst_sid: "missing", ok: false, error: 'session "missing" not found',
    });
    expect(body.downloaded_bytes).toBe(1);
  });

  it("fails all destinations when the source is not a regular file", async () => {
    const { servers, client } = await startRelayApp([
      { name: "src", fake: { allowSftp: true } },
      { name: "dst", fake: { allowSftp: true } },
    ]);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.join(servers[0]!.sftpRoot, "dir"));
    const srcSid = await loginSid(client, "src");
    const dst = await loginSid(client, "dst");
    const result = await call(client, "relay_transfer", {
      src_sid: srcSid, src_path: "/dir", dst_sids: [dst], dst_path: "/x",
    });
    expect(result.json()).toMatchObject({
      ok: false,
      error: "source not a regular file",
      destinations: [{
        dst_sid: dst, dst_server: "dst", ok: false, bytes: 0,
        timed_out: false, error: "source not a regular file",
      }],
    });
  });

  it("returns isError for hard errors", async () => {
    const { client } = await startRelayApp([{ name: "src", fake: { allowSftp: true } }]);
    const srcSid = await loginSid(client, "src");
    const empty = await call(client, "relay_transfer", {
      src_sid: srcSid, src_path: "/x", dst_sids: [], dst_path: "/x",
    });
    expect(empty.isError).toBe(true);
    expect(empty.text).toBe("no relay destinations");
    const missing = await call(client, "relay_transfer", {
      src_sid: "nope", src_path: "/x", dst_sids: [srcSid], dst_path: "/x",
    });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain('session "nope" not found');
  });

  it("marks a busy destination but still delivers to healthy ones", async () => {
    const { servers, client } = await startRelayApp([
      { name: "src", fake: { allowSftp: true } },
      { name: "busy", fake: { allowSftp: true } },
      { name: "healthy", fake: { allowSftp: true } },
    ]);
    await writeFile(path.join(servers[0]!.sftpRoot, "f"), "payload");
    const srcSid = await loginSid(client, "src");
    const busy = await loginSid(client, "busy");
    const healthy = await loginSid(client, "healthy");

    const running = call(client, "run_in_session", { sid: busy, cmd: "sleep 1" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const relay = await call(client, "relay_transfer", {
      src_sid: srcSid, src_path: "/f", dst_sids: [busy, healthy], dst_path: "/f",
    });
    await running;
    const body = relay.json();
    expect(body.destinations[0]).toMatchObject({ ok: false, error: "session busy" });
    expect(body.destinations[1]).toMatchObject({ ok: true, bytes: 7 });
  });

  it("times out without isError and reports timed_out at the top level", async () => {
    const { servers, client } = await startRelayApp([
      { name: "src", fake: { allowSftp: true, sftpDelayMs: 200 } },
      { name: "dst", fake: { allowSftp: true } },
    ]);
    await writeFile(path.join(servers[0]!.sftpRoot, "big"), "x".repeat(100_000));
    const srcSid = await loginSid(client, "src");
    const dst = await loginSid(client, "dst");
    const result = await call(client, "relay_transfer", {
      src_sid: srcSid, src_path: "/big", dst_sids: [dst], dst_path: "/big", timeout_ms: 50,
    });
    expect(result.isError).toBe(false);
    const body = result.json();
    expect(body.ok).toBe(false);
    expect(body.timed_out).toBe(true);
    expect(body.destinations[0].timed_out).toBe(true);
  });
});
