# ash-mcp

> 本 README 是 MCP 产品运行时当前实现的 canonical 文档。跨 crate 产品语义、授权、
> durability 与演进阶段见 [`../../docs/mcp.md`](../../docs/mcp.md)；单连接协议和 transport
> 实现见 [`../rmcp-client/README.md`](../rmcp-client/README.md)。

本 crate 把一组已经过宿主解析和授权的 MCP server definition 变成隔离 session、不可变工具
catalog、精确 binding 和可取消调用。它不读取 Config 或 Plugin，不解析 credential reference，
不审批工具调用，也不写 Core Thread。

## 边界与文件

| 文件 / symbol                           | 当前职责                                                                     |
| --------------------------------------- | ---------------------------------------------------------------------------- |
| `definition.rs` / `McpServerDefinition` | 接收宿主已 materialize 的 stdio 或 Streamable HTTP transport                 |
| `session.rs` / `McpSession`             | product runtime 使用的单 session 窄接口                                      |
| `session.rs` / `McpSessionFactory`      | transport/session 创建扩展点；production 由 `RmcpSessionFactory` 实现        |
| `catalog.rs` / `McpCatalogSnapshot`     | 保存跨 server、不可变、按 generation 冻结的工具视图                          |
| `catalog.rs` / `McpToolBinding`         | 保存 model alias、exact remote identity、definition digest 和两个 generation |
| `runtime.rs` / `McpRuntime`             | 启动 server set、发现 catalog、路由调用、观察失效和有界 shutdown             |
| `output.rs` / `project_tool_result`     | 把不可信 RMCP result 投影到 `ash-tools::ToolOutput`                          |
| `error.rs`                              | 区分构造失败、未开始、结果未知和无效结果                                     |

依赖方向固定为：

```text
ash-mcp
  → ash-rmcp-client
  → ash-tools / ash-protocol
  → ash-config::McpServerId
```

`ash-mcp` 不应依赖 `ash-core`、App Server、stores、Plugin manager 或 secret store。若本 crate
开始读取用户配置、决定 approval 或追加 Thread event，即表示 ownership 已漂移。

## 公共契约

宿主先完成 enablement、trust、可执行文件解析和 credential materialization，再构造
`McpServerDefinition`。`McpRuntime::start` 使用 production RMCP factory；
`start_with_factory` 允许测试或宿主注入隔离 session。

`McpStartupPolicy::RequireAll` 在任一 server 启动或 catalog 失败时关闭已启动 session 并整体失败；
`AllowPartial` 保留健康 server，并通过 `McpStartupDiagnostic` 返回脱敏诊断。重复 server ID 永远
拒绝。

每个 `McpToolBinding` 同时固定：

- model-visible `ToolName`；
- `McpServerId + exact remote tool name`；
- definition digest；
- connection generation；
- catalog generation。

`McpRuntime::call_tool` 不按 remote name 重新搜索。binding 不属于当前 snapshot 时在发送前返回
`NotStarted`，防止旧 catalog 劫持新连接。调用方应从 `catalog()` 获取 definition/binding，并在
Core safe point 以整个新 runtime 替换旧 runtime。

## 工具结果复核

初始化的 `capabilities.extensions["ash/resultReview"]` 公告 `{ "versions": [1] }`。
工具仅在已协商 v1 的宿主上，可通过返回值的 `_meta` 显式请求结果复核：

```json
{ "ash/resultReview": { "version": 1, "reason": "Review this captured output before sharing" } }
```

未提供该字段的结果继续正常交付。提供时必须是受支持版本，且 `reason` 是非空、最多 8192
UTF-8 字节的字符串；无效声明返回 `InvalidResult`，不能静默绕过复核。`ToolOutput` 保留该要求，
截断和附加 MCP App artifact 不得丢弃它。Core 捕获最终模型输出，绑定已执行的工具调用并持久化；
候选交互最多 4 MiB，媒体使用可检查的 URL 内容，不接受尚无结果条目的持久 attachment 引用。

分享把该候选结果交给模型；跳过交付未分享标记，取消也不披露结果。复核不请求新的执行权限，
不会撤销工具已产生的副作用，也不会在恢复后重新调用工具。支持的文件修改由独立 checkpoint
操作恢复。完整候选内容只向选定的交互 owner 交付，普通 Thread 订阅只获得脱敏的等待状态。

## 工具展示声明

MCP 工具目录可以在工具 `_meta["ash/activity"]` 声明 v1 展示内容。例如：

```json
{ "version": 1, "argumentPointer": "/presentation" }
```

该 JSON Pointer 从当前调用参数读取完整 `ToolActivity`；静态声明可改用 `activity` 字段。
声明随工具目录与绑定冻结，不从工具名称或任意结果 JSON 推断。`confirmation` 的 `presentation`
支持 `modifiedFiles`（`files` 含 `path`、可选 `original` 和 `modified`）、`agentFeedbackReview`
（`message`）、`extensionsInstall`（`extensions`）、`sandboxPrerequisite`（`dependencies` 和
`remediations`）及 `authentication`（`provider`）。这是原策略审批的只读证据，不能增加权限、
应用修改、安装扩展或执行修复；认证按钮使用绑定来源的 MCP 服务，登录后仍需批准。

声明最大 128 KiB；列表非空且最多 32 项，文件路径和沙箱条目最多 4096 字节，扩展 ID 和
认证展示名最多 256 字节，文件各版本／反馈最多 64 KiB。未知类型、缺失参数和超限内容在执行前失败。

结果可在根 `_meta["ash/resultPresentation"]` 返回结构化导航目标：

```json
{ "version": 1, "target": { "type": "sessionTarget", "sessionId": "session", "threadId": "child", "label": "Child task" } }
```

另一个类型是 `automationConfigured`，字段为 `automationId` 和 `label`。目标属于产生结果的
同一宿主；客户端只通过原 Session 的服务解析，不能切换到当前默认连接。标题非空且最多
512 字节，标识受领域类型及 256 字节上限约束；未知版本或无效声明返回 `InvalidResult`。
导航元数据作为 `viewMetadata` artifact 保存并计入输出预算，不进入模型文本。隐藏、替换或
关闭视图会取消尚未完成的导航；导航保留原会话草稿。

## 内部调用与校验

```text
McpRuntime::start[_with_factory]
→ reject_duplicate_servers
→ McpSessionFactory::connect
→ discover_server_tools
   → McpSession::list_tools
   → project_tool
   → ash_tools::from_mcp_tool_projection
→ McpCatalogSnapshot::new

McpRuntime::call_tool
→ 校验 cancellation、snapshot binding 和 object arguments
→ McpSession::call_tool
→ project_tool_result
```

`discover_server_tools` 是 catalog 的关键 private owner：它限制 page 数、每 server tool 数和序列化
byte 数，拒绝空/重复 cursor 与重复 remote tool name。`exposed_name` 对
`server ID + NUL + exact remote name` 做 SHA-256，并生成带 12 个 hex 字符后缀的稳定合法 alias；
可读 slug 不是 identity。

`RuntimeClientHost` 拦截 `ToolListChanged` 并把该 server 标成 `Stale`，同时继续转发 progress、
server cancellation 和 elicitation。它不会原地修改 catalog；宿主必须在 safe point 重建
runtime。

`project_tool_result` 保留 text 和合法 `image/*` block，将其他 RMCP block 序列化为 text，并把
text 交给 `ash-utils-output-truncation`（通过 `ash-tools::ToolOutput::truncate_text` 适配）按配置
预算做确定性 UTF-8 截断。图片 data URL 不能被切坏，因此仍作为不可截断的硬字节边界校验。MCP
`isError` 映射为
`ToolOutputStatus::Error`，不是 transport failure。

## 失败、取消与恢复

- 调用前 cancellation、非 object arguments 和 stale binding：`McpCallError::NotStarted`。
- 请求发送后的 cancellation、timeout、断线或协议错误：
  `McpCallError::OutcomeUncertain`；上层不得自动重放有副作用调用。
- 无法安全投影或图片超过 output limit：`McpCallError::InvalidResult`；普通 text 超限会被截断。
- `McpRuntime::shutdown(self)` 消费 runtime，逐 server shutdown 并返回失败诊断。

`McpSession` 实现必须将 cancellation 传入 transport；production adapter 使用
`RmcpClient::call_tool_with_cancellation` 发送 MCP cancellation notification。取消只停止本地等待
和尽力通知 server，不证明远端副作用未发生。

## 接入义务

App Server adapter 当前已负责 tools vertical slice 的：

- 从 user `ash-config` snapshot 选择已启用 server；
- materialize absolute stdio executable 与 unauthenticated HTTP endpoint；
- 把 `catalog().model_definitions()` 与 frozen binding 接入 Core `ToolService`；
- 执行 approval、durable Tool Call/Result、unknown-outcome recovery；

App Server 尚未负责 Plugin/directory capability、credential materialization、sandboxed stdio launcher、
config/list-changed 后的自动 safe-point rebuild，以及 progress/elicitation/diagnostic delivery。

## 测试与修改影响

```text
just test ash-mcp
just rust-warnings ash-mcp
bazel test //crates/ash-mcp:ash-mcp-unit-tests
```

`catalog_tests.rs` 覆盖 alias 的合法性、边界和 exact identity；`runtime_tests.rs` 使用 fake
factory 覆盖多 server catalog、冻结 binding 路由、部分启动、失效通知和旧 generation 拒绝；
`output_tests.rs` 覆盖 result limit 与 remote error status。修改 alias/hash、limit、binding 字段、
startup policy、cancellation 或 output projection 时，必须同步检查这些测试、本 README 和
[`../../docs/mcp.md`](../../docs/mcp.md)。

## 当前限制与扩展点

- Current：tools 的多 server discovery/call 已实现；resources、prompts、roots、sampling 和
  tasks 尚未进入 product runtime。
- Current：list-changed 只标记 stale；自动 reconnect、backoff、health state machine 和 catalog
  replacement 由后续 host lifecycle 实现；stale server 的新调用会 fail closed。
- Current：production factory 可连接 direct stdio 与 unauthenticated/bearer Streamable HTTP；
  sandboxed launcher、OAuth 和 credential refresh 需由宿主注入。
- Current：App Server/Core tools adapter、one-time approval 与 durable result 已接入；runtime
  snapshot 只在 App Server 启动时构造，且 App Server 当前采用 `RequireAll` startup。
- Extension point：实现 `McpSessionFactory` 可注入受 sandbox 管理的 process、远端执行或自定义
  HTTP stack，而不改变 catalog/binding 语义。
