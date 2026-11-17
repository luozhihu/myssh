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

async function startApp(fake: FakeSshOptions = { allowSftp: true }) {
  const server = await FakeSshServer.start(fake);
  const temp = await tempDir();
  const local = await mkdtemp(path.join(tmpdir(), "myssh-mcp-file-"));
  const file = await writeConfig(temp.dir, {
    version: "1",
    idle_timeout_s: 300,
    jumphosts: [],
    proxies: [],
    servers: [{
      name: "local",
      addr: server.addr,
      user: "test",
      auth: { password: "secret" },
    }],
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = createMcpServer(new Service(new Store(file)));
  await mcp.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  cleanupFns.push(
    () => server.close(),
    temp.cleanup,
    async () => rm(local, { recursive: true, force: true }),
  );
  return { server, client, local };
}

describe("upload/download MCP tools", () => {
  it("uploads a local file and downloads it back", async () => {
    const { server, client, local } = await startApp();
    const login = await call(client, "login", { name: "local" });
    const sid = login.json().sid;

    const src = path.join(local, "upload.txt");
    await writeFile(src, "through-mcp");
    const upload = await call(client, "upload", { sid, src, dst: "/up.txt" });
    expect(upload.isError).toBe(false);
    expect(upload.json()).toEqual({
      sid, ok: true, bytes: 11, timed_out: false, remote_url: "/up.txt",
    });
    expect(await readFile(path.join(server.sftpRoot, "up.txt"), "utf8")).toBe("through-mcp");

    const dst = path.join(local, "download.txt");
    const download = await call(client, "download", { sid, src: "/up.txt", dst });
    expect(download.isError).toBe(false);
    expect(download.json()).toEqual({
      sid, ok: true, bytes: 11, timed_out: false, local_url: dst,
    });
    expect(await readFile(dst, "utf8")).toBe("through-mcp");
  });

  it("reports open/create local errors with sshmng prefixes", async () => {
    const { client, local } = await startApp();
    const sid = (await call(client, "login", { name: "local" })).json().sid;

    const missing = await call(client, "upload", {
      sid, src: path.join(local, "missing"), dst: "/x",
    });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/^open local .*missing: /);

    const badDst = await call(client, "download", {
      sid, src: "/x", dst: path.join(local, "no-such-dir", "x"),
    });
    expect(badDst.isError).toBe(true);
    expect(badDst.text).toMatch(/^create local .*: /);
  });

  it("returns an error when sftp is unavailable", async () => {
    const { client, local } = await startApp({ allowSftp: false });
    const login = await call(client, "login", { name: "local" });
    expect(login.json().sftp_available).toBe(false);
    const src = path.join(local, "a.txt");
    await writeFile(src, "x");
    const upload = await call(client, "upload", {
      sid: login.json().sid, src, dst: "/x",
    });
    expect(upload.isError).toBe(true);
    expect(upload.text).toBe("sftp not available for this session");
  });

  it("keeps partial bytes on timeout but does not set isError", async () => {
    const { client, local } = await startApp({ allowSftp: true, sftpDelayMs: 200 });
    const sid = (await call(client, "login", { name: "local" })).json().sid;
    const src = path.join(local, "slow.bin");
    await writeFile(src, "x".repeat(200_000));
    const upload = await call(client, "upload", { sid, src, dst: "/slow.bin", timeout_ms: 50 });
    expect(upload.isError).toBe(false);
    expect(upload.json().timed_out).toBe(true);
    expect(upload.json().ok).toBe(false);
  });
});
