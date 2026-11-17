# myssh

[English](README.md) | 简体中文

`myssh` 是 [sshmng](https://github.com/jim58246/sshmng) 的 TypeScript/Node.js
重写版，目标是支持 `npx` 零安装分发，并与 `~/.sshmng/config.json` 及原有 MCP
工具名完全兼容（可直接替换）。

## 状态

M6（发布就绪）已完成：

- [x] 工程骨架、构建、测试
- [x] 配置模型、校验、原子加载/保存
- [x] `server` / `jumphost` / `proxy` 的 `list|get` 命令行
- [x] 9 个配置增删改查 MCP 工具
- [x] 直连 SSH（密码或私钥）、HTTP/SOCKS5 代理
- [x] TOFU `known_hosts`、0600 私钥权限检查
- [x] PTY 会话、命令哨兵、`run_in_session`
- [x] 会话状态、trace、`stat` / `get_trace`、原始收发
- [x] 透明跳板机（Pattern A，`ssh -J` 语义）
- [x] 由 `login_flow` 驱动的交互式堡垒机（Pattern B）
- [x] 每会话持久 sftp、单文件 `upload` / `download`
- [x] 递归 `upload_dir` / `download_dir` 与冲突策略
- [x] 1:N 流式 `relay_transfer`，不落地本地磁盘
- [x] `install` / `doctor` / Agent 注入（M5）
- [x] 独立的 `ssh` 与 `file` 命令行
- [x] 三平台 CI 矩阵（macOS / Linux / Windows × Node 22/24）
- [x] 覆盖率门槛：config/loginflow/pty/session 行覆盖 ≥ 80%
- [x] 带 provenance 的 npm 发布工作流

连接形式：

- 直连（无 `via`）：直接 SSH 到目标；认证后可选执行目标 `login_flow`。
- Pattern A（`via.ssh_j=true`）：SSH 到跳板机，经 `direct-tcpip` 隧道再向目标
  发起第二次 SSH；目标上的 sftp 可用。
- Pattern B（`via.ssh_j=false`）：在交互式堡垒机上开一个 PTY；由跳板机
  `login_flow` 与目标 `login_flow` 驱动菜单；sftp 报告 `false`。
- LoginFlow 失败返回 `{"error": "... loginflow ...", "login_trace": [...]}`。

M4 起每个会话保持一条 sftp 通道：直连与 Pattern A 会话报告
`sftp_available: true`；Pattern B 报告 `false`（该通道会落在堡垒机上）。
文件传输失败不会关闭会话。

## 用法

发布后：

```bash
npx -y myssh@latest mcp            # 启动 MCP 服务器（stdio）
npx -y myssh server list
npx -y myssh server get prod-web-01
npx -y myssh version
```

本地源码运行：

```bash
npm install
npm run build
node dist/index.js mcp
```

MCP 服务器名为 `sshmng`，暴露 21 个工具：

- 配置：`list_ssh_servers`、`get_ssh_server`、`update_ssh_server`、
  `list_jumphosts`、`get_jumphost`、`update_jumphost`、
  `list_proxies`、`get_proxy`、`update_proxy`
- 会话：`login`、`run_in_session`、`close_session`、`stat`、
  `get_trace`、`send_in_session`、`read_in_session`
- 文件传输：`upload`（单个本地文件到远端）、`download`（单个远端文件到本地）、
  `upload_dir`（递归上传，支持冲突策略与并发）、`download_dir`（递归下载）、
  `relay_transfer`（把远端文件流式转发到 N 个会话；1:1 即单元素列表）

### 文件传输

```
login(name) -> {sid, sftp_available: true}
upload(sid, "/local/report.pdf", "/tmp/report.pdf") -> {ok, bytes, timed_out}
download(sid, "/tmp/report.pdf", "./report.pdf") -> {ok, bytes, timed_out}
upload_dir(sid, "./dist", "/srv/app", conflict="overwrite", concurrency=4)
download_dir(sid, "/var/log/app", "./logs", conflict="skip")
relay_transfer(src_sid, "/srv/app.tar", [dst_sid_1, dst_sid_2], "/srv/app.tar") -> 1:N 扇出
```

部分失败（超时、单文件错误、relay 目标失败）在结果正文返回 `ok: false`，
不设置 MCP error 标志。硬错误（未知 sid、sftp 不可用）才设置 MCP error 标志。

## 命令行

```bash
npx -y myssh@latest install     # 首次安装（生成配置 + 注入 Agent）
npx -y myssh@latest doctor      # 检查文件、权限、node/npx、Agent 配置
npx -y myssh@latest ssh prod-web-01
npx -y myssh@latest ssh prod-web-01 "uptime"
npx -y myssh@latest file upload ./report.pdf /tmp/report.pdf --server prod-web-01
npx -y myssh@latest file download /tmp/report.pdf ./report.pdf --server prod-web-01
npx -y myssh@latest file upload-dir ./dist /srv/app --server prod-web-01
npx -y myssh@latest file download-dir /var/log/app ./logs --server prod-web-01
npx -y myssh@latest file relay /srv/app.tar --server src --to dst1,dst2
```

`install` 创建 `~/.sshmng/`（或 `$SSHMNG_HOME`），写入 `config.json` 与
`config.example.json`，并向所选 Agent 注入 `myssh` MCP 条目
（`npx -y myssh@latest mcp`）。支持的 Agent：

- **Claude Code** —— `~/.claude.json`，键 `mcpServers`
- **CodeAgent** —— `~/.cac.json`，键 `mcpServers`（结构与 Claude Code 相同）
- **Hermes Agent** —— `~/.hermes/config.yaml`（Windows 为
  `%LOCALAPPDATA%\hermes\config.yaml`），键 `mcp_servers`
- **OpenCode** —— `~/.config/opencode/opencode.json`，键 `mcp`

已有 Agent 配置会被合并而不是替换；每次修改都保留
`<file>.bak.<YYYYMMDD-HHMMSS>` 备份，并以 0600 权限原子写入。`--agents` 显式
选择注入目标，`--agents none` 跳过注入，`--pin` 冻结当前 npm 版本而不是
`@latest`。

`myssh ssh <name>` 先解析服务器，找不到时回退到跳板机（含堡垒机菜单）。
带命令参数时非交互执行；Pattern B 堡垒机与 raw 设备没有 Unix shell 落点，
因此拒绝非交互命令。

`myssh file` 对应 MCP 传输工具：`upload`、`download`、`upload-dir`、
`download-dir`、`relay`（1:N 扇出，本地不落地）。Pattern B（堡垒机）没有
到目标的 sftp，请使用直连或 `ssh_j=true`。

`myssh update` 有意设计为空操作：Agent 配置使用 `npx -y myssh@latest`，
新版本会自动生效。`myssh version --check` 会把当前版本与 npm registry 比较。

## 配置兼容性

- 默认读取 `~/.sshmng/config.json`。
- `SSHMNG_HOME` 覆盖目录；`--config <path>` 覆盖文件。
- 现有配置无需修改即可加载；`via` / `proxy` 是实体名。
- macOS/Linux 上文件不得允许 group/other 读（`0600` 或更严格）。
- `list_*` 工具脱敏 `auth.password` / `auth.private_key` / `auth.passphrase`；
  `get_*` 返回完整认证信息。

## 开发

```bash
npm install
npm run typecheck
npm test
npm run test:coverage  # 核心模块行覆盖率门槛（>= 80%）
npm run test:e2e       # 构建 + 针对 dist/ 的 CLI 冒烟测试
npm run align:output   # 与 Go 二进制对比只读 CLI 输出
npm run check:package  # 检查 npm 包只包含运行时文件
```

`npm run align:output` 需要上游 Go 二进制。通过 `SSHMNG_GO_BIN` 或
`--go-bin <path>` 指定；找不到时脚本会打印提示并跳过，`--require-go` 会让
跳过变成错误。CI 会在固定 commit 上构建上游 `sshmng` 并以 `--require-go`
运行对齐。

发布由 tag 触发：

```bash
npm version patch
git push --follow-tags
```

发布工作流会校验 tag 与 `package.json` 一致，通过 `prepublishOnly` 运行
typecheck/测试/e2e/打包检查，然后带 provenance 发布到 npm。需要在仓库中配置
`NPM_TOKEN` secret。

设计文档：`docs/superpowers/specs/2026-11-17-myssh-ts-rewrite-design.md`。
M1 计划：`docs/superpowers/plans/2026-11-17-myssh-m1-foundation.md`。
M2 计划：`docs/superpowers/plans/2026-11-17-myssh-m2-connection.md`。
M3 计划：`docs/superpowers/plans/2026-11-18-myssh-m3-jumphosts.md`。
M4 计划：`docs/superpowers/plans/2026-11-18-myssh-m4-sftp.md`。
M5 计划：`docs/superpowers/plans/2026-11-18-myssh-m5-cli.md`。
M6 计划：`docs/superpowers/plans/2026-11-18-myssh-m6-release.md`。

## 许可证

MIT。`myssh` 是 MIT 许可的 `sshmng` 项目的重写版，保留上游版权声明。
详见 [LICENSE](LICENSE)。
