# myssh

English | [简体中文](README.zh-CN.md)

`myssh` is a TypeScript/Node.js rewrite of [sshmng](https://github.com/jim58246/sshmng),
targeting zero-install distribution via `npx` and drop-in compatibility with
`~/.sshmng/config.json` and the original MCP tool names.

## Status

M6 (release readiness) is complete:

- [x] Project scaffold, build, tests
- [x] Config model, validation, atomic load/save
- [x] `server` / `jumphost` / `proxy` `list|get` CLI
- [x] 9 config CRUD MCP tools
- [x] Direct SSH via password or private key, HTTP/SOCKS5 proxies
- [x] TOFU `known_hosts`, 0600 key checks
- [x] PTY sessions, command sentinel, `run_in_session`
- [x] Session state, traces, `stat` / `get_trace`, raw send/read
- [x] Transparent jumphosts (Pattern A, `ssh -J` semantics)
- [x] Interactive bastions (Pattern B) driven by `login_flow`
- [x] Persistent per-session sftp, single-file `upload` / `download`
- [x] Recursive `upload_dir` / `download_dir` with conflict policy
- [x] 1:N streaming `relay_transfer` without local disk
- [x] `install` / `doctor` / Agent injection (M5)
- [x] Standalone `ssh` and `file` CLI commands
- [x] Three-platform CI matrix (macOS / Linux / Windows × Node 22/24)
- [x] Coverage gate: config/loginflow/pty/session ≥ 80% lines
- [x] npm publish workflow with provenance

Connection forms:

- Direct (`no via`): SSH to the target; optional target `login_flow` after auth.
- Pattern A (`via.ssh_j=true`): SSH to the jumphost, `direct-tcpip` tunnel,
  second SSH handshake to the target; sftp is available on the target.
- Pattern B (`via.ssh_j=false`): one PTY on the interactive bastion; jumphost
  `login_flow` then target `login_flow` drive the menu; sftp reports `false`.
- LoginFlow failures return `{"error": "... loginflow ...", "login_trace": [...]}`.

M4 adds a persistent sftp channel per session: direct and Pattern A sessions
report `sftp_available: true`; Pattern B sessions report `false` (the channel
would land on the bastion). File transfers never close the session on failure.

## Usage

Once published:

```bash
npx -y @lzh-dev/myssh@latest mcp            # start MCP server (stdio)
npx -y @lzh-dev/myssh server list
npx -y @lzh-dev/myssh server get prod-web-01
npx -y @lzh-dev/myssh version
```

From a local checkout:

```bash
npm install
npm run build
node dist/index.js mcp
```

The MCP server is named `sshmng` and exposes 21 tools:

- Config: `list_ssh_servers`, `get_ssh_server`, `update_ssh_server`,
  `list_jumphosts`, `get_jumphost`, `update_jumphost`,
  `list_proxies`, `get_proxy`, `update_proxy`
- Sessions: `login`, `run_in_session`, `close_session`, `stat`,
  `get_trace`, `send_in_session`, `read_in_session`
- File transfer: `upload` (one local file to the remote host), `download`
  (one remote file to local), `upload_dir` (recursive tree with conflict
  policy and concurrency), `download_dir` (recursive pull), `relay_transfer`
  (stream one remote file to N sessions; 1:1 is a single-element list)

### File transfer

```
login(name) -> {sid, sftp_available: true}
upload(sid, "/local/report.pdf", "/tmp/report.pdf") -> {ok, bytes, timed_out}
download(sid, "/tmp/report.pdf", "./report.pdf") -> {ok, bytes, timed_out}
upload_dir(sid, "./dist", "/srv/app", conflict="overwrite", concurrency=4)
download_dir(sid, "/var/log/app", "./logs", conflict="skip")
relay_transfer(src_sid, "/srv/app.tar", [dst_sid_1, dst_sid_2], "/srv/app.tar") -> 1:N fanout
```

Partial failures (timeouts, per-file errors, failed relay destinations) return
`ok: false` in the result body without setting the MCP error flag. Hard errors
(unknown sid, unavailable sftp) set the MCP error flag.

## CLI

```bash
npx -y @lzh-dev/myssh@latest install     # first-time setup (scaffold + Agent injection)
npx -y @lzh-dev/myssh@latest doctor      # verify files, permissions, node/npx, Agent configs
npx -y @lzh-dev/myssh@latest ssh prod-web-01
npx -y @lzh-dev/myssh@latest ssh prod-web-01 "uptime"
npx -y @lzh-dev/myssh@latest file upload ./report.pdf /tmp/report.pdf --server prod-web-01
npx -y @lzh-dev/myssh@latest file download /tmp/report.pdf ./report.pdf --server prod-web-01
npx -y @lzh-dev/myssh@latest file upload-dir ./dist /srv/app --server prod-web-01
npx -y @lzh-dev/myssh@latest file download-dir /var/log/app ./logs --server prod-web-01
npx -y @lzh-dev/myssh@latest file relay /srv/app.tar --server src --to dst1,dst2
```

`install` creates `~/.sshmng/` (or `$SSHMNG_HOME`), writes `config.json` and
`config.example.json`, and injects a `myssh` MCP entry (via
`npx -y @lzh-dev/myssh@latest mcp`) into the Agents you select. It supports:

- **Claude Code** — `~/.claude.json`, key `mcpServers`
- **CodeAgent** — `~/.cac.json`, key `mcpServers` (same shape as Claude Code)
- **Hermes Agent** — `~/.hermes/config.yaml` (`%LOCALAPPDATA%\hermes\config.yaml`
  on Windows), key `mcp_servers`
- **OpenCode** — `~/.config/opencode/opencode.json`, key `mcp`

Existing Agent configs are merged, not replaced; every change keeps a
`<file>.bak.<YYYYMMDD-HHMMSS>` backup and writes the result atomically with
`0600` permissions. `--agents` selects injectors explicitly, `--agents none`
skips them, and `--pin` freezes the npm version currently running instead of
`@latest`.

`myssh ssh <name>` resolves a server first and falls back to a jumphost (the
bastion menu included). With a command argument it runs non-interactively;
Pattern B bastions and raw devices reject non-interactive commands because
they have no Unix shell landing.

`myssh file` mirrors the MCP transfer tools: `upload`, `download`,
`upload-dir`, `download-dir`, and `relay` (1:N fanout without local disk).
Pattern B (bastion) sessions have no sftp to the target, so use direct or
`ssh_j=true`.

`myssh update` is intentionally a no-op: Agent configs use `npx -y
@lzh-dev/myssh@latest`, so new releases are picked up automatically. `myssh version
--check` compares the current version with the npm registry.

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
npm run test:coverage  # core module line coverage gate (>= 80%)
npm run test:e2e       # build + CLI smoke checks against dist/
npm run align:output   # diff read-only CLI output against the Go binary
npm run check:package  # assert the npm tarball contains only runtime files
```

`npm run align:output` needs the upstream Go binary. Set `SSHMNG_GO_BIN` (or
pass `--go-bin <path>`); it skips with a notice when the binary is absent, and
`--require-go` makes the skip an error. CI builds upstream `sshmng` at a pinned
commit and runs the alignment with `--require-go`.

Releases are tag-driven:

```bash
npm version patch
git push --follow-tags
```

The release workflow checks that the tag matches `package.json`, runs
typecheck/tests/e2e/package checks via `prepublishOnly`, and publishes to npm
with provenance. It needs an `NPM_TOKEN` repository secret.

Design spec: `docs/superpowers/specs/2026-11-17-myssh-ts-rewrite-design.md`.
M1 plan: `docs/superpowers/plans/2026-11-17-myssh-m1-foundation.md`.
M2 plan: `docs/superpowers/plans/2026-11-17-myssh-m2-connection.md`.
M3 plan: `docs/superpowers/plans/2026-11-18-myssh-m3-jumphosts.md`.
M4 plan: `docs/superpowers/plans/2026-11-18-myssh-m4-sftp.md`.
M5 plan: `docs/superpowers/plans/2026-11-18-myssh-m5-cli.md`.
M6 plan: `docs/superpowers/plans/2026-11-18-myssh-m6-release.md`.

## License

MIT. `myssh` is a rewrite of the MIT-licensed `sshmng` project and retains its
copyright notice. See [LICENSE](LICENSE).
