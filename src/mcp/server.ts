import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { VERSION } from "../version.js";
import type { Service } from "./service.js";
import {
  getJumphostTool,
  getProxyTool,
  getSSHServerTool,
  listJumphostsTool,
  listProxiesTool,
  listSSHServersTool,
  updateJumphostTool,
  updateProxyTool,
  updateSSHServerTool,
} from "./tools_config.js";

const instructions = `SSH session manager (config tools).
Entity model:
- SSHServer: name, addr (host:port), user, auth, login_flow?, via?, proxy?, tags, host_key_verify?.
- Jumphost: ssh_j=true -> transparent (ssh -J); ssh_j=false -> interactive bastion (login_flow required).
- Proxy: transport HTTP/SOCKS5.
Relationships: SSHServer.via -> Jumphost.name; *.proxy -> Proxy.name.
Query tools: space-separated keywords, AND semantics on name/addr/tags.
Update tools: RFC 7396 JSON Merge Patch; null deletes, object merges or creates.`;

const listSchema = {
  query: z.string().optional().describe(
    "optional, space-separated keywords with AND semantics; each keyword substring-matches name/addr/tags (case-insensitive)",
  ),
};

const getSchema = {
  name: z.string().describe("entity name"),
};

const updateSchema = {
  name: z.string().describe("entity name; if not exist, create"),
  patch: z.any().describe(
    "RFC 7396 JSON Merge Patch; null deletes the entity, object merges (or creates if name not found)",
  ),
};

export function createMcpServer(svc: Service): McpServer {
  const server = new McpServer(
    { name: "sshmng", version: VERSION },
    { instructions },
  );

  server.registerTool("list_ssh_servers", {
    description: "List SSH servers, optionally filtered by query. Query is space-separated keywords with AND semantics: each keyword substring-matches name/addr/tags (case-insensitive), and ALL keywords must match. Empty/whitespace query returns all. Sensitive auth fields are redacted. Use get_ssh_server for full auth.",
    inputSchema: listSchema,
  }, (args) => listSSHServersTool(svc, args));

  server.registerTool("get_ssh_server", {
    description: "Get a single SSH server by name, including full auth. Use to inspect LoginFlow structure or auth method before login.",
    inputSchema: getSchema,
  }, (args) => getSSHServerTool(svc, args));

  server.registerTool("update_ssh_server", {
    description: "Apply RFC 7396 JSON Merge Patch to an SSH server. Patch=null deletes the entity; object merges (or creates if name not found). Patch structure mirrors get_ssh_server output; via/proxy fields reference entity names (strings).",
    inputSchema: updateSchema,
  }, (args) => updateSSHServerTool(svc, args));

  server.registerTool("list_jumphosts", {
    description: "List jumphosts, optionally filtered by query. Query is space-separated keywords with AND semantics (each keyword substring-matches name/addr/tags, case-insensitive; all must match). ssh_j=true means transparent forwarding (ssh -J semantics); ssh_j=false means interactive bastion (login_flow required).",
    inputSchema: listSchema,
  }, (args) => listJumphostsTool(svc, args));

  server.registerTool("get_jumphost", {
    description: "Get a single jumphost by name, including full auth.",
    inputSchema: getSchema,
  }, (args) => getJumphostTool(svc, args));

  server.registerTool("update_jumphost", {
    description: "Apply RFC 7396 JSON Merge Patch to a jumphost. Patch=null deletes; object merges (or creates if name not found). Patch structure mirrors get_jumphost output; via/proxy fields reference entity names.",
    inputSchema: updateSchema,
  }, (args) => updateJumphostTool(svc, args));

  server.registerTool("list_proxies", {
    description: "List transport-layer proxies (HTTP/SOCKS5), optionally filtered by query. Query is space-separated keywords with AND semantics (each keyword substring-matches name/addr/tags, case-insensitive; all must match). Proxies are not SSH jumps — they proxy the underlying TCP connection.",
    inputSchema: listSchema,
  }, (args) => listProxiesTool(svc, args));

  server.registerTool("get_proxy", {
    description: "Get a single proxy by name.",
    inputSchema: getSchema,
  }, (args) => getProxyTool(svc, args));

  server.registerTool("update_proxy", {
    description: "Apply RFC 7396 JSON Merge Patch to a proxy. Patch=null deletes; object merges (or creates if name not found).",
    inputSchema: updateSchema,
  }, (args) => updateProxyTool(svc, args));

  return server;
}

export async function runStdioServer(svc: Service): Promise<void> {
  const server = createMcpServer(svc);
  await server.connect(new StdioServerTransport());
}
