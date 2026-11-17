# myssh：sshmng 的 TypeScript 重写设计

- 日期：2026-11-17
- 状态：待审阅
- 源项目：`/Users/luozhihu/workspace/sshmng`（Go，约 29.5k 行，模块 `github.com/jim58246/sshmng`）
- 目标项目：`/Users/luozhihu/workspace/myssh`（npm 包名 `myssh`）

## 1. 背景与目标

原 `sshmng` 是一个 Go 编写的统一 SSH 管理器：单一二进制，同时提供 MCP Server（供 AI Agent 调用）与 `sshmng ssh` CLI（供人使用），共享一份 `config.json`。它支持直连、`ssh -J` 透明跳板、交互式堡垒机、SOCKS5/HTTP 代理、PTY 命令执行、sftp 传输、raw 设备终端原语与 TOFU 主机密钥校验。

用户的核心痛点是**安装**：

1. 需要手动下载 release 二进制、放置到 PATH、处理 macOS Gatekeeper 隔离标记；
2. 不想为了使用工具而安装 Go 环境。

本项目的目标：

- **功能与原项目一致**：配置、MCP 工具、CLI 行为均可直接替换。
- **安装简化为零安装**：用户只需在 Agent 配置里写 `npx -y myssh@latest mcp`。
- **三平台对等**：macOS / Linux / Windows 完整支持并测试。

## 2. 非目标

- 不保留 Go 二进制自更新、goreleaser、`install.sh` / `install.ps1`。
- 不实现厂商特定的分页（pager）配方；raw 设备仍由调用方根据输出处理。
- 不新增原项目没有的功能（YAGNI）。除 npx 生态必要的适配外，行为不变。
- 不做图形界面、不做常驻守护进程。

## 3. 关键决策

| 决策 | 选择 | 理由 |
|---|---|---|
| 实现路线 | 混合：核心算法直译，外围重写 | 行为对齐风险低，同时代码符合 TS 习惯 |
| 语言/运行时 | TypeScript 5.x strict + ESM，Node ≥ 22 | Node 20 已于 2026-04 EOL；22 为当前 LTS，MCP 用户普遍满足 |
| 包名 | `myssh` | 简短、npm 上大概率可用 |
| 可执行入口 | `myssh` 与 `sshmng` 双 bin | 保留原命令名，降低迁移成本 |
| MCP SDK | `@modelcontextprotocol/sdk` | 官方实现，stdio transport |
| SSH 库 | `ssh2` | 支持 shell channel、sftp、direct-tcpip、主机密钥回调 |
| 代理 | 自实现 SOCKS5 + HTTP CONNECT | 约 150 行，避免额外依赖 |
| 配置 | 完全沿用 `~/.sshmng/config.json` 与 `SSHMNG_HOME` | 可直接读取现有配置 |
| 自动更新 | 由 npx 承担；`update` 改为提示命令 | npx 模式下自写文件没有意义且有害 |
| 测试 | vitest + ssh2 Server API 假服务 | 与 Go 版测试层次对齐 |

## 4. 技术栈与项目结构

### 4.1 依赖

运行时依赖（最小集合）：

- `@modelcontextprotocol/sdk`：MCP server、stdio transport、工具注册
- `ssh2`：SSH 连接、shell/PTY channel、sftp、direct-tcpip、host key 验证
- `yaml`：Hermes Agent 配置注入
- `zod`：MCP 工具入参 schema

开发依赖：`typescript`、`tsup`、`vitest`、`@types/node`、`@types/ssh2`。

不引入：代理库、CLI 框架、日志库、semver 库（版本比较逻辑很小，自实现）。

### 4.2 项目结构

```
myssh/
├── package.json            # name: myssh, type: module, bin: {myssh, sshmng}
├── tsconfig.json           # strict, NodeNext
├── tsup.config.ts
├── vitest.config.ts
├── src/
│   ├── cli/
│   │   ├── main.ts         # Dispatch，移植 cli.Dispatch 的路由
│   │   ├── help.ts         # 帮助文本（npx 用法适配）
│   │   ├── mcp.ts / install.ts / doctor.ts / update.ts / version.ts
│   │   ├── entity_cmd.ts   # server/jumphost/proxy list|get
│   │   ├── ssh_cmd.ts      # 交互式 / 非交互式登录
│   │   ├── file_cmd.ts     # file upload|download|upload-dir|download-dir|relay
│   │   └── agents/         # claude-code.ts / codeagent.ts / hermes.ts / opencode.ts
│   ├── config/
│   │   ├── types.ts        # 与 config.json 字段一一对应
│   │   ├── store.ts        # Load/Save（原子写）/ SSHMNG_HOME
│   │   ├── crud.ts         # RFC 7396 Merge Patch
│   │   ├── validate.ts     # 实体与 LoginFlow 校验
│   │   └── log_level.ts
│   ├── loginflow/
│   │   └── executor.ts     # 决策树执行器（直译）
│   ├── ssh/
│   │   ├── conn/
│   │   │   ├── dialer.ts   # ssh2 Client、认证、代理隧道
│   │   │   ├── known_hosts.ts
│   │   │   └── proxy.ts    # SOCKS5 / HTTP CONNECT
│   │   ├── pty/
│   │   │   ├── pty.ts      # shell channel、DetectShell、InjectRC、Run
│   │   │   ├── sentinel.ts # PS1 token 化 / PS1-only
│   │   │   ├── normalize.ts
│   │   │   ├── raw.ts      # SendRaw / ReadRaw
│   │   │   ├── sftp.ts / sftp_dir.ts / relay.ts
│   │   │   └── atomic.ts
│   │   └── session/
│   │       ├── session.ts  # 状态机、trace、idle timeout
│   │       ├── manager.ts  # sid map + graveyard
│   │       └── raw.ts
│   ├── mcp/
│   │   ├── server.ts       # 注册 21 个工具
│   │   ├── tools_config.ts / tools_session.ts / tools_raw.ts / tools_file.ts
│   │   └── log.ts          # per-process 日志文件
│   ├── progress/
│   ├── version.ts
│   └── index.ts            # bin 入口
└── tests/                  # 与 src 同构的 *.test.ts + fixtures/fake-ssh/*
```

## 5. 兼容性契约

以下内容必须逐字/逐字段保持一致，作为验收标准。

### 5.1 配置

- 路径：`~/.sshmng/config.json`；`SSHMNG_HOME` 环境变量可覆盖 home；`mcp --config <path>` 可覆盖配置文件。
- 顶层字段：`version`、`idle_timeout_s`、`log_level`、`log_path`、`auto_update_enabled`、`update_url`、`jumphosts`、`proxies`、`servers`。
- `Proxy`：`name`、`type`（`HTTP` / `SOCKS5`）、`addr`、`auth?{user,password}`、`tags?`。
- `SSHAuth`：`password?`、`private_key?`、`passphrase?`。
- `LoginAction`：`send?`、`expects[]`、`timeout_ms?`（0 = 默认 10000）。
- `Expect`：`pattern`（无前缀 = glob；`re:` 前缀 = 正则）、`next`（action 名或 `success`）。
- `Jumphost`：`name`、`addr`、`user`、`auth`、`ssh_j`、`login_flow?`、`login_entry?`、`max_steps?`（0 = 50）、`global_timeout_ms?`（0 = 60000）、`host_key_verify?`（缺省 true）、`via?`、`proxy?`、`tags?`。
- `SSHServer`：`name`、`addr`、`user`、`auth`、`login_flow?`、`login_entry?`、`max_steps?`、`global_timeout_ms?`、`host_key_verify?`、`raw?`、`via?`、`proxy?`、`tags?`。
- `via` / `proxy` 在 JSON 中是实体名字符串，加载后解析为引用；重复名或悬空引用必须报错。
- known_hosts：`~/.sshmng/known_hosts`，OpenSSH 格式，与 Go 版互通。

### 5.2 MCP

- server 名：`sshmng`；version 取 npm 包版本。
- `instructions` 文本沿用原版（关键信息前置，适配 Claude Code 约 2KB 截断）。
- 21 个工具的名称、zod schema、返回 JSON 字段完全一致（见第 11 节）。
- 结果以 2 空格缩进 JSON 文本放入 `content`；工具层错误返回 `isError: true`。
- `list_*` 脱敏 `auth.password` / `auth.private_key` / `auth.passphrase`；`get_*` 返回完整 auth。

### 5.3 CLI

- 子命令：`mcp`、`install`、`doctor`、`update`、`version`、`server`、`jumphost`、`proxy`、`ssh`、`file`、`help`。
- 退出码：正常 0；未知子命令 2；doctor 的 0/1/2 三态语义不变。
- 输出格式与 Go 版对齐（实体列表、错误文本）。

### 5.4 关键错误字符串

以下字符串必须原样出现，供既有 Agent 提示词匹配：

- `loginflow`（LoginFlow 失败错误前缀/包含）
- `session busy`
- `session closed`
- `sftp not available`
- `host key changed, possible MITM`

## 6. 数据模型与校验

`config/validate.ts` 逐条移植 Go 版 `validate.go`：

- 实体名校验与引用完整性：`via` / `proxy` 必须存在，重名报错。
- Jumphost：
  - `ssh_j=true`：`login_flow` 与 `login_entry` 必须为空。
  - `ssh_j=false`：`login_flow` 必须非空；`auth` 必须非空。
- SSHServer：
  - Pattern B（`via.ssh_j=false`）：`auth` 必须为空，`login_flow` 必须非空（凭据放在 `login_flow.send`）。
  - Pattern A / 直连：`auth` 必须非空。
  - Pattern A（`via.ssh_j=true`）不允许 `server.proxy`：direct-tcpip 已走跳板机 SSH 通道，独立传输代理无意义；直连仍允许 `server.proxy`。
- LoginFlow：
  - `"success"` 不能作为 action key。
  - 非空 `login_flow` 必须有合法 `login_entry`。
  - 每个 action 至少一条 expect；`pattern` 与 `next` 非空。
  - `next` 必须是 `"success"` 或已存在的 action 名。
- `idle_timeout_s`：0 → 默认 300。
- `log_level`：`debug/dbg/d`、`info/inf/i`、`warn/warning/w`、`error/err/e`，大小写不敏感；未知值报错（不能静默 fallback）。
- `host_key_verify`：缺省 true；显式 false 跳过 known_hosts 读写。

校验失败必须回滚到修改前状态（CRUD 的 load → mutate → validate → save 流程）。

## 7. 连接与登录

### 7.1 三种形态

| 形态 | 建立过程 | sftp |
|---|---|---|
| 直连 | ssh2 连接 target（可经 transport proxy） | ✅ |
| Pattern A（`via.ssh_j=true`） | ssh2 连 jumphost → `forwardOut` 开 direct-tcpip → 在隧道上再连 target | ✅（落在 target） |
| Pattern B（`via.ssh_j=false`） | ssh2 连堡垒机 → 单条 PTY shell → 堡垒机 LoginFlow → 同一 PTY 上执行 target LoginFlow | ❌（sftp 会落到堡垒机） |

`server via jumphost` 且无 `server` 匹配时，`sshmng ssh <name>` 将 `<name>` 解析为 jumphost，直接登录堡垒机。

### 7.2 登录流水线

```
dial（TOFU 主机密钥校验）→ 开 shell channel（PTY）→ LoginFlow（可选）
→ DetectShell → 注入 RC → 就绪（idle）
```

- Pattern B：先跑堡垒机 LoginFlow，再在同一 PTY 跑 target LoginFlow，然后 DetectShell / InjectRC。
- `raw: true`：跳过 DetectShell / InjectRC，直接进入 raw 模式。
- sftp 通道在登录阶段建立，超时 5s；失败仅设置 `sftp_available=false`，不阻断登录。

### 7.3 代理

- HTTP CONNECT：向代理发 `CONNECT host:port HTTP/1.1`，可选 `Proxy-Authorization: Basic`，2xx 后返回裸 socket。
- SOCKS5：握手、可选用户名/密码认证、CONNECT 到目标，返回裸 socket。
- 代理在 DNS 解析与 TCP 连接层面生效；ssh2 接收自定义 socket 流。
- Pattern A 的 target 连接走跳板机 `forwardOut`，不使用 `server.proxy`。

### 7.4 TOFU known_hosts

- `host_key_verify=true`（默认）：
  - 首次连接：记录公钥（OpenSSH 行格式）。
  - 已记录且匹配：放行。
  - 已记录但不匹配：拒绝，错误信息含 `host key changed, possible MITM`。
- `host_key_verify=false`：完全跳过读取/写入，无 MITM 保护（用于可信内网堡垒机等）。
- known_hosts 解析支持原项目支持的格式（明文 host/端口条目）；删除记录只能手动编辑文件。
- 私钥认证使用 `private_key` 文件路径 + 可选 `passphrase`。

### 7.5 LoginFlow

- 数据结构：`map[action] → {send?, expects[], timeout_ms?}`，`login_entry` 指定起点。
- `send` 支持 `\n`、`\r`、`\t` 转义，不支持变量引用。
- expect 匹配顺序执行；glob 语义与 `re:` 正则语义与 Go 版一致；匹配前做 ANSI 过滤。
- 默认单步 10s，`max_steps` 默认 50，`global_timeout_ms` 默认 60000。
- 成功后按序进入 DetectShell；失败时返回错误（含 `loginflow`）与 `login_trace`。
- `login_trace` 结构：每步 `send` / `output` / 匹配结果 / 耗时；RC 注入阶段作为一条 trace 并入。

## 8. PTY 与命令执行

### 8.1 shell 检测与 RC 注入

- DetectShell：发送带随机 marker 的探测命令，解析 `$0`、`BASH_VERSION`、`ZSH_VERSION`，识别 bash / zsh / dash / ash；超时 5s。
- RC 注入：
  - bash/zsh：设置 `TERM=dumb`，关闭 stty echo，注入 token 化 PS1。
  - dash/ash：注入固定 PS1 `__P_<sid>__> `（不展开 `$(...)`）。
  - 等待首个 PS1 sentinel，超时 5s；失败关闭会话。
- 探测命令与 end marker 使用随机变量拼接，避免命令回显误匹配（与 Go 版一致）。

### 8.2 命令执行（sentinel）

- **bash/zsh 走 token 化流程**：
  1. 生成随机 token（8 字节 hex）；
  2. 写 setup 命令，将 token 直接嵌入 PS1：`PS1='$(echo _$?)__<sid>_<token>__]# '`；
  3. 等待精确 token 的 setup sentinel，清空 pushback；
  4. 发送命令；
  5. 等待精确 token 的 cmd sentinel；
  6. 解析 exit code、剥离 sentinel 与 ANSI，返回输出。
- **dash/ash 走 PS1-only 流程**：固定 PS1，等待 PS1 字面量；exit code 恒为 `-1`。
- 默认命令超时 30s；`timeout_ms` 可覆盖。
- 超时后发送 Ctrl-C，再等待新 PS1 最多 3s：
  - 收到 → 返回 `timed_out=true, ctrl_c_sent=true`；
  - 未收到 → 判定连接不可用，关闭会话。
- 输出按 `max_output_bytes` 截断，返回 `truncated` 与 `total_bytes`。
- 多行命令语义与 Go 版一致：单行内 `&&` / `;` 可用；`\n` 分隔的多条命令只保留第一条结果；for/heredoc/if/续行是合法单条命令。
- raw 会话拒绝 `run_in_session`。

### 8.3 raw 终端原语

- `send_in_session`：
  - 解释 C 风格转义：`\r`（Enter）、`\n`、`\t`、`\e`（ESC）、`\uXXXX`（如 `\u0003` = Ctrl-C）、`\\` = 字面反斜杠；其余原样。
  - 上限 64KB；仅 idle 状态可用；返回 `{sid, sent_bytes}`。
- `read_in_session`：
  - 顺序游标读取新输出，未读数据保留；
  - 首个字节到达前最多等待 `wait_ms`（默认 5000，上限 60000）；
  - 首字节后静默吸收：字节间隔 < 400ms 继续收；
  - `max_bytes` 默认 131072，上限 1048576；超出部分回存，`more=true`；
  - 返回 `{output, more, idle_ms}`；`idle_ms` 为距最后一个输出字节的毫秒数。
- 两种原语对 raw 与 shell 会话均可用；`run_in_session` 运行期间调用返回 busy。

## 9. 会话管理

- 状态机：`idle → running → closed`；同一 session 的写操作串行化（异步互斥锁），并发 `run_in_session` 返回 `session busy`。
- 状态字段（`stat`）：`sid`、`name`、`state`、`mode`（`shell` / `raw`）、`sftp_available`、`last_activity`、`commands_run`、`uptime_s`、`tags`。
- idle 超时：默认 300s，可由 `idle_timeout_s` 覆盖；任何活动重置；超时自动关闭并记日志。
- trace：每条命令记录 `time`、`cmd`、`output`、`raw_output`、`exit_code`、`timed_out`、`ctrl_c_sent`。
- `close_session` 强制关闭；trace 保留 10 分钟后自动清理（graveyard）。
- 会话 `tags` 是登录时刻服务器配置的快照。
- 每个 MCP 进程独立维护 `Map<sid, Session>`；跨进程不共享。

## 10. 文件传输

- sftp 通道：登录时建立（5s 超时）；未建立时所有传输返回 `sftp not available`。
- 单文件：
  - `upload` / `download`，默认超时 300s；
  - 上传先写 `<remotePath>.sshmng-tmp-<6 hex>`，成功后 rename（同目录，原子）；
  - 下载同理先写本地临时文件，成功后 rename；
  - 返回 `{bytes, timed_out}`。
- 目录：
  - `upload_dir`：遍历本地树、远端 `mkdir -p`；
  - `download_dir`：遍历远端树（sftp walk）、本地 `mkdir -p`；
  - 并发默认 4，可配置；
  - 冲突策略：`overwrite`（默认）/ `skip` / `rename`（`name_1`、`name_2`…）；
  - 单文件失败不中断，结果汇总 `{ok, files, bytes, errors[]}`；
  - 部分失败返回 `ok:false`，但**不设置** MCP `isError`。
- `relay_transfer`：
  - 源文件只读一次，通过本进程并发推送到 N 个目标；
  - 不落本地磁盘；所有目标共享同一 `dst_path`；
  - 源与所有目标都要求 `sftp_available=true`；
  - 单目标失败不中断其他目标；
  - 返回 `{ok, downloaded_bytes, timed_out, src_server, destinations:[{dst_sid, dst_server, ok, bytes, timed_out, error}]}`；
  - 部分失败 `ok:false`，不设置 `isError`。

## 11. MCP 工具（21 个）

| 分类 | 工具 | 关键行为 |
|---|---|---|
| 配置查询 | `list_ssh_servers` / `list_jumphosts` / `list_proxies` | 空格分隔多关键词 AND 匹配 name/addr/tags（大小写不敏感）；auth 脱敏 |
| 配置查询 | `get_ssh_server` / `get_jumphost` / `get_proxy` | 按 name 返回完整记录（含 auth） |
| 配置更新 | `update_ssh_server` / `update_jumphost` / `update_proxy` | RFC 7396 Merge Patch；`null` 删除，object 合并/创建 |
| 会话 | `login(name)` | 返回 `{sid, server_name, sftp_available, mode, tags}`；失败附 `login_trace` |
| 会话 | `run_in_session(sid, cmd, timeout_ms?, max_output_bytes?)` | 返回 `{output, exit_code, timed_out, truncated, total_bytes}`；raw 会话拒绝 |
| 会话 | `send_in_session(sid, input)` | C 风格转义；返回 `{sid, sent_bytes}`；仅 idle |
| 会话 | `read_in_session(sid, wait_ms?, max_bytes?)` | 返回 `{output, more, idle_ms}`；顺序游标 |
| 会话 | `close_session(sid)` | 强制关闭，trace 保留 10 分钟 |
| 会话 | `stat()` | 活跃会话摘要（含 sftp_available、mode、tags） |
| 诊断 | `get_trace(sid, last_n?, trunc_output?)` | 命令历史；`trunc_output` 默认 200，0 = 不截断 |
| 传输 | `upload(sid, src, dst, timeout_ms?)` / `download(...)` | 单文件 sftp |
| 传输 | `upload_dir` / `download_dir` | 目录递归；`conflict`、`concurrency`、`timeout_ms` |
| 传输 | `relay_transfer(src_sid, src_path, dst_sids[], dst_path, timeout_ms?)` | 1:N 流式扇出 |

工具描述文本沿用 Go 版（含 raw 设备使用说明、超时/截断诊断建议、`ok` 字段提示）。

## 12. CLI 与安装

### 12.1 子命令

| 子命令 | 行为 |
|---|---|
| `mcp [--config <path>]` | 启动 stdio MCP server |
| `install [--yes] [--agents a,b] [--pin]` | 创建 `~/.sshmng/`、模板、注入 Agent；默认写 `myssh@latest`，`--pin` 写当前版本 |
| `doctor` | 校验配置、权限、日志、Agent 条目、Node 版本、npx 可用性；退出码 0/1/2 |
| `version [--check]` | 打印版本；`--check` 查询 npm registry 最新版 |
| `update` | 打印 npx 模式下的更新方法；不写文件；退出 0 |
| `server\|jumphost\|proxy list\|get` | 与 MCP 查询等价，输出格式对齐 |
| `ssh <name> [command]` | 交互模式：本地 raw 模式 + 窗口 resize + Ctrl-C 透传；带 command：非交互执行；堡垒机/raw 设备拒绝非交互命令 |
| `file <upload\|download\|upload-dir\|download-dir\|relay> ...` | 与 MCP 传输工具等价的 CLI |

`sshmng ssh <jumphost>` 在无同名 server 时直接登录跳板机（含交互式菜单）。

### 12.2 Agent 注入

| Agent | 文件 | 顶层 key | 条目形态 |
|---|---|---|---|
| Claude Code | `~/.claude.json` | `mcpServers` | `{command: "npx", args: ["-y", "myssh@latest", "mcp"]}` |
| CodeAgent | `~/.cac.json`（Windows：`%USERPROFILE%\.cac.json`，即 `C:\Users\<user>\.cac.json`） | `mcpServers` | 与 Claude Code 完全相同的 JSON 结构；条目键为 `sshmng` |
| Hermes | `~/.hermes/config.yaml`（Windows：`%LOCALAPPDATA%\\hermes\\config.yaml`） | `mcp_servers` | 同结构（YAML） |
| OpenCode | `~/.config/opencode/opencode.json` | `mcp` | `command` 数组，env 字段名 `environment` |

- 注入前创建带时间戳的备份。
- 已存在且内容一致 → 跳过；内容不同 → 以本工具条目为准并保留备份（与 Go 版策略一致）。
- `install` 自动探测已安装 Agent；`--agents none` 跳过所有注入。
- 探测规则：Claude Code / CodeAgent 以配置文件存在为准（`~/.claude.json` / `~/.cac.json`）；Hermes / OpenCode 沿用原项目探测逻辑。四者均可用 `--agents <name>` 强制注入（`claude-code` / `codeagent` / `hermes` / `opencode`）。
- CodeAgent 路径用 `os.homedir()` 拼接，不硬编码用户名；Windows 下自然得到 `C:\Users\<user>\.cac.json`。
- `doctor` 复用探测/校验逻辑，报告路径、条目、Node/npx 状态。

### 12.3 npx 使用方式

```bash
npx -y myssh@latest mcp        # MCP server（推荐写入 Agent 配置）
npx -y myssh doctor
npx -y myssh ssh prod-web-01
npx -y myssh file upload prod-web-01 ./a.txt /tmp/a.txt
```

- 无 postinstall 脚本；npm 安装期不执行本包代码。
- `@latest` 每次解析最新版（自动更新）；省略 `@latest` 走本地缓存（更快、可离线）。
- `--pin` 安装时写入具体版本，适合追求稳定/离线的环境。

## 13. 日志与 stdout 纪律

- **stdout 只允许 MCP JSON-RPC**。任何日志、警告、进度都不得写到 stdout。
- `log_path` 为空：不写日志。
- `log_path` 非空：目录 `0700`，每进程一个文件 `<timestamp>-<pid>.log`（时间戳格式 `YYYY-MM-DD_HH-mm-ss`，适配 Windows 非法字符），权限 `0600`，追加写。
- 启动时清理 7 天前的 `*.log`（文件名可解析则按时间戳，否则按 mtime）；清理失败不影响启动。
- `log_level` 控制级别；缩写规则见第 6 节。
- bootstrap 错误写 stderr；MCP 运行期错误写日志文件。
- 提供一个唯一 logger 封装，禁止业务代码直接调用 `console.*`（用 lint 规则或代码审查保证）。

## 14. 错误处理

| 失败类型 | 返回 | 恢复路径 |
|---|---|---|
| SSH 连接/认证 | 错误文本 | 检查 addr/auth/proxy/jumphost |
| 主机密钥不匹配 | 含 `host key changed, possible MITM` | 人工核对或设置 `host_key_verify=false` |
| LoginFlow | 错误含 `loginflow` + `login_trace` | Agent 读取 trace，`update_*` 修补 pattern 后重试 |
| 命令超时 | `timed_out=true`、`ctrl_c_sent` | drain 成功可继续；失败则 re-login |
| 会话忙/关闭 | `session busy` / `session closed` | `stat` 后重试或 re-login |
| sftp 不可用 | `sftp not available` | 检查 `stat.sftp_available`；Pattern B 不支持 |
| 目录/批量传输部分失败 | 正文 `ok:false`（非 MCP error） | 检查 `errors[]` 后重试失败项 |

进程级：

- SIGINT/SIGTERM：关闭所有 session、关闭日志文件、退出。
- unhandled rejection / uncaught exception：写日志（或 stderr），MCP server 尽量存活；已在运行的工具调用返回 error。
- 会话连接中断：状态转 `closed`，trace 进 graveyard。

## 15. 测试策略

### 15.1 单元测试

- `config`：load/save 原子写、Merge Patch（null 删除、object 合并、创建）、校验规则、引用解析、日志级别解析。
- `loginflow`：glob/正则匹配、顺序尝试、超时、max_steps、全局超时、trace 生成。
- `pty`：ANSI/CRLF/退格归一化、sentinel 解析、shell 检测、RC 生成、raw read 静默吸收与 pushback。
- `session`：状态机、并发串行化、idle 超时（fake timers）、graveyard TTL、trace 截断。
- `sftp_dir`：冲突策略、并发、失败聚合；`relay`：1:N 扇出与部分失败。
- `cli`：参数解析、帮助文本、Agent 注入（JSON/YAML 四种）、doctor 三态退出码。

### 15.2 集成测试

用 ssh2 `Server` API 搭建假 SSH 服务 fixtures：

- 认证：密码、私钥、私钥+passphrase、失败路径。
- shell：模拟 bash / zsh / dash 的 PS1 行为，验证 token 化与 PS1-only 流程。
- direct-tcpip：验证 Pattern A 二层连接。
- 菜单堡垒机：验证 Pattern B 两段 LoginFlow。
- raw 设备：无 shell，验证 send/read 原语。
- sftp：内存文件系统，验证单文件、目录、冲突策略、relay。
- MCP：通过 stdio JSON-RPC 逐工具验证输入输出与错误语义。
- CLI e2e：构建后 spawn `node dist/index.js`，验证 doctor/version/help/实体查询。

### 15.3 行为对齐

- 将 Go 版关键测试的期望输出转成 fixture。
- 开发期脚本：同一份 `config.json` 分别运行 Go 二进制与新 CLI 的只读命令（list/get/version/help），diff 输出；差异必须逐条解释。
- 关键错误字符串断言（第 5.4 节）。

### 15.4 CI

GitHub Actions 矩阵：

- OS：macOS、Ubuntu、Windows
- Node：22、24
- 步骤：install → typecheck → vitest（含 fake SSH 集成）→ build → CLI e2e

覆盖率目标：核心模块（config/loginflow/pty/session）行覆盖 ≥ 80%。

## 16. 里程碑

| 阶段 | 内容 | 验收 |
|---|---|---|
| M1 | 工程骨架、config、CRUD、配置类 MCP 工具 | 现有 config.json 可加载；9 个 CRUD 工具对齐 |
| M2 | dialer、proxy、known_hosts、session、PTY、sentinel、`run_in_session` | 直连假服务器可执行命令；TOFU 生效 |
| M3 | LoginFlow、Pattern A/B、raw 原语 | 三种登录形态 + raw 集成测试通过 |
| M4 | sftp 单文件、目录、relay | 传输/冲突/部分失败测试通过 |
| M5 | CLI 全命令、install/doctor、Agent 注入 | 三平台 e2e 通过；`npx -y myssh mcp` 可用 |
| M6 | 对齐测试、双语文档、CI 矩阵、npm 发布 | 对齐脚本无未解释差异；CI 全绿；包可安装 |

项目规模较大，实现计划按里程碑拆分为多个独立计划（每个里程碑一个计划、独立验收），避免单个计划过长而失去可审阅性。

## 17. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| PTY sentinel 行为漂移（bash/zsh/dash 差异） | 命令结果错配、exit code 丢失 | 直译算法 + 假 shell fixture + 真实服务器冒烟测试 |
| Node 并发模型与 Go goroutine 映射不当 | 会话串行化失效、数据竞争 | 每 session 异步互斥锁；状态机单点写入；并发测试 |
| ssh2 与 OpenSSH 行为差异（known_hosts、算法） | 连接失败或 TOFU 误判 | 与 Go 版同配置交叉验证；覆盖常见主机密钥类型 |
| Windows 终端 raw 模式/信号差异 | 交互式 `ssh` 体验差异 | Windows CI + 手动冒烟；必要时降级提示 |
| npx 启动延迟 / 离线不可用 | 用户体验 | 文档说明 `@latest` 与缓存两种模式；`--pin` 选项 |
| MCP SDK 版本 API 变动 | 工具注册不兼容 | 锁定 minor 版本；集成测试覆盖 stdio 协议 |
| 包名 `myssh` 在 npm 被占用 | 发布阻塞 | 发布前查询；备选 `@scope/myssh`，包名不改配置路径 |

## 18. 验收标准

1. 现有 `~/.sshmng/config.json` 无需修改即可被新项目加载；`server/jumphost/proxy list|get` 输出与 Go 版一致。
2. 21 个 MCP 工具的名称、参数、返回字段、错误语义与 Go 版一致。
3. 直连、Pattern A、Pattern B、raw 设备、sftp 单文件/目录/relay 均有集成测试且通过。
4. macOS / Linux / Windows × Node 22/24 CI 全绿。
5. `npx -y myssh@latest mcp` 可在三大平台启动并被 MCP client 调用。
6. `npx -y myssh install` 能正确注入 Claude Code / CodeAgent / Hermes / OpenCode，`doctor` 验证通过。
7. stdout 无任何非 JSON-RPC 输出。
