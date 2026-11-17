import { existsSync } from "node:fs";
import path from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../../src/config/store.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { Service } from "../../src/mcp/service.js";
import { tempDir, writeConfig } from "../helpers/config.js";
import { FakeSshServer, type FakeSshOptions } from "../helpers/fake_ssh.js";

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

async function setupServer(fakeOpts: FakeSshOptions = {}) {
  const fake = await FakeSshServer.start(fakeOpts);
  const temp = await tempDir();
  const file = await writeConfig(temp.dir, {
    version: "1",
    idle_timeout_s: 300,
    jumphosts: [],
    proxies: [],
    servers: [{
      name: "local",
      addr: fake.addr,
      user: "test",
      auth: { password: "secret" },
      raw: fakeOpts.raw,
      tags: ["stage"],
    }],
  });
  const { client } = await connect(new Store(file));
  return { fake, dir: temp.dir, cleanup: temp.cleanup, client };
}

let cleanupFns: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanupFns.reverse()) await fn();
  cleanupFns = [];
});

describe("session MCP tools", () => {
  it("logs in, runs commands, reports stat/trace and closes", async () => {
    const { fake, dir, cleanup, client } = await setupServer();
    cleanupFns.push(cleanup, () => fake.close());

    const login = await call(client, "login", { name: "local" });
    expect(login.isError).toBe(false);
    const session = login.json();
    expect(session.sid).toMatch(/^[0-9a-f]{16}$/);
    expect(session).toMatchObject({
      server_name: "local",
      sftp_available: false,
      mode: "shell",
      tags: ["stage"],
    });
    expect(existsSync(path.join(dir, "known_hosts"))).toBe(true);

    const echo = await call(client, "run_in_session", {
      sid: session.sid,
      cmd: "echo hello",
    });
    expect(echo.json()).toEqual({
      output: "hello",
      exit_code: 0,
      timed_out: false,
      truncated: false,
      total_bytes: 5,
    });

    const failed = await call(client, "run_in_session", {
      sid: session.sid,
      cmd: "false",
    });
    expect(failed.json().exit_code).toBe(1);

    const stat = await call(client, "stat");
    expect(stat.json()).toEqual([
      expect.objectContaining({
        sid: session.sid,
        name: "local",
        state: "idle",
        mode: "shell",
        sftp_available: false,
        commands_run: 2,
        tags: ["stage"],
      }),
    ]);

    const trace = await call(client, "get_trace", { sid: session.sid });
    expect(trace.json().commands).toHaveLength(2);
    expect(trace.json().commands[0]).toMatchObject({
      cmd: "echo hello",
      output: "hello",
      exit_code: 0,
    });
    expect(trace.json().login_flow).toHaveLength(1);

    const closed = await call(client, "close_session", { sid: session.sid });
    expect(closed.json()).toEqual({ sid: session.sid, closed: true });
    const after = await call(client, "run_in_session", {
      sid: session.sid,
      cmd: "true",
    });
    expect(after.isError).toBe(true);
    expect(after.text).toContain("not found");

    const grave = await call(client, "get_trace", { sid: session.sid });
    expect(grave.json().commands).toHaveLength(2);
    expect(grave.json().login_flow).toBeNull();
  });

  it("supports shell raw primitives between run_in_session calls", async () => {
    const { fake, cleanup, client } = await setupServer();
    cleanupFns.push(cleanup, () => fake.close());
    const sid = (await call(client, "login", { name: "local" })).json().sid;

    const sent = await call(client, "send_in_session", {
      sid,
      input: "echo typed\\r",
    });
    expect(sent.json()).toEqual({ sid, sent_bytes: 11 });
    const read = await call(client, "read_in_session", {
      sid,
      wait_ms: 500,
      max_bytes: 4096,
    });
    expect(read.json().output).toContain("typed");
    expect(read.json()).toHaveProperty("more");
    expect(read.json()).toHaveProperty("idle_ms");
  });

  it("logs in to a raw device and serves send/read only", async () => {
    const { fake, cleanup, client } = await setupServer({ raw: true });
    cleanupFns.push(cleanup, () => fake.close());
    const login = await call(client, "login", { name: "local" });
    expect(login.json().mode).toBe("raw");
    const sid = login.json().sid;

    const run = await call(client, "run_in_session", { sid, cmd: "show version" });
    expect(run.isError).toBe(true);
    expect(run.text).toBe(
      "raw device: no unix shell, use send_in_session/read_in_session",
    );

    await call(client, "send_in_session", { sid, input: "show version\\r" });
    const read = await call(client, "read_in_session", { sid, wait_ms: 200 });
    expect(read.json().output).toContain("show version\r");
  });

  it("reports unknown servers and unsupported via/login_flow", async () => {
    const { fake, cleanup, client } = await setupServer();
    cleanupFns.push(cleanup, () => fake.close());
    const missing = await call(client, "login", { name: "nope" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toBe('ssh server "nope" not found');
  });
});
