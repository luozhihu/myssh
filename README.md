# myssh

`myssh` is a TypeScript/Node.js rewrite of [sshmng](https://github.com/jim58246/sshmng),
targeting zero-install distribution via `npx` and drop-in compatibility with
`~/.sshmng/config.json` and the original MCP tool names.

## Status

M1 (foundation) is complete:

- [x] Project scaffold, build, tests
- [x] Config model, validation, atomic load/save
- [x] `server` / `jumphost` / `proxy` `list|get` CLI
- [x] 9 config CRUD MCP tools
- [ ] SSH connections, sessions, PTY, LoginFlow, sftp (M2–M4)
- [ ] `install` / `doctor` / Agent injection (M5)
- [ ] npm publish and three-platform CI (M6)

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

The MCP server is named `sshmng` and exposes the config tools
`list_ssh_servers`, `get_ssh_server`, `update_ssh_server`,
`list_jumphosts`, `get_jumphost`, `update_jumphost`,
`list_proxies`, `get_proxy`, `update_proxy`.

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
