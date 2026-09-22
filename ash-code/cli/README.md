# ash-cli

- 生成用户运行的 `ash` 程序和供该程序调用的 `ash_cli` 库。
- 解析命令、生成帮助、校验参数组合，并分发到功能 crate。
- 组装 TUI、本地与远程连接、非交互执行和产品更新。
- 通过共享 App Server 管理账户、MCP 配置、已安装插件及历史会话。
- 保留后台服务的配置版本检查、精确包身份和权限边界。

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
| `ash app-server ...` | 服务监听与 daemon 生命周期；参数交给对应 crate |
| `ash remote ...` | 远程连接、探测、安装与运行配置管理 |
| `ash update [--channel latest\|stable]` | 更新程序；`--status` 查看状态 |

- `exec` 中需要把选项样式的文字作为任务内容时，用 `--` 分隔。
- 同一个插件 ID 安装了多个版本时，变更命令必须加 `--version VERSION`。启用不自动授予权限。
- 管理命令连接当前 `ASH_HOME` 的 daemon；尚未运行时按既有生命周期启动。命令退出只关闭自身连接。
- `doctor` 的账户为空属于提示，API-key Provider 仍可使用；检查失败返回非零退出码。
- `mcp add` 拒绝覆盖同名声明；当前入口只配置无认证 transport。
- MCP 命令使用配置领域的完整 ID，例如 `user:mcp:docs`。
- 插件入口管理已有安装；插件下载、MCP OAuth、独立沙箱命令和日志数据库查询尚未接入此 CLI。

## 输出与生命周期

- 账户、MCP、插件与会话管理的标准输出为 JSON，沿用 [App Server API](../../docs/ash-app-server-api.md) 的字段。
- 登录授权地址与设备码写入标准错误；标准输出只在成功后给出账户结果。等待中按 Ctrl-C 会取消本次登录。
- API key 只从标准输入读取，不作为命令参数或输出返回。
- 帮助、版本、语法错误不会打开用户配置或启动 App Server。
- 退出码：成功 `0`，执行失败 `1`，参数错误 `2`，登录中断 `130`；非交互任务继续使用 `ash-exec` 定义的结果退出码。
- `main.rs` 只负责进程加固、内部辅助角色分发和调用 `ash_cli::run`；库内按命令组装各功能。

## 验证

```text
just check ash-cli
just test ash-cli --lib
uv run --frozen --project scripts python -B scripts/cargo.py build -p ash-cli --bin ash -p ash-app-server --bin ash-app-server
just test ash-cli --test commands --test stdio
just rust-warnings ash-cli
just dependencies
```

- `cli_tests.rs` 和 `exec_tests.rs` 验证解析、帮助、透传与互斥选项。
- `login_tests.rs` 验证精确登录身份、失败与断线处理。
- `tests/commands.rs` 使用独立的临时 `ASH_HOME`、`CODEX_HOME` 和真实 CLI；夹具启动并回收 daemon，验证跨进程配置、插件权限、会话生命周期、诊断和退出码。
- `tests/stdio.rs` 保留 App Server stdio 握手与隔离检查；完整 TUI 行为使用产品已有 PTY 场景。
