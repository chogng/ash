# `cli`：用户命令入口

- 生成用户运行的 `ash` 程序和供该程序调用的 `ash_cli` 库。
- 解析命令、生成帮助、校验参数组合，并分发到功能 crate。
- 组装 TUI、本地与远程连接、非交互执行和产品更新。
- 通过共享 App Server 管理账户、MCP 配置、已安装插件及历史会话。
- 保留后台服务的配置版本检查、精确包身份和权限边界。

`ash-cli/` 是独立命令入口。`app-ts/` 和 `app-rs/` 直接连接 App Server，不调用此程序。
账户、MCP、插件、会话和后台服务命令作用于相同的 `ASH_HOME` profile；无子命令、`resume`、
`remote connect` 和当前的 `update` 分别启动或维护 Ash Code 终端产品。

## 命令

执行 `ash --help` 或 `ash <command> --help` 查看参数。无子命令时启动 TUI。

| 命令 | 行为 |
| --- | --- |
| `ash ask PROMPT` | 执行问题并输出最终回答 |
| `ash exec [OPTIONS] PROMPT` | 非交互任务；支持 `--jsonl`、`--resume`、`--fork` 与审批模式 |
| `ash resume SESSION_ID THREAD_ID` | 恢复交互会话 |
| `ash sessions` | 列出已保存会话 |
| `ash fork SESSION_ID THREAD_ID --title TITLE` | 复制线程历史到独立会话，输出新身份 |
| `ash archive SESSION_ID` | 归档指定会话 |
| `ash unarchive SESSION_ID` | 恢复归档会话 |
| `ash login [chatgpt\|kimi\|xai]` | 设备授权登录；默认 ChatGPT |
| `ash login chatgpt --browser` | 输出浏览器授权地址并等待完成 |
| `ash login status` | 读取已登录账户 |
| `ash login api-key PROVIDER` | 从标准输入读取并保存已配置 Provider 的 API key |
| `ash logout PROVIDER` | 登出 `login status` 返回的指定 Provider ID |
| `ash mcp list` / `get ID` | 读取独立 MCP 服务声明 |
| `ash mcp add ID --url URL [--disabled]` | 新增 HTTP 服务声明 |
| `ash mcp add ID [--disabled] -- COMMAND [ARGS]` | 新增 stdio 服务声明 |
| `ash mcp enable ID` / `disable ID` / `remove ID` | 修改服务启用状态或删除声明 |
| `ash plugin list` | 读取已安装包的版本、授权与启用状态 |
| `ash plugin enable ID` / `disable ID` | 修改包的启用状态 |
| `ash plugin grant ID` / `revoke ID` | 授予或撤销包声明的权限 |
| `ash plugin uninstall ID` | 卸载指定已安装包 |
| `ash doctor [--json]` | 检查安装、服务握手、配置、账户与运行诊断 |
| `ash app-server ...` | 服务监听交给随 CLI 一起打包的 `ash-app-server` 程序；`connect` 和 `daemon` 管理本地服务进程 |
| `ash remote ...` | 远程连接、探测、安装与运行配置管理 |
| `ash update [--channel latest\|stable]` | 更新程序；`--status` 查看状态 |

- `exec` 中需要把选项样式的文字作为任务内容时，用 `--` 分隔。
- 同一个插件 ID 安装了多个版本时，变更命令必须加 `--version VERSION`。启用不自动授予权限。
- 管理命令连接当前 `ASH_HOME` 的 daemon；尚未运行时按既有生命周期启动。命令退出只关闭自身连接。
- 受管理安装的当前选中版本在首次连接本地 daemon 前核对 App Server 程序和随包 `buildId`；新包接管旧进程。旧版本的固定路径 CLI 不切回旧包。
- `ask` 和 `exec` 也通过相同的 profile daemon 执行 Turn；与同时运行的桌面端共用 Session、Thread 和后台任务状态。
- `doctor` 的账户为空属于提示，API-key Provider 仍可使用；检查失败返回非零退出码。
- `mcp add` 拒绝覆盖同名声明；当前入口只配置无认证 transport。
- MCP 命令使用配置领域的完整 ID，例如 `user:mcp:docs`。
- 插件入口管理已有安装；插件下载、MCP OAuth、独立沙箱命令和日志数据库查询尚未接入此 CLI。

## 输出与生命周期

- 账户、MCP、插件与会话管理的标准输出为 JSON，沿用 [App Server API](../docs/ash-app-server-api.md) 的字段。
- 登录授权地址与设备码写入标准错误；标准输出只在成功后给出账户结果。等待中按 Ctrl-C 会取消本次登录。
- API key 只从标准输入读取，不作为命令参数或输出返回。
- 帮助、版本、语法错误不会打开用户配置或启动 App Server。
- 退出码：成功 `0`，执行失败 `1`，参数错误 `2`，登录中断 `130`；非交互任务继续使用 `ash-exec` 定义的结果退出码。
- `main.rs` 只负责进程加固、内部辅助角色分发和调用 `ash_cli::run`；库内按命令组装各功能。

## Remote connections and updates

The CLI also exposes local Remote management commands used by Desktop and operators:

```text
ash remote connect -> resolve a saved/direct target and open the TUI over host-owned OpenSSH
ash remote probe   -> detect the exact POSIX package target through local OpenSSH
ash remote install -> validate a trusted local packaged-node artifact and install it immutably
ash remote profile -> read, activate, or compatibility-check and roll back shared runtime history
```

These commands delegate SSH/package/profile semantics to `ash-remote-connections`. For
`ash remote connect`, the CLI product host owns OpenSSH and gives the transport-neutral TUI an
already initialized `AppServerSession`; the TUI never owns credentials or process launch.
`--name` resolves the shared credential-free target catalog, while direct `--host`/`--workspace`
uses the same path. A managed connection first tries the stored exact runtime or Remote `ash`.
For runtime-unavailable and protocol-incompatible failures only, it can load the authenticated
catalog bound by a packaged `ash code` installation, or an explicit local/HTTPS catalog plus
SHA-256, install the matching immutable package, and retry once. An explicit `--runtime` is never
replaced automatically. The selected runtime is activated only after executable resolution and
the protocol/schema handshake succeed. `--check` performs the same chain without requiring a TTY
and exits after a clean shutdown. Downloads remain local and the installer uploads an already
validated package; no artifact URL or credential is sent to the Remote host.
`ash remote install --progress json-lines` writes typed installation phases to stderr
while keeping stdout reserved for the final immutable executable path. Desktop hosts may
terminate this local command to cancel bootstrap; Desktop does so from its Main-owned pre-Workbench
progress window without exposing artifact paths, SSH options, or credentials to Renderer.

After an interactive SSH TUI has started, a connection loss returns only the durable Session and
Thread identity to the CLI host. The host retries the same verified runtime for 30 seconds with
250ms-to-2s backoff, then starts a fresh TUI connection and reloads the canonical Thread snapshot.
Requests that were in flight and actions queued behind them are discarded rather than replayed.
Runtime disappearance, schema changes, protocol stream failures, and server rejection stop
recovery immediately. The Remote workspace is displayed in the TUI, while local `@file` scanning
is disabled so a local checkout cannot be projected into the Remote conversation; Remote path
completion awaits an App Server-owned contract.

An unpackaged development build has no implicit release trust binding. Use the existing local
bundle explicitly when exercising automatic preparation:

```bash
ash remote connect --name work \
  --runtime-catalog /absolute/path/to/catalog.json \
  --runtime-catalog-sha256 <catalog-sha256> \
  --check
```

Ash-managed installations keep immutable complete packages below a version store and switch a
stable launcher to the selected package. `[tui].autoUpdate` is one of `latest`, `stable`, or
`never`; the first two check at local TUI startup and hourly while it remains open, with network
checks limited to once per six hours per channel. `latest` follows each GitHub Release, while
`stable` follows only versions explicitly promoted by `.github/workflows/ash-code-promote.yml`.
Each update requires an Ed25519 descriptor signed by the release key stored outside the repository,
then verifies the archive SHA-256 and every file digest in `ash-package.json`. Source builds and
packages outside this layout are never rewritten, and changing streams never downgrades an installed
version. Published macOS and Windows executables also carry platform code signatures; macOS release
ZIPs are submitted to Apple notarization before the update descriptor is signed. A completed
background install uses the existing TUI notice row and takes effect after
restart; failures are retained for `ash update --status`. Run `ash update` or
`ash update --channel stable` for an immediate check. Install the latest managed package directly
with:

```bash
curl -fsSL https://chogng.github.io/ash/cli/install.sh | sh
```

Windows PowerShell uses:

```powershell
irm https://chogng.github.io/ash/cli/install.ps1 | iex
```

The [Pages workflow](../.github/workflows/pages.yml) publishes the canonical installers from
`build/code/` whenever they change on `main`. Its static artifact contains `.nojekyll`
at the root and the two scripts at the public `/cli/` URL path; no Jekyll build runs. Installation packages
remain GitHub Release assets and must be published before installation can succeed.
On macOS, Linux, and WSL, ensure `~/.local/bin` is on `PATH` to invoke `ash` after installation.

`ash-cli/tests/remote_connect.rs` exercises target resolution, the real local Remote Server
broker, trusted runtime preparation, and `--check` through a fake OpenSSH executable.
`ash-cli/tests/remote_connect_interactive.rs` runs the real CLI/TUI in a PTY, cuts the first
SSH proxy after the TUI is ready, proves the replacement generation reads the durable Session and
Thread, and exits through the terminal input path.

## 验证

```text
just check ash-cli
just test ash-cli --lib
python3 -B scripts/cargo.py build -p ash-cli --bin ash -p ash-app-server --bin ash-app-server
just test ash-cli --test commands --test stdio
just rust-warnings ash-cli
just dependencies
```

- `cli_tests.rs` 和 `exec_tests.rs` 验证解析、帮助、透传与互斥选项。
- `login_tests.rs` 验证精确登录身份、失败与断线处理。
- `tests/commands.rs` 使用独立的临时 `ASH_HOME`、`CODEX_HOME` 和真实 CLI；夹具启动并回收 daemon，验证跨进程配置、插件权限、会话生命周期、诊断和退出码。
- `tests/stdio.rs` 保留 App Server stdio 握手与隔离检查；完整 TUI 行为使用产品已有 PTY 场景。
