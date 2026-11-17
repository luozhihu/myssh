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

import {
  closeSessionTool,
  getTraceTool,
  loginTool,
  runInSessionTool,
  statTool,
} from "./tools_session.js";
import { readInSessionTool, sendInSessionTool } from "./tools_raw.js";
import {
  downloadDirTool,
  downloadTool,
  uploadDirTool,
  uploadTool,
} from "./tools_file.js";
import { relayTransferTool } from "./tools_relay.js";

const instructions = `SSH session manager: servers, jumphosts, proxies, sessions.

Entity model:
- SSHServer: name, addr (host:port), user, auth, login_flow?, via?, proxy?, tags, host_key_verify? (default true; set false to skip known_hosts TOFU).
- Jumphost: ssh_j=true -> transparent (ssh -J); ssh_j=false -> interactive bastion (login_flow required).
- Proxy: transport HTTP/SOCKS5.
Relationships: SSHServer.via -> Jumphost.name; *.proxy -> Proxy.name.
Query tools: space-separated keywords, AND semantics on name/addr/tags.
Update tools: RFC 7396 JSON Merge Patch; null deletes, object merges or creates.

Workflow:
1. list_ssh_servers -> resolve the server name.
2. login(name) -> {sid, server_name, sftp_available, mode, tags}. Pattern A/B and login_flow run automatically; on LoginFlow failure the tool returns {error, login_trace}.
3. run_in_session(sid, cmd) -> {output, exit_code, timed_out, truncated, total_bytes}.
4. close_session(sid), or rely on idle timeout (default 5min via idle_timeout_s).

Sessions:
- Each session is an independent PTY; cwd/env/background jobs persist across run_in_session calls.
- States: idle / running / closed. run_in_session requires idle; use stat.
- mode: 'raw' = no unix shell (network switches etc.) — run_in_session is REJECTED; use send_in_session/read_in_session. mode: 'shell' = prefer run_in_session; raw primitives remain available for interactive programs.
- send_in_session interprets C-style escapes: \\\\r = Enter, \\\\n, \\\\t, \\\\e = ESC, \\\\uXXXX, \\\\\\\\ = literal backslash.
- read_in_session absorbs output while bytes keep arriving (<400ms gaps); use wait_ms 3-10s, do not poll with small values.
- run_in_session timeout -> auto Ctrl-C + 3s drain. If drain fails, session is closed; re-login.
- After close, command traces remain queryable via get_trace for 10 minutes.

File transfer:
- login -> sftp_available. Direct and Pattern A: true; Pattern B: false.
- upload/download: single files, atomic remote/local writes, timeout via timeout_ms (default 300s). Partial timeout returns {ok:false, timed_out:true} without an MCP error.
- upload_dir/download_dir: recursive, default concurrency 4, conflict overwrite|skip|rename. Per-file failures aggregate into {ok:false, err} with IsError not set.
- relay_transfer: stream src_sid:src_path to N sessions sharing dst_path; the source is read once. Requires sftp on every participant; per-destination failures are isolated.
- upload/download "sftp not available" -> check stat.sftp_available first.`;

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

const dirTransferSchema = {
  sid: z.string(),
  src: z.string(),
  dst: z.string(),
  conflict: z.string().optional().describe(
    "optional, default 'overwrite'. One of: overwrite, skip, rename",
  ),
  concurrency: z.number().int().optional().describe(
    "optional, default 4. Number of files to transfer in parallel",
  ),
  timeout_ms: z.number().int().optional().describe(
    "optional, 0 = default 300000 (300s). Per-file timeout",
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

  server.registerTool("login", {
    description: "Establish an interactive SSH session to a server. Use list_ssh_servers first to resolve the name. Returns {sid, server_name, sftp_available, mode, tags}. mode: 'shell' = unix shell (use run_in_session); 'raw' = no unix shell, e.g. network switch (run_in_session is rejected; use send_in_session/read_in_session). tags mirror the server's configured tags. Supports direct connections, Pattern A (via.ssh_j=true, transparent ssh -J), and Pattern B (via.ssh_j=false, interactive bastion driven by LoginFlow). LoginFlow failures return JSON {error, login_trace} for diagnosis.",
    inputSchema: {
      name: z.string().describe(
        "SSH server name; supports name/addr/tag substring match (use list_ssh_servers to find)",
      ),
    },
  }, (args) => loginTool(svc, args));

  server.registerTool("run_in_session", {
    description: "Run a single command in an existing session. Session must be idle (use stat to check). Returns {output, exit_code, timed_out, truncated, total_bytes}. On timeout: auto Ctrl-C + 3s drain; if drain fails (vim/REPL/pipe block) session is closed and must re-login. If output insufficient, call get_trace(sid, last_n, trunc_output=0) for raw PTY bytes. If truncated=true, use tail/head/grep or redirect to file. One command per call; combine multiple commands with `&&` or `;`. Multi-line single-command constructs (for-loop, heredoc, if-block, line continuation `\\`) work fine.",
    inputSchema: {
      sid: z.string(),
      cmd: z.string(),
      timeout_ms: z.number().int().optional().describe(
        "optional, default 30000 (30s). On timeout: auto Ctrl-C + 3s drain, partial output returned",
      ),
      max_output_bytes: z.number().int().optional().describe(
        "optional, 0 = no truncation. If exceeded: output truncated, truncated=true returned",
      ),
    },
  }, (args) => runInSessionTool(svc, args));

  server.registerTool("close_session", {
    description: "Close an SSH session. Forced: closes even if a command is running. Trace retained 10min for get_trace diagnosis. After this, sid is invalid for run_in_session.",
    inputSchema: { sid: z.string() },
  }, (args) => closeSessionTool(svc, args));

  server.registerTool("stat", {
    description: "List all active sessions with state (idle/running/closed), last activity, command count, uptime, sftp_available, mode (raw/shell), tags. Use before run_in_session to avoid 'session busy' error.",
    inputSchema: {},
  }, () => statTool(svc));

  server.registerTool("get_trace", {
    description: "Retrieve command trace for a session (alive or closed within last 10min). Returns {commands:[{time, cmd, output, raw_output, exit_code, timed_out, ctrl_c_sent}], login_flow}. raw_output contains uncleaned PTY bytes (ANSI/sentinel/\\r\\n) for debugging sentinel mismatch or interactive prompt issues. Use last_n to limit count (0=all), trunc_output to cap each Output/raw_output length (default 200, 0=no truncation for full raw bytes).",
    inputSchema: {
      sid: z.string(),
      last_n: z.number().int().optional().describe(
        "optional, return only the last N traces; 0 = all (default)",
      ),
      trunc_output: z.number().int().optional().describe(
        "optional, truncate each Output and raw_output to this many chars; default 200, 0 = no truncation (full raw PTY bytes for debugging)",
      ),
    },
  }, (args) => getTraceTool(svc, args));

  server.registerTool("send_in_session", {
    description: "Send input to a session's PTY (like typing in a terminal). The server interprets C-style escapes in input: \\r = Enter, \\n, \\t, \\e = ESC, \\uXXXX (e.g. \\u0003 = Ctrl-C), \\\\ = literal backslash; everything else is written as-is. Only works when session is idle (check stat). Works on ALL sessions: raw devices (mode=raw) and unix shells (for interactive programs). Max input 64KB. Returns {sid, sent_bytes}. State persists across calls.",
    inputSchema: {
      sid: z.string(),
      input: z.string().describe(
        "input for the PTY. The server interprets C-style escapes: \\r = Enter, \\n, \\t, \\e = ESC, \\uXXXX (e.g. \\u0003 = Ctrl-C), \\\\ = literal backslash. Everything else is written as-is. Max 64KB",
      ),
    },
  }, (args) => sendInSessionTool(svc, args));

  server.registerTool("read_in_session", {
    description: "Read new output produced by a session's PTY since the last read (sequential cursor; unread output stays queued, nothing is lost). Absorbs output while bytes keep arriving (<400ms gaps) and returns {output, more, idle_ms}. more=true: queue still has data — call again to drain. idle_ms: ms since the last output byte. Defaults: wait_ms 5000 (max 60000) blocks until first byte; max_bytes 131072 (max 1048576), excess stays queued. Prefer large wait_ms (3-10s); do NOT poll with small values.",
    inputSchema: {
      sid: z.string(),
      wait_ms: z.number().int().optional().describe(
        "optional, default 5000 (max 60000). Blocks until first output byte or timeout; use 1 for non-blocking poll. Do NOT poll with small values",
      ),
      max_bytes: z.number().int().optional().describe(
        "optional, default 131072 (max 1048576). Excess stays queued, more=true",
      ),
    },
  }, (args) => readInSessionTool(svc, args));

  server.registerTool("upload", {
    description: "Upload a local file to the remote host via sftp. Requires sftp_available=true on the session (check stat first). Returns {bytes, timed_out}. Fails with 'sftp not available' if session's sftp channel wasn't established (server doesn't support sftp subsystem).",
    inputSchema: {
      sid: z.string(),
      src: z.string().describe("local file path to upload (must exist)"),
      dst: z.string().describe("remote file path to write (e.g. /tmp/remote.txt)"),
      timeout_ms: z.number().int().optional().describe(
        "optional, 0 = default 300000 (300s). Returns timed_out=true + partial bytes if exceeded",
      ),
    },
  }, (args) => uploadTool(svc, args));

  server.registerTool("download", {
    description: "Download a remote file to local via sftp. Requires sftp_available=true on the session (check stat first). Returns {bytes, timed_out}. Fails with 'sftp not available' if session's sftp channel wasn't established.",
    inputSchema: {
      sid: z.string(),
      src: z.string().describe("remote file path to read"),
      dst: z.string().describe("local file path to write (overwritten if exists)"),
      timeout_ms: z.number().int().optional().describe(
        "optional, 0 = default 300000 (300s). Returns timed_out=true + partial bytes if exceeded",
      ),
    },
  }, (args) => downloadTool(svc, args));

  server.registerTool("upload_dir", {
    description: "Upload a local directory tree to the remote host via sftp. Walks the local tree, creates remote dirs (MkdirAll), transfers files concurrently (default 4). Conflict policy: overwrite (default) / skip / rename. Per-file errors don't abort the transfer; aggregated in result. Requires sftp_available=true on the session. Note: partial failures return ok:false in the result body with isError not set; check the ok field, not the MCP error flag.",
    inputSchema: dirTransferSchema,
  }, (args) => uploadDirTool(svc, args));

  server.registerTool("download_dir", {
    description: "Download a remote directory tree to local via sftp. Walks the remote tree, creates local dirs (MkdirAll), transfers files concurrently (default 4). Conflict policy: overwrite (default) / skip / rename. Per-file errors don't abort the transfer; aggregated in result. Requires sftp_available=true on the session. Note: partial failures return ok:false in the result body with isError not set; check the ok field, not the MCP error flag.",
    inputSchema: dirTransferSchema,
  }, (args) => downloadDirTool(svc, args));

  server.registerTool("relay_transfer", {
    description: "Relay (stream) a remote file from one session to one or more other sessions through the myssh process, without landing it on local disk and without waiting for the full download before uploading. 1:N fanout: the source is read once and streamed concurrently to all destinations (sharded/replicated deploy). 1:1 is the single-element dst_sids case. Requires sftp_available=true on the source and every destination (check stat first). All destinations share the same dst_path. Returns {ok, downloaded_bytes, timed_out, src_server, destinations:[{dst_sid, dst_server, ok, bytes, timed_out, error}]}. Per-destination failures do not abort the others; partial failures return ok:false in the result body with IsError not set (check the ok field, not the MCP error flag).",
    inputSchema: {
      src_sid: z.string(),
      src_path: z.string().describe("remote file path on the source session to relay"),
      dst_sids: z.array(z.string()).describe(
        "destination session sids; 1:1 = single-element array",
      ),
      dst_path: z.string().describe("remote write path shared by all destinations"),
      timeout_ms: z.number().int().optional().describe(
        "optional, 0 = default 300000 (300s). Each of download + every upload side gets its own budget (concurrent)",
      ),
    },
  }, (args) => relayTransferTool(svc, args));

  return server;
}

export async function runStdioServer(svc: Service): Promise<void> {
  const server = createMcpServer(svc);
  await server.connect(new StdioServerTransport());
}
