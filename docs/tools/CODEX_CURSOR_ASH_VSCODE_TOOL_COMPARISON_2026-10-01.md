# Codex、Cursor、Ash、VS Code 工具对比


Cursor Agent、Ask、Plan、Debug、Multitask 的提示词原文与相关工具见 [模式专项文档](/Volumes/1t/ash/docs/tools/CURSOR_MODE_PROMPTS_AND_TOOLS_2026-10-01.md)（37 组生成结果，含 Ask 与 AskQuestion、工具与日志服务的区别）。

核查日期：2026-10-01。比较对象是提供给 Agent 的工具，以及工具从注册、选择到执行的链路。Cursor 已更新为本机安装的 **3.23.12**，直接核查安装包中的协议、工具构造、执行路由和 MCP Provider 注册。

**Ash 已有文件操作、代码检索、长进程控制、多 Agent、浏览器、MCP 和 Code Mode 的实现。与另外三个系统相比，值得继续核查的是 IDE 专用工具的覆盖，以及前端工具目录与模型实际工具目录是否一致。**

前面提到的当前 Codex 对话中 `ALL_TOOLS` 有 500 项，只是这个会话的运行时结果，不能拿来当 Codex 源码的固定工具数量，也不能和 Cursor 的协议枚举数量直接比较。

## 1. 比较范围与证据

| 对象 | 本次材料 | 结论适用范围 |
| --- | --- | --- |
| Codex | `/Volumes/1t/codex`，HEAD `59f18e8133` | 本机源码，包括 core、扩展、MCP、动态工具和 Code Mode；不代表所有发行版的默认配置 |
| Cursor | `/Applications/Cursor.app/Contents/Resources/app`，版本 **3.23.12**，commit `2d29876d567da1607532b23bbf2cd5ddbca496f0` | 2026-10-01 对本机安装包的静态核查；旧 2.6.20 文档只用于历史对照；不代表账号当前启用的工具列表 |
| Ash | `/Volumes/1t/ash`，HEAD `875796d3b` | 本机源码，包括 App Server 工具组合、Rust 扩展、前端目录接口和浏览器工具 |
| VS Code | `/Volumes/1t/vscode`，HEAD `e7bc1cca4bc` | 本机 Workbench 与仓库内 `extensions/copilot` 一起比较；只看 Workbench 会漏掉大量编码工具 |

HEAD 用于定位仓库版本；本次读取的是工作区文件，可能包含未提交变化。没有运行四个产品做端到端验证。

证据状态的含义：

- **实现已核实**：读到了工具定义、注册或执行代码；不等于当前会话已启用。
- **按配置提供**：需要功能开关、模型支持、后端配置、扩展或产品宿主能力。
- **协议证据**：安装包中定义了对应参数或结果分支；没有核实工具构造与执行路径的项，只记为协议存在。
- **本次未确认**：没有核实对应模型工具入口，不能据此断言产品完全没有这个能力。

Cursor 本机版本由 `Info.plist`、`package.json` 和 `product.json` 交叉确认；`product.json` 的构建时间是 `2026-10-01T04:41:16.627Z`。本次没有启动 Cursor、调用工具或读取账号会话。[安装包版本](/Applications/Cursor.app/Contents/Resources/app/package.json)、[构建信息](/Applications/Cursor.app/Contents/Resources/app/product.json)

旧生成 proto 和 2.6.20 工具地图不再作为当前目录依据。3.23.12 同时包含 `aiserver.v1.ClientSideToolV2` 和 `agent.v1.ToolCall` 两套协议，实际构造的工具还会按模型、模式、功能开关和动态工具配置变化。第 3.2 节分别列出这些证据，避免把协议分支数当成模型工具数。

## 2. 能力对照

下表按任务能力比较，不按工具名字或数量排名。通过 shell 完成任务、专用模型工具、编辑器内部 API 是三个不同层次。

| 能力 | Codex 源码 | Cursor 3.23.12 本机安装包 | Ash 源码 | VS Code + Copilot 源码 |
| --- | --- | --- | --- | --- |
| 读取工作区文件 | 本次 core 注册路径未见专用工作区读取工具；通常由 `exec_command` 执行读取 | READ 已有构造与执行代码；名称与参数由 `promptVersion` 和运行配置选择 | `read_file`，支持行偏移和数量 | `read_file` |
| 新建、覆盖文件 | shell 或 `apply_patch` | WRITE 工具、`ApplyPatch` 有实现 | `write_file`、`apply_patch` | `create_file`、`create_directory`、`apply_patch` |
| 修改已有文件 | `apply_patch`，模型配置决定暴露 | STR_REPLACE、`ApplyPatch`、Notebook 编辑有实现；旧 V2 编辑协议仍保留 | `edit` 精确替换、`apply_patch` | `insert_edit_into_file`、单次 / 批量替换、`apply_patch` |
| 文件名搜索 | 通过 shell 调用文件搜索命令 | GLOB 工具有实现；旧 `file_search` 协议仍存在 | `glob` | `file_search` |
| 文本 / 正则搜索 | 通过 shell 调用 `rg` 等命令 | GREP 工具有实现，另有 `pi_grep` 工具变体 | `grep` | `grep_search` |
| 代码语义检索 | 本次 core 注册路径未见内置工作区语义检索工具；可由外部工具提供 | `SemanticSearch` / `codebase_search` 有实现，依赖代码索引；是否提供由开关决定 | `search_code`，组合代码索引、符号、语义与云检索来源；可用性取决于配置 | `semantic_search`、`github_repo` |
| 符号搜索 / 定义 / 引用 | 可通过 shell、语言工具或扩展完成；本次未确认专用 core 工具 | V2 协议有 `search_symbols`、`gotodef`；本次未确认当前 Agent 工具装配使用它们 | `search_code` 接入符号索引；独立定义跳转 / 引用工具本次未确认 | `search_workspace_symbols`、`vscode_listCodeUsages` |
| 语义重命名 | 本次未确认专用 core 工具 | 本次未确认独立模型工具 | 本次未确认专用模型工具 | `vscode_renameSymbol`，调用语言重命名提供者 |
| 诊断与测试 | 用 shell 执行检查、测试 | `ReadLints` 有诊断读取实现；`fix_lints` 仅核实旧协议；测试可经 shell 执行 | shell 可执行检查、测试；诊断 / 测试专用模型工具本次未确认 | `get_errors`、`test_search`、`runTests`、`testFailure` |
| 命令执行 | `exec_command` | SHELL 工具和 `pi_bash` 变体有实现 | `shell-command` 执行器 | `run_in_terminal` |
| 持续进程与输入 | `exec_command` 返回运行会话，`write_stdin` 写入或观察 | shell 工具有等待 / 后台选项；协议有 `write_shell_stdin`、`await` | `shell-session`：启动、读取、等待、写入、EOF、中断、调整终端尺寸、终止 | `get_terminal_output`、`send_to_terminal`、`kill_terminal` |
| IDE 任务 | 通过 shell；专用 IDE 任务工具本次未确认 | TASK 是子 Agent 工具，不能算 IDE task | 进程工具已有；专用 IDE task 模型入口本次未确认 | `create_and_run_task`、`run_task`、`get_task_output` |
| 规划与目标 | `update_plan`；Goal 扩展提供 `get_goal`、`create_goal`、`update_goal` | 计划 / todo 有构造；`CreateGoal`、`UpdateGoal` 有执行实现 | `update_plan`、Goal 三个工具 | `manage_todo_list`、`vscode_reviewPlan` |
| 向用户提问 | `request_user_input`、异步提问，按开关与模型提供 | ASK_QUESTION 有参数校验、暂停和结果恢复代码 | MCP elicitation 有交互通道；独立通用提问模型工具本次未确认 | `vscode_askQuestions`、确认工具 |
| 多 Agent | V1 / V2 启动、消息、等待、恢复 / 关闭或中断 / 列表，按配置选择 | TASK、`create-agent`、`send-message-to-agent` 有构造；协议新增状态、转交、读取 transcript、创建 / 停止 Agent | `spawn_agent`、`send_agent_message`、`wait_agent`；团队消息工具 | `runSubagent`；搜索、执行专用子 Agent 工具 |
| 历史、笔记与记忆 | History / Notes / Memories 扩展 | `SearchConversations` 有本地索引搜索实现；不能因此等同可写的持久记忆工具 | `history_*`、`notes_*`、`memories-*`，按扩展安装与授权提供 | `memory`、`resolve_memory_file_uri`、`session_store_sql` |
| 规则与 Skill | 指令装配、Skill 扩展与读取工具 | 配置包含 rules / agent skills；`fetch_rules` 旧协议保留，不等同已确认独立 Skill 读取工具 | `read_instruction`、`skills-read` | `skill`；Agent / Skill 配置另有装配链路 |
| Web | 托管 Web Search schema；另有 `web.run` 扩展 | WEB_SEARCH、`WebFetch` 有构造与执行；`deep_search` 仅核实旧协议 | `web_search` 扩展，依赖后端配置；独立网页抓取工具本次未确认 | `fetch_webpage`；它不等同搜索引擎 |
| 图片 | `view_image`；图像生成扩展按配置提供 | READ 支持图片 / PDF；GENERATE_IMAGE 有执行与模型限制判断 | `imagegen` 扩展已有；独立本地图片查看工具本次未确认 | `view_image`；图像生成专用工具本次未确认 |
| 浏览器自动化 | core 外由产品宿主、MCP / 动态工具扩充；不能用当前桌面会话的工具反推 core 默认工具 | 本机 browser automation MCP Provider 注册并路由 16 个工具，含 `browser_cdp` | 10 个 `browser_*` 工具，依赖 Electron 浏览器宿主 | 打开、读取、截图、导航、点击、悬停、拖拽、输入、对话框、Playwright 等工具 |
| 通用桌面操作、录屏 | 本次 core 注册路径未确认；可由产品工具扩充 | 独立 computer-use MCP Provider 有定义 / 路由；`RecordScreen` 有工具构造与执行入口 | 本次未确认通用桌面操作 / 录屏模型工具 | 本次未确认通用桌面操作 / 录屏模型工具 |
| Notebook | shell 或外部工具；专用工具本次未确认 | `EditNotebook` / `edit_notebook` 有实现，支持修改和新建 cell；运行 / 输出专用工具本次未确认 | 本次未确认专用模型工具族 | 创建、编辑、运行 cell、读取输出、摘要工具 |
| MCP / 动态工具 | MCP 资源、模板、调用、动态工具、发现与延迟加载 | `GetMcpTools` / `CallMcpTool` 或 `GetDynamicTools` / `CallDynamicTool` 按配置装配；发现支持 RE2 pattern | MCP、动态工具、扩展统一组合；大 MCP 目录另有搜索 / 调用入口 | 语言模型工具服务、扩展 API 与 MCP 工具贡献 |
| JavaScript 编排工具 | Code Mode：`exec` / `wait`，调用 `tools.*` | 本次未确认跨全部工具的等价 Code Mode；`browser_cdp` 可请求浏览器 Runtime 域能力 | Code Mode 运行时和目录接口已有 | `run_playwright_code` 是浏览器域能力；本次未确认跨全部工具的等价执行器 |

主要源码入口：[Codex 注册链路](/Volumes/1t/codex/codex-rs/core/src/tools/spec_plan.rs:1091)、[Ash 本地工具](/Volumes/1t/ash/ash-rs/app-server/src/local_tools/suite.rs:166)、[VS Code / Copilot 工具名称](/Volumes/1t/vscode/extensions/copilot/src/extension/tools/common/toolNames.ts:21)。Cursor 当前项采用[Agent 工具构造与装配](/Applications/Cursor.app/Contents/Resources/app/extensions/cursor-agent-exec/dist/main.js)、[两套协议](/Applications/Cursor.app/Contents/Resources/app/extensions/cursor-resolver/dist/browser/main.js:27501)、[浏览器 Provider](/Applications/Cursor.app/Contents/Resources/app/extensions/cursor-browser-automation/dist/extension.js)、[桌面操作 Provider](/Applications/Cursor.app/Contents/Resources/app/extensions/cursor-computer-use/dist/extension.js)。

## 3. 已核实的工具族与实现入口

### 3.1 Codex

Codex 的工具来源至少包括 core handler、扩展、MCP、客户端动态工具和模型服务提供的工具。不能只统计 `handlers/` 文件，也不能把安装的所有 MCP 工具算成固定内置工具。

| 工具族 | 已核实的名称 / 行为 | 源码入口 |
| --- | --- | --- |
| 命令、补丁、图片查看 | `exec_command`、`write_stdin`、`apply_patch`、`view_image` | [注册与条件](/Volumes/1t/codex/codex-rs/core/src/tools/spec_plan.rs:1091) |
| 计划与用户交互 | `update_plan`、`request_user_input`、`request_user_input_async`、`send_message_to_user_async`、权限请求 | [utility 注册](/Volumes/1t/codex/codex-rs/core/src/tools/spec_plan.rs:1149) |
| 时间与上下文 | 时间、sleep、等待环境、新上下文窗口、剩余上下文查询；由配置控制 | [utility 注册](/Volumes/1t/codex/codex-rs/core/src/tools/spec_plan.rs:1149) |
| 多 Agent V1 | `spawn_agent`、`send_input`、`resume_agent`、`wait_agent`、`close_agent` | [协作注册](/Volumes/1t/codex/codex-rs/core/src/tools/spec_plan.rs:1293) |
| 多 Agent V2 | `spawn_agent`、`send_message`、`followup_task`、`wait_agent`、`interrupt_agent`、`list_agents`；命名空间和部分入口可配置 | [协作注册](/Volumes/1t/codex/codex-rs/core/src/tools/spec_plan.rs:1293) |
| MCP 资源 | `list_mcp_resources`、`list_mcp_resource_templates`、`read_mcp_resource` | [MCP resource 注册](/Volumes/1t/codex/codex-rs/core/src/tools/spec_plan.rs:1133) |
| 发现与插件 | `tool_search`、可安装插件列表、请求插件安装 | [工具目录收尾](/Volumes/1t/codex/codex-rs/core/src/tools/spec_plan.rs:349) |
| Code Mode | `exec` / `wait`，工具映射到 JavaScript 可调用名称 | [Code Mode 装配](/Volumes/1t/codex/codex-rs/core/src/tools/spec_plan.rs:819) |
| Goal | `get_goal`、`create_goal`、`update_goal` | [Goal 定义](/Volumes/1t/codex/codex-rs/ext/goal/src/spec.rs:9) |
| History / Notes | `history.list_windows/list_items/read_item/search_contents`；`notes.list_files_by_prefix/read_file/search_contents/append_to_file/write_file` | [历史与笔记工具](/Volumes/1t/codex/codex-rs/ext/history-notes/src/tools.rs:72) |
| 其他扩展 | Memories、Skills、消息板、Web、图像生成等；是否安装与可用由宿主和步骤配置决定 | [每步骤扩展工具装配](/Volumes/1t/codex/codex-rs/core/src/tools/spec_plan.rs:330) |

`notes.read_file` 读取的是任务笔记，不能因为名字中有 `read_file` 就把它算成工作区文件读取工具。

### 3.2 Cursor

当前安装包同时包含历史客户端协议、Agent 工具定义、本地执行扩展、Agent Host、私有推理运行时，以及浏览器 / computer-use MCP Provider。因此不能继续只用“服务端下发 V2 调用、客户端执行”描述全部路径。

`cursor-agent-host` 的 manifest 声明它承载 Agent 编排，`cursor-local-agent-runtime` 声明它在工作区 extension host 之外承载 Private Inference；安装包中确实有对应实现。这证明本机存在这些组成部分，不证明所有模型都在本地推理，也不证明当前账号启用了私有推理。[Agent Host](/Applications/Cursor.app/Contents/Resources/app/extensions/cursor-agent-host/package.json)、[私有推理运行时](/Applications/Cursor.app/Contents/Resources/app/extensions/cursor-local-agent-runtime/package.json)

#### 全部静态工具定义与输出的提取结果

后续已把 READ 专项扩展到全部静态工具：[完整定义与输出说明](/Volumes/1t/ash/docs/tools/CURSOR_ALL_TOOL_DEFINITIONS_2026-10-01.md)、[完整 JSON](/Volumes/1t/ash/docs/tools/CURSOR_ALL_TOOL_DEFINITIONS_2026-10-01.json)。JSON 保留名称 / 描述 / 参数构造、原始执行与 render、作用域依赖、Provider 分发，以及两代调用协议。动态表达式没有替换成猜测的固定定义。

三个 Agent bundle 共 158 个工具工厂调用点，按内部标识合并为 53 类；其中包含跨 bundle 重复、测试与特定配置变体，不能称为默认可用 53 个工具。Agent Host 另外包含 `SEND_FINAL_SUMMARY`（`sendFinalSummary`）和 `COMMUNICATE_UPDATE`（`UpdateCurrentStep`），前面只查 agent-exec 时未列出，本次已补齐。浏览器仍为 16 个定义 / 路由；computer-use 定位到 19 个描述符构造点，并按三组平台 / scope 条件展开，是否提供仍由 gate 控制。

参数 schema 的原式与依赖是主要证据；转换得到的 JSON Schema 不能完整表达自定义校验与转换。工具输出代码已逐项保留，但没有真实调用所有工具；当前账号或模型请求最终启用的目录，以及外部 MCP / 服务端动态目录，未进行运行时抓取。

#### 协议定义与工具装配要分开

| 集合 | 本机提取结果 | 如何解读 |
| --- | --- | --- |
| `aiserver.v1.ClientSideToolV2` | 55 个枚举项，含 `UNSPECIFIED` | 不能算成 55 个可调用工具 |
| `aiserver.v1.ClientSideToolV2Call` | 49 个 `_params` 字段 | 不等同上述枚举集合，更不等同当前模型工具列表 |
| `agent.v1.ToolCall` | 70 个 `oneof: tool` 分支 | 包含文件工具、协调、媒体、PR、环境与 `truncated` 占位等；不是 70 个默认本地工具 |
| browser automation Provider | 16 个工具定义，16 个匹配的调用路由 | 是本机这一个 Provider 的静态提供列表，仍会受上层启用和策略影响 |
| computer-use Provider | 按平台、模式和 gate 构造 descriptors | 不能把 bundle 中所有 `computer_*` 字符串都算作 macOS 当前可用工具 |

来源：[V2 枚举](/Applications/Cursor.app/Contents/Resources/app/extensions/cursor-resolver/dist/browser/main.js:45440)、[V2 参数](/Applications/Cursor.app/Contents/Resources/app/extensions/cursor-resolver/dist/browser/main.js:45672)、[Agent 调用协议](/Applications/Cursor.app/Contents/Resources/app/extensions/cursor-resolver/dist/browser/main.js:27501)。

#### 有工具构造或执行代码的能力

以下大写键是工具内部标识；模型看到的名称可能随版本变化。例如 `SemanticSearch` / `codebase_search`、`EditNotebook` / `edit_notebook`。它们不应被重复算成两份能力。

| 工具族 | 本机核实结果 |
| --- | --- |
| 文件读取、写入与删除 | READ、WRITE、DELETE 有参数与执行路径；READ 有文本、图片与 PDF 文本转换分支；对模型的描述由配置选择 |
| 编辑 | STR_REPLACE、`ApplyPatch`、EDIT_NOTEBOOK 有构造 / 执行代码；Notebook 编辑支持已有 cell 和新 cell |
| 目录与搜索 | LS、GLOB、GREP 有实现；SEMANTIC_SEARCH 依赖代码索引，并按开关装配 |
| IDE 诊断 | READ_LINTS 对文件 / 目录或工作区读取诊断；`fix_lints` 目前只作为旧 V2 协议证据 |
| 命令与进程等待 | SHELL 有沙箱、只读、后台 / 等待等参数配置；AWAIT 有构造；`write_shell_stdin` 在 Agent 与 V2 协议中均存在 |
| 计划、todo 与模式 | CREATE_PLAN_V2、TODO_WRITE、`SwitchMode` 有构造 |
| Goal | `CreateGoal`、`UpdateGoal` 有参数与执行实现；不能把它们只记为协议占位 |
| 提问与用户交互 | ASK_QUESTION 有状态恢复 / 暂停处理；`SendMessage`、`SendToUser` 有工具构造 |
| 子 Agent | Agent Host 另有 `sendFinalSummary` 和 `UpdateCurrentStep`；TASK 有 `prepareSubagent`；`create-agent`、`send-message-to-agent` 有构造；本地 / 云端子 Agent 按配置选择 |
| 会话检索 | `SearchConversations` 查询本地会话与缓存云会话索引，返回 ID、标题和片段；不等同全量 transcript 或可写记忆 |
| Web 与图片 | WEB_SEARCH、`WebFetch`、GENERATE_IMAGE 有构造与执行路径；图像生成有当前模型限制判断 |
| 录屏与环境 | `RecordScreen`、`ReplaceEnv`、`SetupVmEnvironment` 有构造与执行入口；是否可执行还取决于宿主和任务环境 |
| PR / CI / SCM | `UpdatePrCodeTour`、`GetPrCodeTour`、`record_ci_investigation_findings`、`ConnectScm`、`SetActiveBranch` 有构造 |
| 工具发现 | `GetMcpTools` / `CallMcpTool`，或配置选择的 `GetDynamicTools` / `CallDynamicTool`；发现可按 server / namespace / toolName / RE2 pattern 查询 |
| Pi 工具变体 | `pi_read`、`pi_bash`、`pi_edit`、`pi_write`、`pi_grep`、`pi_find`、`pi_ls` 有构造；它们是另一套工具契约，不代表所有模型同时启用 |

这张表来自 [cursor-agent-exec bundle](/Applications/Cursor.app/Contents/Resources/app/extensions/cursor-agent-exec/dist/main.js) 的工具构造、执行函数和最终装配路径。仅做静态核查，没有实际调用这些工具。

其他新增分支目前保守记为**协议存在**：`get_agent_status`、`send_to_agent`、`read_agent_transcript`、`create_agent`、`stop_agent`、`write_canvas`、`read_canvas`、`generate_video`。虽然安装包中有协议和序列化代码，本次没有核实它们各自的本地执行闭环，不能因为 `case` 字符串存在就记为实现完成。

#### READ：内部标识、模型名称与执行路径

`READ` 是工具工厂使用的内部标识，模型实际收到的名称由 `promptVersion` 选择。调用方使用 `promptVersion ?? modelInfo.promptVersion` 这一类配置来源，因此“按模型版本变化”不够准确：这里直接控制的是工具提示配置版本，不能只看模型商品名推断名称。

| `promptVersion` / 运行配置 | 模型看到的名称 | 主要参数 |
| --- | --- | --- |
| `dsv3-1018` | `read_file` | `target_file`、可选 `offset` / `limit`；路径描述允许工作区相对路径或绝对路径 |
| `gpt5-codex`、`codex-cloud` | `ReadFile` | `path`、可选 `offset` / `limit`；路径描述要求绝对路径 |
| `cursor-0226`、`dsv3-1205`、`latest` | `Read` | `path`、可选 `offset` / `limit` |
| `haiku` | `Read` | `path`、可选 `line_range: [起始行, 结束行]` |
| `useMinimalHarness = true`，优先于上述版本 | `ViewImage` | `path`；工具描述限定读取图片，普通文件读取交给 Shell |

`offset` 表示起始行，`limit` 表示行数。例如 `offset: 100, limit: 51` 读取第 100–150 行；`haiku` 的 `line_range: [100, 150]` 会转换成同样的内部参数。起始行从 1 计数；schema 会把 `offset: 0` 转成 1。`cursor-0226` 明确允许负偏移，其他采用 offset 的配置是否允许负数取决于 `enableNegativeOffset`；`-1` 表示从最后一行开始。`include_line_numbers` 是否出现在 schema 中也受开关控制。

它不只是改名称：工厂一起选择名称、参数 schema、工具描述和输出格式。`ViewImage` 的描述与 schema 表达图片用途，但本次静态核查没有单独证明所有非图片输入都会被硬性拒绝。

执行路径为：

```text
READ 工具工厂
  → 按 promptVersion / 运行配置生成工具定义
  → 校验并统一参数（target_file/path、line_range/offset/limit）
  → 构造 agent.v1.ReadArgs 和 readToolCall
  → executeToolCall 编排
  → 所选文件读取服务 execute
  → 按文本 / 图片 / PDF 分支整理结果并返回模型
```

执行与结果处理代码包括：文件不存在 / 权限拒绝等错误结果；文本分段与行号格式；图片 MIME 与图像内容返回；PDF 文本转换；大内容处理；记录已读取路径。在读取结果中，它还会附带匹配的 Cursor rules 内容和相关 skills 的路径 / 描述，并做去重。因此 READ 不只是一个 `readFile()` 包装。

以上证据来自本机 Cursor 3.23.12 的 [cursor-agent-exec bundle](/Applications/Cursor.app/Contents/Resources/app/extensions/cursor-agent-exec/dist/main.js)，可搜索 `function Wfe`、`const Hfe` 与 `a$("READ"`。这些短函数名由打包压缩生成，后续版本可能改变。表格证明安装包能构造这些变体；某次请求究竟暴露哪一个名称，还要看该请求最终配置与工具列表。不同名称不能重复统计为多份读取能力，也不能仅凭内部 `READ` 键就认为所有变体契约完全相同。

#### READ 的具体定义与输出

完整提取结果保存在 [READ 定义与输出 JSON](/Volumes/1t/ash/docs/tools/CURSOR_READ_TOOL_DEFINITIONS_2026-10-01.json)：包含 7 种 `promptVersion` 的基础定义、1 组 ViewImage 配置和 2 组开关组合，共 10 组配置示例；另有 9 个协议消息定义、8 组输出 fixture 和原始代码片段。这不是 10 个独立工具，也不是某次会话实际下发的完整 catalog。

提取方法：从本机 bundle 取出原始描述函数、结果渲染函数和行号格式函数，在隔离环境中用指定配置及测试数据运行；没有启动整个 bundle，也没有调用 Cursor 的文件读取服务。下方 JSON Schema 是根据 Zod 构造代码整理的等价可读表示，不是从模型请求中抓到的 wire schema。原始参数构造代码也保存在 JSON 中，供核对自定义校验和转换。

**模型侧定义示例。** 采用 `promptVersion = latest`，可选开关关闭，无 machine selector、无描述覆盖。`description` 是原始函数生成的完整英文文案；`name` 和参数字段来自工厂分支：

```json
{
  "name": "Read",
  "description": "Reads a file from the local filesystem. You can access any file directly by using this tool.\nIf the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.\n\nUsage:\n- You can optionally specify a line offset and limit (especially handy for long files), but it's recommended to read the whole file by not providing these parameters.\n- Lines in the output are numbered starting at 1, using following format: LINE_NUMBER|LINE_CONTENT\n- You have the capability to call multiple tools in a single response. It is always better to speculatively read multiple files as a batch that are potentially useful.\n- If you read a file that exists but has empty contents you will receive 'File is empty.'\n\nImage Support:\n- This tool can also read image files when called with the appropriate path.\n- Supported image formats: jpeg/jpg, png, gif, webp.\n\nPDF Support:\n- PDF files are converted into text content automatically (subject to the same character limits as other files).",
  "parameters": {
    "type": "object",
    "properties": {
      "path": {
        "type": "string",
        "description": "The absolute path of the file to read."
      },
      "offset": {
        "type": "integer",
        "minimum": 0,
        "description": "The line number to start reading from. Only provide if the file is too large to read at once."
      },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "description": "The number of lines to read. Only provide if the file is too large to read at once."
      }
    },
    "required": [
      "path"
    ]
  }
}
```

`required` 只有 `path`；`offset` 与 `limit` 可以不传。schema 接受 `offset: 0`，随后转换为 1，所以这里的 `minimum: 0` 是有意保留原代码行为。`haiku` 的 `line_range` schema 只校验两个整数；该段构造代码没有额外校验起止顺序或正数范围。配置还可能追加 `include_line_numbers` 和 machine selector；描述也允许整体覆盖，不能把上述示例当成全部会话固定定义。

**读取服务结果与工具结果是两层结构。**

| 层 | 具体字段 / 分支 | 用途 |
| --- | --- | --- |
| 文件读取服务 `ReadResult` | `success`、`error`、`rejected`、`file_not_found`、`permission_denied`、`invalid_file` | 表示实际读取是否完成以及失败原因 |
| 服务成功值 `ReadSuccess` | `path`、`content` / `data`、`total_lines`、`file_size`、`truncated`、`output_blob_id`、`range_applied` | 携带读取内容和服务侧信息 |
| 工具 `ReadToolResult` | `success` / `error` | 工具执行整理后的结果 |
| 工具成功值 `ReadToolSuccess` | `content` / `data` / `data_blob_id` / `content_blob_id`，以及 `is_empty`、`exceeded_limit`、`total_lines`、`file_size`、`path`、`read_range`、`include_line_numbers`、相关规则字段 | 供后续渲染、记录和传输使用 |
| 返回模型的内容 | `content` 数组与 `isError` | 文本或图片内容；不是把整个成功值 JSON 直接返回模型 |

来源：[服务读取协议](/Applications/Cursor.app/Contents/Resources/app/extensions/cursor-resolver/dist/browser/main.js:58907)、[工具读取协议](/Applications/Cursor.app/Contents/Resources/app/extensions/cursor-resolver/dist/browser/main.js:31202)。上表沿用 protobuf 字段名；JavaScript 对象使用 `totalLines`、`readRange` 等字段名。

**文本输出。** 以下输入为测试数据：文件共 200 行，此次取得第 100–101 行；开启普通行号格式。实际运行原始 renderer 得到：

```json
{
  "content": [
    {
      "type": "text",
      "text": "... 99 lines not shown ...\n   100|const a = 1;\n   101|const b = 2;\n... 99 lines not shown ..."
    }
  ],
  "isError": false
}
```

其中 `text` 展开为：

```text
... 99 lines not shown ...
   100|const a = 1;
   101|const b = 2;
... 99 lines not shown ...
```

相同内容的其他输出样式也已核对：关闭行号时直接返回源码；`gpt5StyleLineNumbers` 使用 `L100:...`；`gpt5CodexCatN` 使用补空格的行号加两格空格。样式由格式配置选择，不能只凭工具名判断。命中规则或 skills 时，文本结果还会追加以下标题及对应内容：

```text
The following cursor rule files are relevant to the files you just read:
- <规则路径>
<完整规则内容>

Consider these rules if they affect your changes.

The following skills may be relevant to the files you just read:
- <skill 路径>
<skill 描述>
```

此处尖括号为说明占位符，不是运行时输出。规则 / skills 的匹配本次只核查代码，没有实际执行。

**图片输出。** 原始 renderer 返回如下结构。这里的 `AQID` 是三个测试字节的 base64；不是有效图片。测试替代了 MIME 检测，仅用于核对返回结构：

```json
{
  "content": [
    {
      "type": "text",
      "text": "Read image file: /example/image.png"
    },
    {
      "type": "image",
      "data": "AQID",
      "mimeType": "image/png"
    }
  ],
  "isError": false
}
```

真实读取时，图像内容可能先以 blob ID 保存，渲染时取回字节再转换成上述图像块。PDF 则经过文本转换，走文本输出分支。

**空文件、过长内容与错误。** 以下是原始 renderer 对测试输入的结果，不是实际读取日志：

| 情况 | 模型收到的文本 | `isError` |
| --- | --- | --- |
| 空文件 | `File is empty.` | `false` |
| 超长内容 | `File content (120000 characters) exceeds maximum allowed characters (100000 characters).`，随后建议用 offset / limit 或 grep | `false` |
| 文件不存在 | `Error: File not found` | `true` |
| 无 result | `Unknown error` | `true` |

长度判断使用读出文本的 JavaScript 字符串长度；提示中的数量来自 `fileSize` 字段，不应把这个提示当成精确的字节 / Unicode 字符数定义。隔离验证覆盖输出包裹、四种文本格式、空文件、过长内容与错误；未验证真实文件权限、blob 取回、Notebook、PDF 转换、规则 / skills 匹配和实际模型会话。

#### 浏览器：当前实际提供 16 个工具

```text
browser_navigate       browser_snapshot       browser_click
browser_mouse_click_xy browser_type           browser_fill
browser_select_option  browser_press_key      browser_scroll
browser_drag           browser_get_bounding_box browser_highlight
browser_tabs           browser_cdp            browser_take_screenshot
browser_lock
```

这 16 个名称来自 `this.tools` 数组；`listOfferings()` 返回该数组，`callTool()` 有逐项匹配的路由，扩展启动时调用 `registerMcpProvider()`。这比扫描字符串更接近实际工具目录。[注册与路由](/Applications/Cursor.app/Contents/Resources/app/extensions/cursor-browser-automation/dist/extension.js)

与旧研究记录相比，需要做四个修正：

- 当前 Provider 没有注册旧清单中的 `browser_hover`、`browser_fill_form`、`browser_evaluate`、console / network / profiling 等独立入口。部分旧函数或建议文字仍在 bundle 中，不能据此把它们算进目录。
- 新的 `browser_cdp` 接受 `method` 和 `params`，向宿主发送 Chrome DevTools Protocol 命令；代码还处理 `Profiler.stop` 等大结果。它把一些调试能力集中到一个入口，不应把工具数减少直接解释为功能减少。具体方法和权限仍由宿主控制。
- 鼠标坐标点击和按键有独立的 `browser_mouse_click_xy`、`browser_press_key`；锁定 / 解锁合为 `browser_lock` 的 action。
- `browser_cpp_telemetry` 是 feature gate 名称，不是工具；扫描到 19 个带引号的 `browser_*` 名称不等于提供 19 个工具。

历史 2.6.20 文档列出 33 个名称，只保留为历史参考，不再用于当前 Ash 浏览器差异判断。[历史工具地图](/Users/lance/Desktop/docs/research/cursor/CURSOR_2_6_20_TOOLS_MAP.md)

#### computer-use：独立 MCP Provider 与平台条件

本机 `cursor-computer-use` 扩展有 descriptors、参数校验、执行路由和 MCP 注册。其 Provider 在 `listOfferings()` 中根据平台、模式和 feature gates 生成目录。[Provider 实现](/Applications/Cursor.app/Contents/Resources/app/extensions/cursor-computer-use/dist/extension.js)

| 工具组 | bundle 中核实的入口 | 条件 |
| --- | --- | --- |
| 屏幕与坐标动作 | `computer_screenshot`、`computer_click`、`computer_move`、`computer_drag`、`computer_type`、`computer_key`、`computer_scroll`、`computer_wait` | 提供方式与结果随平台、companion 模式变化 |
| 控制生命周期 | `computer_start_control`、`computer_release_control`、`computer_check_permissions` | 平台与控制模式相关 |
| macOS 应用与元素 | `computer_apps`、`computer_resolve_app`、`computer_app_state`、`computer_app_action`、`computer_set_value` | `darwin` / app target 路径；不等同坐标点击 |
| 缩放 / 批量执行 | `computer_zoom`、`computer_batch`、`computer_attempt` | 工具定义含平台或 gate 条件；未核实当前账号启用状态 |

底层还使用 `computer_use_*` 动作协议。上层 Provider 名称、底层动作名称和 `agent.v1.computer_use_tool_call` 是不同集合，不应相加统计。

#### 协议清单：70 个 Agent ToolCall 分支

以下从本机 `agent.v1.ToolCall` 的 `oneof: tool` 字段提取，去掉共同的 `_tool_call` 后缀。此清单用于定位协议覆盖，不表示当前模型能同时调用它们。

```text
shell delete glob grep read update_todos read_todos edit ls read_lints
mcp sem_search create_plan web_search task list_mcp_resources
read_mcp_resource apply_agent_diff ask_question fetch switch_mode
generate_image record_screen computer_use write_shell_stdin reflect
setup_vm_environment truncated start_grind_execution start_grind_planning
web_fetch report_bugfix_results ai_attribution pr_management mcp_auth
await blame_by_file_path get_mcp_tools report_bug set_active_branch
communicate_update send_final_summary update_pr_code_tour replace_env
edit_pr_labels record_ci_investigation_findings send_message
fetch_cloud_agent_data send_to_user pi_read pi_bash pi_edit pi_write
pi_grep pi_find pi_ls connect_scm search_conversations create_goal
update_goal adopt get_agent_status send_to_agent read_agent_transcript
create_agent stop_agent get_pr_code_tour write_canvas read_canvas generate_video
```

#### 安装包指纹

以下 SHA-256 前 16 位用于复核静态样本。若 Cursor 自动更新，先重新核实版本和指纹，再复用本文数量。

| 安装包内文件 | 大小（字节） | SHA-256 前 16 位 |
| --- | ---: | --- |
| `cursor-resolver/dist/browser/main.js` | 4,980,385 | `128b90666130f163` |
| `cursor-agent-exec/dist/main.js` | 8,933,590 | `9703f940d08671ad` |
| `cursor-agent-host/dist/main.js` | 11,017,304 | `7f21d5cc4cace369` |
| `cursor-local-agent-runtime/dist/main.js` | 6,202,896 | `e424bc3d66434da7` |
| `cursor-browser-automation/dist/extension.js` | 221,927 | `bdfa9b4e291d5863` |
| `cursor-computer-use/dist/extension.js` | 1,506,347 | `410ac8407a1df547` |

### 3.3 Ash

Ash 通过 App Server 组合 Environment、Dynamic、Extension、Host、Local、MCP 六类来源，登记工具定义、执行路由、来源和暴露方式。[组合代码](/Volumes/1t/ash/ash-rs/app-server/src/tool_composition.rs:998)

| 工具族 | 已核实的名称 / 行为 | 源码入口 |
| --- | --- | --- |
| 本地文件与搜索 | `read_file`、`write_file`、`edit`、`grep`、`glob` | [本地工具集](/Volumes/1t/ash/ash-rs/app-server/src/local_tools/suite.rs:166) |
| 执行与补丁 | `shell-command` 执行器、`apply_patch`；同名 shell service 先标为 Hidden，再由执行器贡献替换，最终暴露以执行器为准 | [组合与暴露](/Volumes/1t/ash/ash-rs/app-server/src/local_tools.rs:245)、[替换规则](/Volumes/1t/ash/ash-rs/app-server/src/tool_composition.rs:365) |
| 长进程 | `shell-session`，action 包含 `start/read/wait/write/close_input/interrupt/resize/terminate` | [会话描述与 schema](/Volumes/1t/ash/ash-rs/app-server/src/local_tools/suite.rs:92) |
| 代码检索 | `search_code`，接入符号、语义与云检索来源 | [工具实现](/Volumes/1t/ash/ash-rs/app-server/src/codebase_retrieval_tool.rs:33)、[实际接入](/Volumes/1t/ash/ash-rs/app-server/src/server/environment_runtime.rs:2245) |
| 计划与目标 | `update_plan`、`get_goal`、`create_goal`、`update_goal` | [计划工具](/Volumes/1t/ash/ash-rs/app-server/src/server/update_plan_tool.rs:35)、[Goal](/Volumes/1t/ash/ash-rs/ext/goal/src/tool.rs:27) |
| 模式切换 | `switch_mode(mode, reason)`；更新当前 Turn 的模式及下一次调用的模式提示词。Plan / Ask → 执行模式需用户明确选择；权限、角色和工具快照保持不变 | [工具与约定](tools.md#当前-turn-的模式切换)、[执行代码](/Volumes/1t/ash/ash-rs/app-server/src/server/switch_mode_tool.rs) |
| 咨询与指令 | `advisor`、`read_instruction` | [Advisor](/Volumes/1t/ash/ash-rs/ext/advisor/src/lib.rs:30)、[指令读取](/Volumes/1t/ash/ash-rs/app-server/src/server/instruction_operations.rs:169) |
| 多 Agent 与团队 | `spawn_agent`、`send_agent_message`、`wait_agent`、`team_post_message`、`team_read_messages` | [Agent 工具](/Volumes/1t/ash/ash-rs/ext/agent/src/tool.rs:54)、[接入本地工具](/Volumes/1t/ash/ash-rs/app-server/src/server/environment_runtime.rs:3042) |
| 消息板 | `board_read`、`board_write` | [消息板工具](/Volumes/1t/ash/ash-rs/ext/agent-message-board/src/tools.rs:27) |
| 历史与笔记 | `history_list/read/search`、`notes_list/read/search/write` | [扩展安装](/Volumes/1t/ash/ash-rs/ext/history-notes/src/lib.rs:35) |
| 记忆 | `memories-scopes`、`memories-search`、`memories-read`、`memories-save`，按记忆授权与扩展装配提供 | [记忆定义](/Volumes/1t/ash/ash-rs/ext/memories/src/tool.rs:263) |
| Skill、Web、图像 | `skills-read`、`web_search`、`imagegen`；Web / 图像依赖后端配置 | [Skill / Web 安装](/Volumes/1t/ash/ash-rs/app-server/src/server.rs:1293)、[图像安装](/Volumes/1t/ash/ash-rs/app-server/src/server.rs:1240) |
| 工具发现 | 有 Deferred 工具时生成 `tool_search`；工具搜索支持 BM25 / regex，混合 embedding 取决于配置 | [发现工具](/Volumes/1t/ash/ash-rs/app-server/src/tool_composition.rs:1904) |
| 大 MCP 目录 | 超过 15 个定义或本地估算 5000 token 时，改为 `search_tools` + `call_mcp_tool` 入口 | [MCP 目录处理](/Volumes/1t/ash/ash-rs/app-server/src/tool_composition/mcp_exposure.rs:35) |
| Code Mode | JavaScript 工具执行与 `ALL_TOOLS` 元数据；目录随实际启用工具生成 | [Code Mode 目录](/Volumes/1t/ash/ash-rs/code-mode-runtime/src/globals.rs:77) |

Ash 浏览器工具 **10 个名称**：

```text
browser_open       browser_observe    browser_navigate
browser_click      browser_type       browser_scroll
browser_back       browser_reload     browser_screenshot
browser_close
```

`browser_observe` 读取页面状态、可访问性树，并可包含 DOM / 截图资源；它把多个观察能力合到一个工具里。与当前 Cursor 的 16 个工具相比，Ash 这组定义没有通用 `browser_cdp`，也没有独立按键、坐标点击、select、drag、bounding box、highlight 和 browser lock 工具；与 VS Code 相比，没有 `run_playwright_code`。这里比较的是实际提供的入口，不据工具数量推算能力比例。[Ash 浏览器定义](/Volumes/1t/ash/ash-rs/app-server/src/browser_tool.rs:58)

### 3.4 VS Code + Copilot

VS Code 的 Workbench 提供共享工具服务、终端、测试、语言操作、浏览器和交互工具；Copilot 扩展提供大量搜索、编辑、Notebook 和上下文工具。双方通过工具注册与名称映射协作。[Copilot 工具加载](/Volumes/1t/vscode/extensions/copilot/src/extension/tools/node/allTools.ts)、[Workbench 工具注册](/Volumes/1t/vscode/src/vs/workbench/contrib/chat/common/tools/builtinTools/tools.ts:34)

| 所属 | 已核实的工具族 |
| --- | --- |
| Copilot 文件 / 搜索 | `read_file`、`view_image`、`list_dir`、`file_search`、`grep_search`、`semantic_search`、`search_workspace_symbols`、`read_project_structure` |
| Copilot 编辑 | `apply_patch`、`create_file`、`create_directory`、`insert_edit_into_file`、`replace_string_in_file`、`multi_replace_string_in_file` |
| Copilot 上下文 / 项目 | `get_errors`、`get_changed_files`、`test_search`、`github_repo`、`github_text_search`、`create_new_workspace` |
| Copilot Notebook | `create_new_jupyter_notebook`、`edit_notebook_file`、`run_notebook_cell`、`read_notebook_cell_output`、`copilot_getNotebookSummary` |
| Copilot 其他 | `memory`、`resolve_memory_file_uri`、`session_store_sql`、`skill`、`fetch_webpage`、`install_extension`、`get_vscode_api`、`run_vscode_command`、`switch_agent` |
| Copilot 子 Agent / 发现 | 搜索、执行专用子 Agent；模型特定 `tool_search` |
| Workbench 终端 / task | `run_in_terminal`、`get_terminal_output`、`send_to_terminal`、`kill_terminal`、选区 / 最近命令、创建 / 运行 task / task 输出 |
| Workbench 测试 / 语言 | `runTests`、`testFailure`、`vscode_renameSymbol`、`vscode_listCodeUsages` |
| Workbench 交互 / 控制 | `manage_todo_list`、`vscode_askQuestions`、`vscode_reviewPlan`、确认、`runSubagent`、任务完成、产物工具 |
| Workbench 浏览器 | `open_browser_page`、`read_page`、`screenshot_page`、`navigate_page`、`click_element`、`hover_element`、`drag_element`、`type_in_page`、`handle_dialog`、`run_playwright_code`；另有浏览器页面列表工具 |

工具名枚举也不等于实际注册全集：其中含占位名称、模型特定工具和由其他模块注册的工具。浏览器分享未开启时，注册链路只提供不读取内容的打开工具。[浏览器注册条件](/Volumes/1t/vscode/src/vs/workbench/contrib/browserView/electron-browser/tools/browserTools.contribution.ts:80)

## 4. 工具目录是否完整？

至少要分别检查五份集合：源码中的定义、当前注册的工具、当前任务授权的工具、此次模型请求的工具，以及前端展示的工具。它们不应默认相等。

| 系统 | 目录由谁形成 | 模型是否一次收到全部定义 | 影响实际可用性的条件 |
| --- | --- | --- | --- |
| Codex | core 注册链路合并扩展、MCP、动态与托管工具 | 不一定；有 Direct、Deferred、CodeModeOnly、ModelOnly、Hidden 等暴露方式 | 功能开关、模型能力、工具策略、环境、扩展与当前步骤 |
| Cursor | V2 supported tools 声明、Agent 工具装配、动态 registry 和各 MCP Provider；本机另有 Agent Host / Private Inference 运行时 | 不一定；GetMcpTools / GetDynamicTools 可用于按需发现，工具名与参数还按模型变化；本次未抓取实际模型请求 | 模型、模式、feature flags、MCP 启用 / 阻止状态、Provider gates、平台与审批 |
| Ash | App Server 合并工具来源、构造 registry，另行生成搜索入口 | 不一定；Direct / Deferred / ModelOnly / Hidden，Code Mode 也有资格过滤 | 目录授权、环境、宿主、扩展、MCP、搜索配置、当前任务 |
| VS Code + Copilot | Workbench 工具服务、扩展贡献与 Copilot 请求筛选 | 不一定；用户选择、模型特定定义、分组与延迟加载会改变集合 | tool picker、请求引用、模型匹配、实验设置、浏览器分享与扩展配置 |

来源：[Codex 暴露策略](/Volumes/1t/codex/codex-rs/core/src/tools/spec_plan.rs:235)、[Ash registry 筛选](/Volumes/1t/ash/ash-rs/tools/src/registry.rs:237)、[VS Code 请求筛选](/Volumes/1t/vscode/extensions/copilot/src/extension/tools/vscode-node/toolsService.ts:286)、[VS Code 延迟工具定义](/Volumes/1t/vscode/extensions/copilot/src/extension/tools/common/toolDeferralService.ts:14)。

### 4.1 Ash 前端当前拿到什么

前端调用 `agent/capabilities/read`，接口返回当前本地环境工具组合的能力摘要。前端逐项映射，没有在这个适配器中截断工具列表。[前端调用](/Volumes/1t/ash/app-ts/src/ash/platform/agentCapabilities/browser/agentCapabilitiesApi.ts:7)、[服务端接口](/Volumes/1t/ash/ash-rs/app-server/src/server/operations.rs:312)

| 核查项 | 当前结论 | 证据与影响 |
| --- | --- | --- |
| 名称、描述、来源、暴露方式、权限类别 | 已提供 | 前端 `AgentToolCapability` 声明这些字段 |
| 参数 schema、strict、执行 binding 等完整定义 | 未提供 | 前端接口是能力摘要，不能直接据此重建模型工具定义 |
| Hidden 工具是否能出现在目录 | 会出现 | catalog 从 collected definitions 逐项生成，并保留 Hidden 标签；出现不等于模型可调用 |
| 合成的 `tool_search` 是否同步列入前端 catalog | 当前生成链路没有同步加入 | `catalog` 来自 collected definitions；`tool_search` 之后按 Deferred 工具情况生成，并在模型 definitions 中追加 |
| 大 MCP 目录是否逐项展开 | 不一定 | 超过阈值时 MCP service 先变为 `search_tools` / `call_mcp_tool`；外层目录接收的是处理后的入口 |
| 是否代表一个特定 Thread / 模型 / 步骤的实际目录 | 不能据此认定 | 请求参数是空对象，返回本地环境快照；没有以目标任务和模型请求为筛选参数 |
| Code Mode 的 `ALL_TOOLS` 是否是后台全集 | 不是 | 从运行时 `enabled_tools` 生成；App Server 构造 Code Mode 目录时还会过滤工具资格 |

所以，**Ash 前端收到的是当前环境已组合工具的摘要；它不是所有工具的完整 schema，也不完全等于某次模型请求的实际工具目录。**

两个应进一步核查的问题是：前端是否需要同时显示 MCP 原始成员与搜索入口，以及系统生成的工具是否应与普通工具一起登记和展示。这是目录契约问题，不能用 UI 上有多少行来判断全部工具是否已经接入。

证据：[catalog 构造](/Volumes/1t/ash/ash-rs/app-server/src/tool_composition.rs:1080)、[搜索工具单独追加](/Volumes/1t/ash/ash-rs/app-server/src/tool_composition.rs:1265)、[模型目录](/Volumes/1t/ash/ash-rs/app-server/src/tool_composition.rs:1361)、[Code Mode 过滤](/Volumes/1t/ash/ash-rs/app-server/src/tool_composition.rs:1273)、[前端字段](/Volumes/1t/ash/app-ts/src/ash/platform/agentCapabilities/common/agentCapabilitiesService.ts:7)。

## 5. Ash 的差异与后续核查顺序

以下是基于工具定义和注册路径的判断，不是实现承诺或端到端验收结果。

| 顺序 | 需要核查或完善的内容 | 为什么 |
| --- | --- | --- |
| 1 | 让前端目录、模型目录、Code Mode 目录可以对照同一任务与同一版本；说明合成工具与 MCP 成员的关系 | 先回答“这一轮模型究竟能调什么”，才能准确判断工具缺失或只是未暴露 |
| 2 | 核查诊断、定义 / 引用、语义重命名、测试结果是否已有专用模型入口 | Ash 已有相关服务不代表 Agent 已能直接调用；VS Code 的工具直接使用编辑器语义和测试服务 |
| 3 | 核查通用提问工具、本地图片查看工具的接入 | MCP 交互不等同通用提问；图像生成不等同读取本地图片 |
| 4 | 核查浏览器按键、select、拖拽、坐标定位，以及 CDP / 脚本调试能力 | 当前 10 个工具覆盖基础观察与输入；Cursor 3.23.12 注册 16 个工具并提供 CDP，VS Code 提供 Playwright 执行入口 |
| 5 | 根据实际任务决定 Notebook、桌面操作、录屏是否进入产品工具范围 | 当前来源未确认 Ash 专用入口，是否建设应由产品用途决定 |

已有能力应直接作为后续工作的基础：Ash 不需要重新建设文件读写、正则搜索、长进程会话、代码检索、多 Agent、Goal、消息板或 Code Mode。需要验证的是它们在目标产品、目标模型和目标任务中是否真的被装配、发现并执行。

## 6. 本次核查与限制

- Cursor 当前结论改为直接读取本机 3.23.12 安装包；用户提供的 2.6.20 研究文档只作为历史参考，未把其中的建议、命令或规则当成本次用户指令。
- 交叉核实 Cursor 三份版本信息，提取两套协议字段，比较浏览器定义数组与调用路由，核查 computer-use 条件注册，并记录六个 bundle 的 SHA-256 指纹。
- 对照本机 Codex、Ash、VS Code / Copilot 的工具定义、注册条件、目录生成和前端接口。
- 未给四个系统做统一工具数量排名：工具合并粒度、历史协议、扩展安装和动态工具都会改变数量。
- 未运行工具调用、UI 流程或性能对照；“实现已核实”只表示静态代码证据。
- 当前 Codex 桌面会话提供的工具与 Codex core 源码、扩展及产品宿主工具分别看待；500 项运行时目录不作为四方比较的数量依据。
- 文档验证通过：65 个本地链接及行号范围、代码块闭合、尾随空白、浏览器 16 个定义与 16 个路由一致、Agent 70 个协议分支与正文清单一致、V2 55 个枚举 / 49 个参数字段、六个 bundle 的大小与 SHA-256 前缀均与本机文件一致；`git diff --check` 完成。仅修改 Markdown，未新增行为测试或运行应用构建。
