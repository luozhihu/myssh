import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { describe, expect, it } from "vitest";
import { Store } from "../../src/config/store.js";
import { Service } from "../../src/mcp/service.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { tempDir, writeConfig } from "../helpers/config.js";

async function connect(store: Store) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(new Service(store));
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return { client, server };
}

function textOf(result: unknown): string {
  const r = result as { content?: Array<{ type: string; text?: string }> };
  return r.content?.find((c) => c.type === "text")?.text ?? "";
}

const sample = {
  version: "1",
  idle_timeout_s: 300,
  jumphosts: [{
    name: "bastion", addr: "1.1.1.1:22", user: "ops", auth: { password: "secret" },
    ssh_j: true, tags: ["edge"],
  }],
  proxies: [{ name: "proxy-a", type: "SOCKS5", addr: "3.3.3.3:1080" }],
  servers: [{
    name: "prod-web-01", addr: "10.0.0.1:22", user: "deploy",
    auth: { password: "pw", private_key: "/id_rsa", passphrase: "pp" },
    via: "bastion", tags: ["prod", "web"],
  }],
};

describe("config MCP tools", () => {
  it("registers all 21 tools", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const file = await writeConfig(dir, sample);
      const { client } = await connect(new Store(file));
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name).sort()).toEqual([
        "close_session", "download", "download_dir", "get_jumphost",
        "get_proxy", "get_ssh_server", "get_trace", "list_jumphosts",
        "list_proxies", "list_ssh_servers", "login", "read_in_session",
        "relay_transfer", "run_in_session", "send_in_session", "stat",
        "update_jumphost", "update_proxy", "update_ssh_server", "upload",
        "upload_dir",
      ]);
    } finally {
      await cleanup();
    }
  });

  it("lists servers with AND query and redacts auth", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const file = await writeConfig(dir, sample);
      const { client } = await connect(new Store(file));
      const result = await client.callTool({
        name: "list_ssh_servers",
        arguments: { query: "prod web" },
      });
      const rows = JSON.parse(textOf(result));
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe("prod-web-01");
      expect(rows[0].auth).toEqual({});
      expect(rows[0].via).toBe("bastion");
    } finally {
      await cleanup();
    }
  });

  it("gets a server with full auth", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const file = await writeConfig(dir, sample);
      const { client } = await connect(new Store(file));
      const result = await client.callTool({
        name: "get_ssh_server",
        arguments: { name: "prod-web-01" },
      });
      const row = JSON.parse(textOf(result));
      expect(row.auth.password).toBe("pw");
      expect(row.auth.private_key).toBe("/id_rsa");
      expect(row.auth.passphrase).toBe("pp");
    } finally {
      await cleanup();
    }
  });

  it("creates, merges and deletes a proxy, persisting to disk", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const file = await writeConfig(dir, sample);
      const store = new Store(file);
      const { client } = await connect(store);

      const created = await client.callTool({
        name: "update_proxy",
        arguments: {
          name: "new-proxy",
          patch: { type: "HTTP", addr: "4.4.4.4:8080", tags: ["new"] },
        },
      });
      expect(JSON.parse(textOf(created)).name).toBe("new-proxy");

      const merged = await client.callTool({
        name: "update_proxy",
        arguments: { name: "proxy-a", patch: { auth: { user: "alice", password: "pw" } } },
      });
      expect(JSON.parse(textOf(merged)).auth.user).toBe("alice");

      const deleted = await client.callTool({
        name: "update_proxy",
        arguments: { name: "proxy-a", patch: null },
      });
      expect(JSON.parse(textOf(deleted))).toEqual({ name: "proxy-a", deleted: true });

      const loaded = await store.load();
      expect(loaded.proxies.map((p) => p.name)).toEqual(["new-proxy"]);
    } finally {
      await cleanup();
    }
  });

  it("returns isError=true for load failures", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const file = await writeConfig(dir, {
        version: "1", log_level: "trace", jumphosts: [], proxies: [], servers: [],
      });
      const { client } = await connect(new Store(file));
      const bad = await client.callTool({
        name: "list_ssh_servers", arguments: {},
      });
      expect(bad.isError).toBe(true);
      expect(textOf(bad)).toContain("load config:");
    } finally {
      await cleanup();
    }
  });

  it("rejects an invalid update and keeps the original file", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const file = await writeConfig(dir, sample);
      const store = new Store(file);
      const { client } = await connect(store);
      const result = await client.callTool({
        name: "update_ssh_server",
        arguments: { name: "prod-web-01", patch: { auth: null } },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("pattern A requires auth");
      const loaded = await store.load();
      expect(loaded.servers[0]?.auth.password).toBe("pw");
    } finally {
      await cleanup();
    }
  });
});
