# 工具能力与范围

Ash 的工具共用一个注册体系，按**能力分类 → 具名工具集 → 产品组合 → 本轮有效范围**组织。
Workbench、Agent Window 是客户端宿主；Code、Cowork、Design 是产品能力组合。
工具在哪里执行、由谁提供、是否需要审批，是另外的维度。

这页用于审阅分类与产品边界、查找现有工具，以及给新产品选择能力。
底层定义、绑定、恢复与执行契约见[工具系统](tools.md)。

## 1. 四层分别解决什么问题

| 层                        | 回答的问题                       | 示例                         | 对权限的影响                                                   |
| ------------------------- | -------------------------------- | ---------------------------- | -------------------------------------------------------------- |
| Category：能力分类        | 这个工具主要做什么？             | `read`、`edit`、`browser`    | 只描述语义；可用于缩小已选范围，不能单独授予工具。             |
| Tool Set：具名工具集      | 哪些明确的工具成员可以一起复用？ | `core.files`、`app.sessions` | 成员由能力 owner 显式声明，可跨分类。                          |
| Product Profile：产品组合 | 这个产品允许组合哪些工具集？     | `code`、`cowork`、`design`   | 选择 Profile 后，它的已注册成员是本次选择的上限。              |
| Scope：本轮有效范围       | 本次 Turn 到底允许哪些工具？     | 文件读取与文件搜索的子集     | 接收输入时解析为允许名称列表，冻结后统一约束发现、调用和委派。 |

例如，`read_file` 属于 `read`，`edit` 属于 `edit`，但二者都由 `core.files` 复用。
同属 `read` 的外部工具不会因此加入 `core.files`，也不会自动加入 Code。

`ToolProductProfile` 是产品组合声明；`ToolProfileSnapshot` 是已有的 Turn 工具快照。
两者名字相近，但职责不同：产品组合先解析，最终范围存入快照的 `allowed_tools`。

## 2. Ash、Agent Window 与 runtime 的边界

| 边界                           | 拥有的职责                                           | 与工具的关系                                                            |
| ------------------------------ | ---------------------------------------------------- | ----------------------------------------------------------------------- |
| Ash Workbench                  | 编辑器、文档模型、终端及工作台交互                   | 提供需要客户端完成的操作；编辑器和文件状态沿用原有 owner。              |
| Agent Window                   | 会话界面、导航、侧栏与用户交互                       | 复用共享工具目录；会话持久状态仍由共享服务维护。                        |
| App Server                     | 注册能力、解析产品范围、连接共享服务与客户端         | 在 composition root 汇总工具，按已有绑定路由到能力 owner 或指定客户端。 |
| Agent runtime / Core           | Turn 生命周期、冻结快照、调度、Code Mode、Agent 委派 | 对发现与调用使用相同范围约束，动作执行继续经过权限与审批。              |
| 能力 owner                     | 文件、进程、浏览器、记忆、应用操作等具体领域         | 声明工具定义、分类、工具集成员，并实现具体操作。                        |
| Code / Cowork / Design Profile | 产品可组合的工具集                                   | 不拥有新注册表，不决定执行进程，也不替代动作授权。                      |

因此，`app.sessions` 表示“会话管理能力”，不表示“只能在 Agent Window 进程执行”。
其中有共享后端操作，也有需要 Agents 窗口完成的界面操作。
实际调用仍取决于既有客户端绑定；连接不可用时不能静默改投另一个窗口。

## 3. 当前 16 个能力分类

以下 ID 与代码中的 `ToolCategory` 序列化值一致。分类按主要用途划分，不能推导某次操作是否只读。
例如 `memory` 同时包含读取与保存，`browser` 同时包含观察与页面交互。

| ID            | 用途                         | 当前例子                                                     |
| ------------- | ---------------------------- | ------------------------------------------------------------ |
| `read`        | 读取文件与指令               | `read_file`、`read_instruction`                              |
| `edit`        | 修改文件                     | `write_file`、`edit`、`apply_patch`                          |
| `search`      | 文件、代码与工具发现         | `grep`、`glob`、`search_code`、`tool_search`、`search_tools` |
| `execute`     | 命令、进程环境与开发任务     | `shell-command`、`shell-session`、`environment`、`tasks_run` |
| `browser`     | 浏览器页面观察与交互         | `browser_open`、`browser_observe`、`browser_click`           |
| `web`         | 网络信息检索                 | `web_search`                                                 |
| `agent`       | Agent 控制、协作与转调       | `switch_mode`、`spawn_agent`、`advisor`、`call_mcp_tool`     |
| `plan`        | 计划与目标                   | `update_plan`、`get_goal`、`create_goal`、`update_goal`      |
| `workbench`   | 打开工作台内容               | `open_in_ash`                                                |
| `sessions`    | 会话管理与相关导航、侧栏操作 | `list_threads`、`read_thread`、`navigate_to_ash_page`        |
| `projects`    | 项目发现与管理能力           | 当前为 `list_projects`                                       |
| `automations` | 自动化管理                   | `automation_update`                                          |
| `app`         | 应用级操作                   | `check_app_update`、`fire_confetti`                          |
| `memory`      | 长期记忆、历史与任务笔记     | `memories-search`、`history_read`、`notes_write`             |
| `skills`      | Skill 内容访问               | `skills-read`                                                |
| `image`       | 图像生成与编辑               | `imagegen`                                                   |

未声明分类的外部工具保留未分类状态，开发者快照归入 `unclassified`。
不根据工具名称猜测其分类。选择了分类筛选时，未分类工具不会通过该筛选。

## 4. 当前 17 个具名工具集与成员

下面列的是代码中已声明的成员，并不保证当前安装、平台、连接和配置都已注册这些工具。
实际已注册成员以开发者快照为准；Profile 引用一个工具集不会安装、启用或连接它。

### 基础能力：8 组

| Tool Set         | 已声明工具                                                                                                                                                                                                                                                                                  | 能力 owner / 定义入口                                                                                                                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `core.files`     | `read_file`、`write_file`、`edit`、`apply_patch`                                                                                                                                                                                                                                            | [本地文件工具](../../crates/app-server/src/local_tools/suite.rs)、[补丁工具](../../crates/apply-patch/src/lib.rs)                                                                                                                    |
| `core.search`    | `grep`、`glob`、`search_code`                                                                                                                                                                                                                                                               | [本地搜索](../../crates/app-server/src/local_tools/suite.rs)、[代码检索](../../crates/app-server/src/codebase_retrieval_tool.rs)                                                                                                     |
| `core.execution` | `shell-command`、`shell-session`、`environment`；`tasks_list`、`tasks_run`、`tasks_status`、`tasks_output`、`tasks_cancel`                                                                                                                                                                  | [Shell](../../crates/app-server/src/local_tools.rs)、[命令会话](../../crates/app-server/src/local_tools/suite.rs)、[环境](../../crates/app-server/src/execution_environments.rs)、[开发任务](../../crates/ext/app-tools/src/tool.rs) |
| `core.browser`   | `browser_list_pages`、`browser_open`、`browser_observe`、`browser_navigate`、`browser_click`、`browser_type`、`browser_scroll`、`browser_hover`、`browser_drag`、`browser_handle_dialog`、`browser_run_playwright`、`browser_back`、`browser_reload`、`browser_screenshot`、`browser_close` | [浏览器工具](../../crates/app-server/src/browser_tool.rs)                                                                                                                                                                            |
| `core.web`       | `web_search`                                                                                                                                                                                                                                                                                | [Web Search](../../crates/ext/web-search/src/tool.rs)                                                                                                                                                                                |
| `core.memory`    | `memories-scopes`、`memories-search`、`memories-read`、`memories-save`；`history_list`、`history_read`、`history_search`、`notes_list`、`notes_read`、`notes_search`、`notes_write`                                                                                                         | [长期记忆](../../crates/ext/memories/src/tool.rs)、[历史与笔记](../../crates/ext/history-notes/src/lib.rs)                                                                                                                           |
| `core.skills`    | `skills-read`                                                                                                                                                                                                                                                                               | [Skills](../../crates/ext/skills/src/tool.rs)                                                                                                                                                                                        |
| `core.images`    | `imagegen`                                                                                                                                                                                                                                                                                  | [图像生成](../../crates/ext/image-generation/src/tool.rs)                                                                                                                                                                            |

### Agent 能力：4 组

| Tool Set              | 已声明工具                                                                                                                | 能力 owner / 定义入口                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent.control`       | `switch_mode`、`advisor`、`sleep`                                                                                         | [模式切换](../../crates/app-server/src/server/switch_mode_tool.rs)、[顾问](../../crates/ext/advisor/src/lib.rs)、[等待](../../crates/ext/sleep/src/lib.rs) |
| `agent.collaboration` | `spawn_agent`、`send_agent_message`、`wait_agent`、`team_post_message`、`team_read_messages`、`board_read`、`board_write` | [Agent 协作](../../crates/ext/agent/src/tool.rs)、[消息板](../../crates/ext/agent-message-board/src/tools.rs)                                              |
| `agent.planning`      | `update_plan`、`get_goal`、`create_goal`、`update_goal`                                                                   | [计划](../../crates/app-server/src/server/update_plan_tool.rs)、[目标](../../crates/ext/goal/src/tool.rs)                                                  |
| `agent.instructions`  | `read_instruction`                                                                                                        | [指令读取](../../crates/app-server/src/server/instruction_operations.rs)                                                                                   |

### 应用能力：5 组

这些工具由 [App Tools](../../crates/ext/app-tools/src/tool.rs) 声明能力，具体操作沿用共享后端或绑定客户端。

| Tool Set          | 已声明工具                                                                                                                                                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `app.sessions`    | `list_threads`、`read_thread`、`create_thread`、`fork_thread`、`set_thread_archived`、`navigate_to_ash_page`、`list_sidebar_sections`、`create_sidebar_section`、`rename_sidebar_section`、`delete_sidebar_section`、`move_thread_to_sidebar_section`、`reorder_section` |
| `app.projects`    | `list_projects`                                                                                                                                                                                                                                                          |
| `app.automations` | `automation_update`                                                                                                                                                                                                                                                      |
| `app.workbench`   | `open_in_ash`                                                                                                                                                                                                                                                            |
| `app.application` | `check_app_update`、`fire_confetti`                                                                                                                                                                                                                                      |

### 发现与执行入口单独处理

| 入口            | 当前职责                                    | 范围行为                                                      |
| --------------- | ------------------------------------------- | ------------------------------------------------------------- |
| `tool_search`   | 共享工具搜索，分类为 `search`               | 非空选择可自动补入；候选先按有效范围筛选，再排序。            |
| `search_tools`  | MCP 目录搜索，分类为 `search`               | 选择目录中的 MCP 目标时可补入桥接入口；搜索结果不能越过范围。 |
| `call_mcp_tool` | MCP 目标转调，分类为 `agent`                | 选择桥接入口本身不会授予其全部目标，目标调用仍单独检查。      |
| `exec`、`wait`  | Core 按 Tool Mode 注入的 Code Mode 控制工具 | 非空范围下保留执行入口，显式禁用优先；内部工具仍受范围约束。  |

这些入口不属于上面的 17 个具名工具集。`exec/wait` 由 Core 的控制目录注入，
当前不作为普通能力成员出现在 App Server 注册目录中。不能用开发者快照里是否出现它们来判断 Code Mode 是否启用。
它们也不同于进程工具 `shell-command/shell-session` 或 Agent 等待工具 `wait_agent/sleep`。

## 5. 来源、暴露与权限是独立维度

| 维度                        | 描述什么                                                            | 不应据此推导什么                                                |
| --------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------- |
| `source` / `sourceChain`    | 工具由 local、MCP、dynamic、extension、environment、host 等来源提供 | 不代表业务分类或产品授权。                                      |
| `sourceGroups`              | 同一目录快照内按来源汇总的成员                                      | 不作为产品能力工具集使用。                                      |
| `toolSets`                  | 明确声明的能力成员集合                                              | 不表示工具位于同一个进程或 provider。                           |
| `exposure`                  | direct、deferred、modelOnly、hidden 等暴露方式                      | deferred 不代表范围外；发现后加载也不能扩大范围。               |
| `authority`、动作审批、沙箱 | 某次具体操作可以访问哪些资源、能否执行                              | 已进入 Scope 仍可能因为路径、参数、用户授权或沙箱条件而被拒绝。 |

外部工具可以按已注册的精确名称选择。即使提供了分类，也不会因此自动获得具名工具集成员资格。
底层执行身份还包含来源、绑定和 generation；Scope 中的允许名称列表不替代这些身份校验。

## 6. Scope 如何计算并贯彻到调用

先计算业务工具选择，再在非空时补齐必要的发现、转调和 Code Mode 入口：

```text
已选成员 = 所选 Tool Set 的已注册成员 ∪ 显式工具名称

指定 Profile：
  没有填写 sets/tools → 使用 Profile 的已注册成员
  填写了 sets/tools   → 已选成员 ∩ Profile 的已注册成员

填写 categories → 对上一步结果继续取分类交集
未填写 categories → 不作分类筛选

本轮允许范围 = 解析后的成员及必要入口 − disabled
当前 Agent 可调用范围 = 本轮允许范围 ∩ Agent 自身能力上限
当前 Agent 可委派范围 = 本轮允许范围 ∩ Agent 委派能力上限
```

根 Agent 没有额外 Agent 上限时，使用本轮范围。
Agent 自身能力与委派能力是两份不同上限：能委派的工具不一定能亲自调用。
Code Mode 控制入口遵守自身的启用规则，不能让空范围获得工具能力。

| 检查点       | 统一范围如何生效                                                             |
| ------------ | ---------------------------------------------------------------------------- |
| Turn 接收    | App Server 解析选择，Core 冻结 `allowed_tools`；禁用项继续保存。             |
| 模型工具目录 | 直接工具和后续加载的工具都按冻结范围过滤。                                   |
| Tool Search  | BM25、正则、语义搜索都先过滤候选；范围外文档不参与本次语义检索的嵌入与排名。 |
| 直接调用     | 调度准备与执行前检查范围，猜到名称不能绕过。                                 |
| MCP 转调     | 搜索与实际目标调用都检查范围，桥接入口不授予额外目标。                       |
| Code Mode    | 嵌套目录和嵌套调用沿用同一范围；`exec/wait` 准备与执行也检查范围。           |
| 子 Agent     | 工具选择与协调器创建入口都受父 Turn 范围约束，继续委派也不能放大。           |
| Steering     | 不能改变已接受 Turn 的选择；改变范围需要新 Turn。                            |

### 使用示例

**Code 产品中的文件读取与文件搜索。** `core.files` 原本包含修改工具，分类筛选会将它们排除。

```json
{
  "type": "toolSelection",
  "disabled": [],
  "scope": {
    "profile": "code",
    "sets": ["core.files", "core.search"],
    "categories": ["read", "search"]
  }
}
```

业务成员为 `read_file`、`grep`、`glob`，以及已注册时的 `search_code`；必要的搜索入口可自动补入。
这只能限制可调用工具，不能替代文件授权和沙箱。

**使用 Code 的完整已注册组合。**

```json
{ "type": "toolSelection", "disabled": [], "scope": { "profile": "code" } }
```

**明确不给工具。**

```json
{ "type": "toolSelection", "disabled": [], "scope": {} }
```

**只选若干工具。** 不指定 Profile 时，也能独立组合已注册的工具集或精确名称。
选择外部工具时，从实际目录取得名称，不能根据 UI 显示名猜名称。

```json
{ "type": "toolSelection", "disabled": [], "scope": { "tools": ["read_file", "glob"] } }
```

| 输入情况                                    | 当前结果                                                            |
| ------------------------------------------- | ------------------------------------------------------------------- |
| 完全省略 `scope`                            | 兼容原有宿主目录，不新增正向允许列表；不是默认选中 `code` Profile。 |
| `scope: {}`                                 | 生成空允许列表，搜索、调用、Code Mode 都不能借此获得工具。          |
| 只填 `categories`，没有 Profile、集合或名称 | 空范围；分类本身不授予工具。                                        |
| 已注册工具被 Profile 排除                   | 取交集后仍不可用，即使显式写入名称也不会越过 Profile。              |
| 未知工具、工具集或 Profile                  | 返回输入错误，避免拼写错误被静默忽略。                              |
| 选择 `cowork` 或 `design`                   | 返回 planned、能力未就绪；不会退回 Code。                           |

Scope 目前通过 Turn 输入提供，没有新增普通设置项或产品 Profile 选择器。
完整字段、序列化及校验由[共享类型](../../crates/protocol/src/turn/tool_profile.rs)和
[Turn 输入协议](../../crates/app-server-protocol/src/protocol/turn.rs)维护。

## 7. Code、Cowork、Design 的组合状态

| Profile  | 状态      | 当前组合         | 使用行为                                       |
| -------- | --------- | ---------------- | ---------------------------------------------- |
| `code`   | `ready`   | 本页 17 个工具集 | 仅纳入其中实际已注册的成员，之后仍可缩小范围。 |
| `cowork` | `planned` | 空               | 有声明、无可用能力，选择会报错。               |
| `design` | `planned` | 空               | 有声明、无可用能力，选择会报错。               |

Cowork、Design 当前只有产品声明占位，尚未实现它们的专属工具、工具集或默认组合。
已有 Cowork / Design 界面不代表这些 Profile 已投入使用。

后续接入时，先为实际能力定义工具和明确成员的具名工具集，再在产品 Profile 中组合需要的集合，
并由产品提交相应 Scope。文档中的未来集合名不应先作为已注册集合使用。
复用 `core.files` 或 `core.browser` 必须是显式产品决定；新产品不会继承 Code 的 Shell、文件修改或应用管理能力。

## 8. 普通用户与开发者如何查看

普通 Workbench 与 Agent Window 设置页暂不显示完整工具清单。
用户仍通过已有权限、沙箱、连接与扩展入口管理对应行为。
能力分类先服务于内部组合和范围控制，不直接变成每个工具一个开关。

开发者在**命令面板**运行：

- 中文：**开发者：查看 Agent 工具目录**
- 英文：**Developer: Show Agent Tool Catalog**
- 命令 ID：`workbench.action.chat.showToolCatalog`

该入口在正式版本中也可用，不要求开发构建。它打开只读 JSON 快照，包含：

| 内容         | 用途                                                                         |
| ------------ | ---------------------------------------------------------------------------- |
| `profiles`   | 产品声明、ready/planned 状态及所选集合。                                     |
| `categories` | 按能力分类分组的工具，保留来源、暴露方式和授权类型等元数据。                 |
| `toolSets`   | 工具集及成员；`kind: source` 表示来源分组，`kind: capability` 表示能力集合。 |
| `note`       | 提醒快照是注册目录，具体 Turn 可能有更小范围。                               |

每次运行读取新目录并打开独立快照。它不允许编辑配置，也不展示某个 Turn 的完整实时权限与拒绝原因。
未来若增加范围诊断，应基于真实 Turn 快照展示，不从注册目录推断“当前可调用”。

## 9. 实现与验证入口

| 内容                               | 代码入口                                                                                                                                                                                        |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 分类、集合、产品声明及冻结范围类型 | [共享工具范围契约](../../crates/protocol/src/turn/tool_profile.rs)                                                                                                                              |
| 产品组合、集合汇总与 Scope 解析    | [App Server composition](../../crates/app-server/src/tool_composition.rs)                                                                                                                       |
| Turn 输入转换与目录 RPC            | [App Server operations](../../crates/app-server/src/server/operations.rs)                                                                                                                       |
| 当前调用与委派能力判断             | [ToolExecutionFacts](../../crates/core/src/services.rs)                                                                                                                                         |
| 准备与执行前检查                   | [ToolScheduler](../../crates/core/src/turn/tool_scheduler.rs)、[ToolExecution](../../crates/core/src/turn/tool_execution.rs)                                                                    |
| 子 Agent 创建边界                  | [MultiAgentCoordinator](../../crates/core/src/multi_agent/coordinator.rs)                                                                                                                       |
| 搜索候选过滤                       | [BM25 / 正则](../../crates/tools/src/registry/search.rs)、[语义搜索](../../crates/app-server/src/tool_search_embedding.rs)、[MCP](../../crates/app-server/src/tool_composition/mcp_exposure.rs) |
| Code Mode 控制与嵌套目录           | [控制目录](../../crates/core/src/turn/code_mode/catalog.rs)、[Broker](../../crates/core/src/turn/code_mode/broker.rs)                                                                           |
| 开发者目录命令                     | [Preferences Actions](../../src/ash/workbench/contrib/preferences/browser/preferencesActions.ts)                                                                                                |

本轮共享 Core、协议、搜索库、App Tools 与相关前端回归已通过。完整 App Server 的组合与 MCP 回归
仍未执行：其构建被既有文件权限接口错误阻塞，位置在
[应用操作](../../crates/app-server/src/server/app_tools_operations.rs)和
[IDE 操作](../../crates/app-server/src/server/ide_operations.rs)。这限制了整条 App Server 链路的验证结论。
