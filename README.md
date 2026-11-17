# myssh

`myssh` is a TypeScript/Node.js rewrite of [sshmng](https://github.com/jim58246/sshmng),
targeting zero-install distribution via `npx` and drop-in compatibility with
`~/.sshmng/config.json` and the original MCP tool names.

## Status

M3 (jumphosts and LoginFlow) is complete:

- [x] Project scaffold, build, tests
- [x] Config model, validation, atomic load/save
- [x] `server` / `jumphost` / `proxy` `list|get` CLI
- [x] 9 config CRUD MCP tools
- [x] Direct SSH via password or private key, HTTP/SOCKS5 proxies
- [x] TOFU `known_hosts`, 0600 key checks
- [x] PTY sessions, command sentinel, `run_in_session`
- [x] Session state, traces, `stat` / `get_trace`, raw send/read, sftp probe
- [x] Transparent jumphosts (Pattern A, `ssh -J` semantics)
- [x] Interactive bastions (Pattern B) driven by `login_flow`
- [ ] sftp file transfer (M4)
- [ ] `install` / `doctor` / Agent injection (M5)
- [ ] npm publish and three-platform CI (M6)

M3 connection forms:

- Direct (`no via`): SSH to the target; optional target `login_flow` after auth.
- Pattern A (`via.ssh_j=true`): SSH to the jumphost, `direct-tcpip` tunnel,
  second SSH handshake to the target; sftp is available on the target.
- Pattern B (`via.ssh_j=false`): one PTY on the interactive bastion; jumphost
  `login_flow` then target `login_flow` drive the menu; sftp reports `false`.
- LoginFlow failures return `{"error": "... loginflow ...", "login_trace": [...]}`.

M3 limitation: SFTP availability is probed at login but file transfer tools
arrive in M4.

## Usage

Once published:

```bash
npx -y myssh@latest mcp            # start MCP server (stdio)
npx -y myssh server list
npx -y myssh server get prod-web-01
npx -y myssh version
```

From a local checkout:

```bash
npm install
npm run build
node dist/index.js mcp
```

The MCP server is named `sshmng` and exposes 16 tools:

- Config: `list_ssh_servers`, `get_ssh_server`, `update_ssh_server`,
  `list_jumphosts`, `get_jumphost`, `update_jumphost`,
  `list_proxies`, `get_proxy`, `update_proxy`
- Sessions: `login`, `run_in_session`, `close_session`, `stat`,
  `get_trace`, `send_in_session`, `read_in_session`

## Configuration compatibility

- Reads `~/.sshmng/config.json` by default.
- `SSHMNG_HOME` overrides the directory; `--config <path>` overrides the file.
- Existing configs load unchanged; `via` / `proxy` are entity names.
- On macOS/Linux the file must not be group/other readable (`0600` or stricter).
- `list_*` tools redact `auth.password` / `auth.private_key` / `auth.passphrase`;
  `get_*` returns full auth.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

Design spec: `docs/superpowers/specs/2026-11-17-myssh-ts-rewrite-design.md`.
M1 plan: `docs/superpowers/plans/2026-11-17-myssh-m1-foundation.md`.
M2 plan: `docs/superpowers/plans/2026-11-17-myssh-m2-connection.md`.
M3 plan: `docs/superpowers/plans/2026-11-18-myssh-m3-jumphosts.md`.
