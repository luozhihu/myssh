import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../../src/config/store.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { Service } from "../../src/mcp/service.js";
import { tempDir, writeConfig } from "../helpers/config.js";
import { FakeSshServer } from "../helpers/fake_ssh.js";

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
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  return {
    isError: !!(result as { isError?: boolean }).isError,
    text: textOf(result),
    json: () => JSON.parse(textOf(result)),
  };
}

async function app(config: Record<string, unknown>) {
  const temp = await tempDir();
  const file = await writeConfig(temp.dir, { version: "1", idle_timeout_s: 300, ...config });
  const client = await connect(new Store(file));
  return { client, cleanup: temp.cleanup };
}

const jumpFlow = {
  entry: { expects: [{ pattern: "Select target:*", next: "success" }] },
};
const targetFlow = {
  entry: { send: "1\n", expects: [{ pattern: "login:*", next: "send_user" }] },
  send_user: { send: "alice\n", expects: [{ pattern: "Password:*", next: "send_pwd" }] },
  send_pwd: { send: "wonderland\n", expects: [{ pattern: "Welcome to*", next: "success" }] },
};

let cleanupFns: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanupFns.reverse()) await fn();
  cleanupFns = [];
});

describe("M3 connection forms", () => {
  it("runs a direct LoginFlow before shell detection", async () => {
    const fake = await FakeSshServer.start({ banner: "Welcome to prod\r\nRole: " });
    const { client, cleanup } = await app({
      jumphosts: [], proxies: [],
      servers: [{
        name: "local", addr: fake.addr, user: "test", auth: { password: "secret" },
        login_flow: { entry: { expects: [{ pattern: "Role: *", next: "success" }] } },
        login_entry: "entry",
      }],
    });
    cleanupFns.push(cleanup, () => fake.close());
    const login = await call(client, "login", { name: "local" });
    expect(login.isError).toBe(false);
    const sid = login.json().sid;
    expect((await call(client, "run_in_session", { sid, cmd: "echo direct-ok" })).json().output)
      .toBe("direct-ok");
    const trace = (await call(client, "get_trace", { sid })).json();
    expect(trace.login_flow).toHaveLength(2);
    expect(trace.login_flow[0]).toMatchObject({ send: "", expect: "Role: *" });
  });

  it("returns loginflow error plus login_trace on direct failure", async () => {
    const fake = await FakeSshServer.start({ banner: "Welcome\r\nRole: " });
    const { client, cleanup } = await app({
      jumphosts: [], proxies: [],
      servers: [{
        name: "local", addr: fake.addr, user: "test", auth: { password: "secret" },
        login_flow: {
          entry: {
            expects: [{ pattern: "NEVER_MATCHES", next: "success" }],
            timeout_ms: 100,
          },
        },
        login_entry: "entry",
      }],
    });
    cleanupFns.push(cleanup, () => fake.close());
    const login = await call(client, "login", { name: "local" });
    expect(login.isError).toBe(true);
    const body = login.json();
    expect(body.error).toContain("loginflow");
    expect(body.error.startsWith("direct: loginflow:")).toBe(true);
    expect(body.login_trace).toHaveLength(1);
    expect(body.login_trace[0].expect).toBe("");
  });

  it("logs in through Pattern A and runs commands on the target", async () => {
    const target = await FakeSshServer.start();
    const jump = await FakeSshServer.start();
    const { client, cleanup } = await app({
      proxies: [],
      jumphosts: [{
        name: "bastion", addr: jump.addr, user: "test",
        auth: { password: "secret" }, ssh_j: true,
      }],
      servers: [{
        name: "target", addr: target.addr, user: "test",
        auth: { password: "secret" }, via: "bastion",
      }],
    });
    cleanupFns.push(cleanup, () => target.close(), () => jump.close());
    const login = await call(client, "login", { name: "target" });
    expect(login.isError).toBe(false);
    expect(login.json()).toMatchObject({ mode: "shell", sftp_available: false });
    const sid = login.json().sid;
    const run = await call(client, "run_in_session", { sid, cmd: "echo via-pattern-a" });
    expect(run.json().output).toBe("via-pattern-a");
  });

  it("reports sftp availability for Pattern A and none for Pattern B", async () => {
    const target = await FakeSshServer.start({ allowSftp: true });
    const jump = await FakeSshServer.start();
    const appA = await app({
      proxies: [],
      jumphosts: [{
        name: "bastion", addr: jump.addr, user: "test",
        auth: { password: "secret" }, ssh_j: true,
      }],
      servers: [{
        name: "target", addr: target.addr, user: "test",
        auth: { password: "secret" }, via: "bastion",
      }],
    });
    cleanupFns.push(appA.cleanup, () => target.close(), () => jump.close());
    expect((await call(appA.client, "login", { name: "target" })).json().sftp_available).toBe(true);

    const bastion = await FakeSshServer.start({ bastion: true, allowSftp: true });
    const appB = await app({
      proxies: [],
      jumphosts: [{
        name: "menu", addr: bastion.addr, user: "test",
        auth: { password: "secret" }, ssh_j: false,
        login_flow: jumpFlow, login_entry: "entry",
      }],
      servers: [{
        name: "target", addr: "127.0.0.1:22", user: "alice", auth: {},
        via: "menu", login_flow: targetFlow, login_entry: "entry",
      }],
    });
    cleanupFns.push(appB.cleanup, () => bastion.close());
    const loginB = await call(appB.client, "login", { name: "target" });
    expect(loginB.isError).toBe(false);
    expect(loginB.json()).toMatchObject({ mode: "shell", sftp_available: false });
  });

  it("runs Pattern B: bastion then target LoginFlow on one PTY", async () => {
    const bastion = await FakeSshServer.start({ bastion: true });
    const { client, cleanup } = await app({
      proxies: [],
      jumphosts: [{
        name: "menu", addr: bastion.addr, user: "test",
        auth: { password: "secret" }, ssh_j: false,
        login_flow: jumpFlow, login_entry: "entry",
      }],
      servers: [{
        name: "target", addr: "127.0.0.1:22", user: "alice", auth: {},
        via: "menu", login_flow: targetFlow, login_entry: "entry",
      }],
    });
    cleanupFns.push(cleanup, () => bastion.close());
    const login = await call(client, "login", { name: "target" });
    expect(login.isError).toBe(false);
    const sid = login.json().sid;
    const run = await call(client, "run_in_session", { sid, cmd: "echo via-pattern-b" });
    expect(run.json().output).toBe("via-pattern-b");
    const trace = (await call(client, "get_trace", { sid })).json();
    expect(trace.login_flow).toHaveLength(5);
    expect(trace.login_flow.slice(0, 4).map((t: { send: string }) => t.send))
      .toEqual(["", "1\n", "alice\n", "wonderland\n"]);
  });

  it("returns only the failing segment trace for Pattern B", async () => {
    const bastion = await FakeSshServer.start({ bastion: true });
    const badFlow = {
      entry: {
        expects: [{ pattern: "NEVER_MATCHES", next: "success" }],
        timeout_ms: 100,
      },
    };
    const { client, cleanup } = await app({
      proxies: [],
      jumphosts: [{
        name: "menu", addr: bastion.addr, user: "test",
        auth: { password: "secret" }, ssh_j: false,
        login_flow: jumpFlow, login_entry: "entry",
      }],
      servers: [{
        name: "target", addr: "127.0.0.1:22", user: "alice", auth: {},
        via: "menu", login_flow: badFlow, login_entry: "entry",
      }],
    });
    cleanupFns.push(cleanup, () => bastion.close());
    const login = await call(client, "login", { name: "target" });
    expect(login.isError).toBe(true);
    const body = login.json();
    expect(body.error.startsWith("target: loginflow:")).toBe(true);
    expect(body.login_trace).toHaveLength(1);
  });
});
