# Ash 完整工具目录

核对日期：2026-10-14；工具名称、用途和执行条件以当前本地源码为基准。
本文按已确定的目标方案列出 **26 个 ToolSet、86 个不同固定工具名称**，全部固定工具都有明确集合归属。
另列 1 个未找到产品装配入口的库工具；MCP、外部扩展和客户端 dynamic 工具按实际运行时目录枚举。

所有目标 ToolSet ID 统一使用小写字母与下划线组成的无前缀业务名称，不再维护独立分类列。
基础清单每个工具列一次，真实组合可以显式复用成员；来源、执行位置、宿主条件与启用策略分别维护。

**这是待实现的目标分组，不是当前协议已接受的集合 ID。** 当前代码仍有 17 个带前缀旧集合、76 个集合成员；
五个已有产品工具缺少集合元数据，另五个发现、转调与 Code Mode 入口尚未统一归组。
命名、成员、旧输入和运行时目录的迁移见[当前实现与迁移边界](tools.md#67-当前实现与迁移边界)。本次只改文档。

## ToolSet 总表

| ToolSet          | 数量 | 完整工具成员                                                                                                                                                                                                                                                                                |
| ---------------- | ---: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `files`          |    4 | `read_file`、`write_file`、`edit`、`apply_patch`                                                                                                                                                                                                                                            |
| `search`         |    3 | `grep`、`glob`、`search_code`                                                                                                                                                                                                                                                               |
| `execution`      |    3 | `shell-command`、`shell-session`、`environment`                                                                                                                                                                                                                                             |
| `tasks`          |    5 | `tasks_list`、`tasks_run`、`tasks_status`、`tasks_output`、`tasks_cancel`                                                                                                                                                                                                                   |
| `browser`        |   15 | `browser_list_pages`、`browser_open`、`browser_observe`、`browser_navigate`、`browser_click`、`browser_type`、`browser_scroll`、`browser_hover`、`browser_drag`、`browser_handle_dialog`、`browser_run_playwright`、`browser_back`、`browser_reload`、`browser_screenshot`、`browser_close` |
| `web`            |    1 | `web_search`                                                                                                                                                                                                                                                                                |
| `images`         |    1 | `imagegen`                                                                                                                                                                                                                                                                                  |
| `memory`         |    4 | `memories-scopes`、`memories-search`、`memories-read`、`memories-save`                                                                                                                                                                                                                      |
| `history`        |    3 | `history_list`、`history_read`、`history_search`                                                                                                                                                                                                                                            |
| `notes`          |    4 | `notes_list`、`notes_read`、`notes_search`、`notes_write`                                                                                                                                                                                                                                   |
| `skills`         |    1 | `skills-read`                                                                                                                                                                                                                                                                               |
| `instructions`   |    1 | `read_instruction`                                                                                                                                                                                                                                                                          |
| `modes`          |    1 | `switch_mode`                                                                                                                                                                                                                                                                               |
| `consultation`   |    1 | `advisor`                                                                                                                                                                                                                                                                                   |
| `waiting`        |    1 | `sleep`                                                                                                                                                                                                                                                                                     |
| `planning`       |    4 | `update_plan`、`get_goal`、`create_goal`、`update_goal`                                                                                                                                                                                                                                     |
| `collaboration`  |    7 | `spawn_agent`、`send_agent_message`、`wait_agent`、`team_post_message`、`team_read_messages`、`board_read`、`board_write`                                                                                                                                                                   |
| `permissions`    |    1 | `request_permissions`                                                                                                                                                                                                                                                                       |
| `sessions`       |   12 | `list_threads`、`read_thread`、`create_thread`、`fork_thread`、`set_thread_archived`、`navigate_to_ash_page`、`list_sidebar_sections`、`create_sidebar_section`、`rename_sidebar_section`、`delete_sidebar_section`、`move_thread_to_sidebar_section`、`reorder_section`                    |
| `projects`       |    1 | `list_projects`                                                                                                                                                                                                                                                                             |
| `automations`    |    1 | `automation_update`                                                                                                                                                                                                                                                                         |
| `workbench`      |    1 | `open_in_ash`                                                                                                                                                                                                                                                                               |
| `application`    |    2 | `check_app_update`、`fire_confetti`                                                                                                                                                                                                                                                         |
| `remote_tasks`   |    4 | `remote_task_targets`、`remote_task_list`、`remote_task_send`、`remote_task_read`                                                                                                                                                                                                           |
| `tool_discovery` |    3 | `tool_search`、`search_tools`、`call_mcp_tool`                                                                                                                                                                                                                                              |
| `code_mode`      |    2 | `exec`、`wait`                                                                                                                                                                                                                                                                              |

总计 26 个集合、86 个不同固定工具。集合数随真实能力发展，不作为封闭分类或必须满足的数量。
默认／可选组合、启用条件与范围约束统一维护在[工具系统](tools.md#默认启用与可选组合)。
下文保留每个工具的用途、定义入口、执行归属和关键条件；完整参数 schema 以链接的定义为准。
注册、选择或加载某个集合不代表具体操作已经获批，最终暴露方式和嵌套资格仍需单独检查。

## 各 ToolSet 的工具详情

### 1. 文件（4）

ToolSet：`files`（目标）。

定义：[本地文件工具](../../crates/app-server/src/local_tools/suite.rs)、[补丁](../../crates/apply-patch/src/lib.rs)。
文件工具需要访问客户端文档时复用 TextDocumentEditorProvider；dirty buffer、撤销和编辑事务仍由编辑器拥有。

| 工具          | 用途／主要操作                       | ToolSet（目标） | 执行归属与条件                                   |
| ------------- | ------------------------------------ | --------------- | ------------------------------------------------ |
| `read_file`   | 按行读取文本文件；支持 offset、limit | `files`         | 文件服务；授权目录；二进制文件不通过该入口读取   |
| `write_file`  | 创建或完整覆盖文件                   | `files`         | 文件服务；覆盖前需已读；接入编辑器时沿用文档事务 |
| `edit`        | 唯一匹配或全部匹配的精确字符串替换   | `files`         | 文件服务／文档适配；已读内容、匹配和写权限校验   |
| `apply_patch` | 以补丁创建、修改、删除或移动文件     | `files`         | 补丁执行器；受授权路径及适用的文档编辑契约约束   |

### 2. 搜索（3）

ToolSet：`search`（目标）。

定义：[本地搜索工具](../../crates/app-server/src/local_tools/suite.rs)、[代码检索](../../crates/app-server/src/codebase_retrieval_tool.rs)。

| 工具          | 用途／主要操作                   | ToolSet（目标） | 执行归属与条件                                    |
| ------------- | -------------------------------- | --------------- | ------------------------------------------------- |
| `grep`        | 在授权路径按正则搜索文件内容     | `search`        | 文本搜索服务；支持 glob、路径及大小写筛选         |
| `glob`        | 按 glob 查找文件路径             | `search`        | 文件搜索服务；在授权目录中返回有界结果            |
| `search_code` | 按自然语言／符号检索索引代码片段 | `search`        | Codebase 服务；依赖已装配索引；可报告语义检索降级 |

### 3. 命令与进程（3）

ToolSet：`execution`（目标）。

定义：[Shell](../../crates/shell-command/src/lib.rs)、[执行环境](../../crates/app-server/src/execution_environments.rs)。
目标成员仅为以下三个工具；工作台 Tasks 独立选择，不随本集合启用。

| 工具            | 用途／主要操作                                                   | ToolSet（目标） | 执行归属与条件                                                |
| --------------- | ---------------------------------------------------------------- | --------------- | ------------------------------------------------------------- |
| `shell-command` | 执行一次命令并返回结果                                           | `execution`     | 选定执行环境的进程服务；工作目录、动作策略和沙箱              |
| `shell-session` | 启动、读取、等待、输入、关闭输入、打断、调整终端大小、终止长命令 | `execution`     | 进程会话服务；绑定 Session、Thread、Environment 和 session_id |
| `environment`   | 在指定环境执行 command、read、write                              | `execution`     | 配置并装配的执行环境；资源和具体动作仍单独授权                |

### 4. 工作台 Tasks（5）

ToolSet：`tasks`（目标）。

定义：[App Tools](../../crates/ext/app-tools/src/tool.rs)；路由：
[App Host 操作](../../crates/app-server/src/server/request_processors/app_tools.rs)。
这些工具调用发起窗口的现有 TaskService，运行记录不属于任意其他窗口。

这是待实现的独立集合。当前代码把五个工具放在旧执行集合；迁移后使用 `tasks`，按发起客户端实际提供的 Tasks 能力装配。Code 默认及显式选择规则见[默认启用与可选组合](tools.md#默认启用与可选组合)。

| 工具           | 用途／主要操作                                         | ToolSet（目标） | 执行归属与条件                                                     |
| -------------- | ------------------------------------------------------ | --------------- | ------------------------------------------------------------------ |
| `tasks_list`   | 列出现有任务、配置 revision、不可用原因及保留的 Run ID | `tasks`         | 客户端 Tasks；绝对工作区路径和有效窗口绑定                         |
| `tasks_run`    | 用精确 task_id、revision 启动已有任务                  | `tasks`         | 客户端 TaskService／开发终端；不创建任务；使用审阅后的任务执行授权 |
| `tasks_status` | 读取 Run ID 的状态；区分 background ready 与退出       | `tasks`         | 原窗口的保留记录；记录有时效与数量限制                             |
| `tasks_output` | 按 cursor 分页读取某次运行的输出                       | `tasks`         | 原运行记录；UTF-16 cursor；报告截断造成的缺口                      |
| `tasks_cancel` | 取消运行并释放其执行与依赖                             | `tasks`         | 原窗口 TaskService；重复取消和完成后取消是安全操作                 |

### 5. 浏览器（15）

ToolSet：`browser`（目标）。

定义：[BrowserToolService](../../crates/app-server/src/browser_tool.rs)。
浏览器领域服务拥有 target 和授权，实际交互由绑定的浏览器宿主执行；已有工具名不表示无窗口环境也具备浏览器。

| 工具                     | 用途／主要操作                                | ToolSet（目标） | 执行归属与条件                                            |
| ------------------------ | --------------------------------------------- | --------------- | --------------------------------------------------------- |
| `browser_list_pages`     | 列出当前任务拥有或被明确共享的页面            | `browser`       | 浏览器领域服务；按任务所有权筛选                          |
| `browser_open`           | 打开隔离的嵌入式页面并返回稳定 target ID      | `browser`       | 浏览器宿主；URL 与目标创建授权                            |
| `browser_observe`        | 读取页面状态、无障碍树及可选 DOM／截图资源    | `browser`       | 已授权 target；结果供后续交互定位                         |
| `browser_navigate`       | 将现有页面导航到 URL                          | `browser`       | 精确 target；目标 URL 授权                                |
| `browser_click`          | 点击最近观察中的 backend DOM node             | `browser`       | 精确 target 和观察所得 node ID                            |
| `browser_type`           | 聚焦可选 node 并输入文本                      | `browser`       | 精确 target；输入属于页面交互                             |
| `browser_scroll`         | 按 CSS 像素滚动页面                           | `browser`       | 精确 target                                               |
| `browser_hover`          | 悬停在已观察的 node                           | `browser`       | 精确 target 和 node ID                                    |
| `browser_drag`           | 在两个已观察的 node 之间拖动                  | `browser`       | 精确 target、源和目标 node ID                             |
| `browser_handle_dialog`  | 接受／拒绝 JavaScript 对话框，可填写 prompt   | `browser`       | 精确 target 的当前对话框                                  |
| `browser_run_playwright` | 用受限 page facade 执行 JavaScript 和页面交互 | `browser`       | 页面隔离世界；有时间上限；不提供 Node、文件或其他页面访问 |
| `browser_back`           | 返回页面历史记录                              | `browser`       | 精确 target 和导航授权                                    |
| `browser_reload`         | 重新加载页面                                  | `browser`       | 精确 target                                               |
| `browser_screenshot`     | 截图并返回 PNG 资源                           | `browser`       | 精确 target；资源由 App Server 返回                       |
| `browser_close`          | 关闭一个页面并释放宿主所有权                  | `browser`       | 精确 target；不关闭任意其他页面                           |

### 6. 网络搜索（1）

ToolSet：`web`（目标）。

定义：[Web Search](../../crates/ext/web-search/src/tool.rs)。
工具需要宿主安装 backend 并声明网络范围／凭据引用；接口实现不等于当前实例已配置服务商。

| 工具         | 用途／主要操作 | ToolSet（目标） | 执行归属与条件                                                  |
| ------------ | -------------- | --------------- | --------------------------------------------------------------- |
| `web_search` | 检索网络信息   | `web`           | 注入的 WebSearchBackend；需实际安装贡献并声明网络范围／凭据引用 |

### 7. 图像（1）

ToolSet：`images`（目标）。

定义：[图像生成](../../crates/ext/image-generation/src/tool.rs)。
工具仅在提供 backend 与产物目录后安装；接口实现不等于当前实例已配置服务商。

| 工具       | 用途／主要操作                             | ToolSet（目标） | 执行归属与条件                                                      |
| ---------- | ------------------------------------------ | --------------- | ------------------------------------------------------------------- |
| `imagegen` | 按 prompt 生成图片，或编辑最多五张引用图片 | `images`        | 配置的图像 backend 与产物存储；引用来自当前 Thread 附件或该工具产物 |

### 8. 长期记忆（4）

ToolSet：`memory`（目标）。

定义：[Memories](../../crates/ext/memories/src/tool.rs)。
长期记忆按用户同意的 scope 访问；读取与保存仍分别检查同意状态、revision 和删除状态。

| 工具              | 用途／主要操作                        | ToolSet（目标） | 执行归属与条件                                                        |
| ----------------- | ------------------------------------- | --------------- | --------------------------------------------------------------------- |
| `memories-scopes` | 列出当前任务记忆 scope 与读写同意状态 | `memory`        | Memory 服务；scope ID 自身不授予权限                                  |
| `memories-search` | 在已授权、已启用 scope 中搜索记忆     | `memory`        | Memory 服务；返回有界摘录和精确引用                                   |
| `memories-read`   | 按引用读取完整记忆 revision           | `memory`        | 重新检查同意状态、范围、revision 和删除状态                           |
| `memories-save`   | 创建或合并持久记忆                    | `memory`        | 需 modelWrite 同意；合并前读取；expected_revision；不覆盖用户编辑记忆 |

### 9. 会话历史（3）

ToolSet：`history`（目标）。

定义：[History tools](../../crates/ext/history-notes/src/tool.rs)；[注册](../../crates/ext/history-notes/src/lib.rs)。
仅访问当前授权 Thread 的会话历史，不因启用本组取得长期记忆或任务笔记权限。

| 工具             | 用途／主要操作                  | ToolSet（目标） | 执行归属与条件                  |
| ---------------- | ------------------------------- | --------------- | ------------------------------- |
| `history_list`   | 分页列出当前 Thread 的历史条目  | `history`       | 现有 Thread store；授权身份绑定 |
| `history_read`   | 按 item_id、offset 读取历史条目 | `history`       | 当前 Thread；有界字符分页       |
| `history_search` | 搜索当前 Thread 的历史          | `history`       | 当前 Thread 的历史检索          |

### 10. 任务笔记（4）

ToolSet：`notes`（目标）。

定义：[Notes tools](../../crates/ext/history-notes/src/tool.rs)；[注册](../../crates/ext/history-notes/src/lib.rs)。
任务笔记由当前 Thread 的 NotesStore 管理；虚拟路径与版本条件不授予任意磁盘写入。

| 工具           | 用途／主要操作              | ToolSet（目标） | 执行归属与条件                                         |
| -------------- | --------------------------- | --------------- | ------------------------------------------------------ |
| `notes_list`   | 列出当前 Thread 的任务笔记  | `notes`         | NotesStore；虚拟相对路径                               |
| `notes_read`   | 按路径、offset 读取任务笔记 | `notes`         | 当前 Thread 的笔记；有界字符分页                       |
| `notes_search` | 搜索任务笔记                | `notes`         | 当前 Thread 的 NotesStore                              |
| `notes_write`  | 创建或更新任务笔记          | `notes`         | 先读后改；expected_revision=0 创建；不写入任意磁盘路径 |

### 11. Skills（1）

ToolSet：`skills`（目标）。

定义：[Skill reader](../../crates/ext/skills/src/tool.rs)。

| 工具          | 用途／主要操作          | ToolSet（目标） | 执行归属与条件                                |
| ------------- | ----------------------- | --------------- | --------------------------------------------- |
| `skills-read` | 读取已发现 Skill 的内容 | `skills`        | Skill runtime；使用目录中的精确身份／资源引用 |

### 12. 指令（1）

ToolSet：`instructions`（目标）。

定义：[Instruction reader](../../crates/app-server/src/server/request_processors/instructions.rs)。

| 工具               | 用途／主要操作               | ToolSet（目标） | 执行归属与条件                                                          |
| ------------------ | ---------------------------- | --------------- | ----------------------------------------------------------------------- |
| `read_instruction` | 读取当前指令目录中的完整文件 | `instructions`  | 指令目录 owner；只接受目录或 preflight 返回的精确路径，不是通用文件读取 |

### 13. 模式切换（1）

ToolSet：`modes`（目标）。

定义：[模式切换](../../crates/app-server/src/server/switch_mode_tool.rs)。
只改变工作方式；离开 Plan／Ask 的确认、Turn 状态与权限上限继续按原契约处理。

| 工具          | 用途／主要操作                                 | ToolSet（目标） | 执行归属与条件                                                                      |
| ------------- | ---------------------------------------------- | --------------- | ----------------------------------------------------------------------------------- |
| `switch_mode` | 在 agent、plan、debug、multitask、ask 之间切换 | `modes`         | ThreadController；离开 plan／ask 进入执行模式需工具内用户决策；不扩大工具或角色上限 |

### 14. 顾问咨询（1）

ToolSet：`consultation`（目标）。

定义：[顾问](../../crates/ext/advisor/src/lib.rs)。
依赖已配置的顾问模型，并保留成本与每 Turn 次数限制；咨询不转交当前任务所有权。

| 工具      | 用途／主要操作                     | ToolSet（目标） | 执行归属与条件                                               |
| --------- | ---------------------------------- | --------------- | ------------------------------------------------------------ |
| `advisor` | 向配置的顾问请求战略指导与第二意见 | `consultation`  | 顾问模型服务；有独立成本和每 Turn 次数限制；不转交任务所有权 |

### 15. 执行等待（1）

ToolSet：`waiting`（目标）。

定义：[等待](../../crates/ext/sleep/src/lib.rs)。
当前执行内的有界等待，遵循取消与 deadline；不代替自动化或持久化调度。

| 工具    | 用途／主要操作                 | ToolSet（目标） | 执行归属与条件                                              |
| ------- | ------------------------------ | --------------- | ----------------------------------------------------------- |
| `sleep` | 等待 duration_ms，最长 12 小时 | `waiting`       | 当前执行；Turn 取消结束等待；不跨进程重启，不代替自动化调度 |

### 16. 计划与目标（4）

ToolSet：`planning`（目标）。

定义：[计划](../../crates/app-server/src/server/update_plan_tool.rs)、[目标](../../crates/ext/goal/src/tool.rs)。

| 工具          | 用途／主要操作                    | ToolSet（目标） | 执行归属与条件                                            |
| ------------- | --------------------------------- | --------------- | --------------------------------------------------------- |
| `update_plan` | 维护持久计划与步骤状态            | `planning`      | 当前 Thread／Turn；步骤为 pending、in_progress、completed |
| `get_goal`    | 读取当前目标与进度／预算状态      | `planning`      | 当前 Thread 的 Goal runtime                               |
| `create_goal` | 创建具体目标，可指定 token budget | `planning`      | Goal runtime；需满足现有目标生命周期条件                  |
| `update_goal` | 将目标标记为 complete 或 blocked  | `planning`      | Goal runtime；按目标状态契约校验，不是任意改写目标        |

### 17. Agent 协作（7）

ToolSet：`collaboration`（目标）。

定义：[协作工具](../../crates/ext/agent/src/tool.rs)、
[消息板](../../crates/ext/agent-message-board/src/tools.rs)。
创建供用户管理的新任务使用 `create_thread`；创建协作子 Agent 使用 `spawn_agent`，生命周期不同。

| 工具                 | 用途／主要操作                           | ToolSet（目标） | 执行归属与条件                                                                 |
| -------------------- | ---------------------------------------- | --------------- | ------------------------------------------------------------------------------ |
| `spawn_agent`        | 创建协作子 Agent 并指定任务及受限能力    | `collaboration` | MultiAgentCoordinator；父 Turn 与委派能力上限；子 Agent 自身／继续委派上限分开 |
| `send_agent_message` | 向目标 Agent 发送消息                    | `collaboration` | 协作服务；校验目标身份和协作关系                                               |
| `wait_agent`         | 等待目标 Agent 的进展／结果              | `collaboration` | 协作服务；等待条件和取消，不是进程等待                                         |
| `team_post_message`  | 向团队共享消息流发布消息                 | `collaboration` | Team 服务；需要可用团队上下文和权限                                            |
| `team_read_messages` | 读取团队消息                             | `collaboration` | Team 服务；团队身份与读取范围                                                  |
| `board_read`         | 读取频道、主题、消息、未读通知或单条正文 | `collaboration` | 当前 Agent 树的消息板；cursor／offset 分页                                     |
| `board_write`        | 创建频道、发帖／回复、变更订阅、确认已读 | `collaboration` | 消息板 owner；消息不会自动启动空闲 Agent，也不改变权限与验收状态               |

### 18. 权限请求（1）

ToolSet：`permissions`（目标）。

定义：[临时权限请求](../../crates/app-server/src/local_tools/permission_requests.rs)。
`request_permissions` 目前由本地工具装配，代码仍未声明 ToolSet，指定当前 Code Profile 会排除它。目标集合不迁移其业务 owner；交互式 Code 默认、宿主条件与显式范围规则见[默认启用与可选组合](tools.md#默认启用与可选组合)。

| 工具                  | 用途／主要操作                                           | ToolSet（目标） | 执行归属与条件                                                       |
| --------------------- | -------------------------------------------------------- | --------------- | -------------------------------------------------------------------- |
| `request_permissions` | 向用户请求本 Turn／Session 的临时目录能力或精确网络 host | `permissions`   | 权限交互与 grant owner；用户可部分批准；现有策略上限不变；集合待实现 |

### 19. 会话与侧栏（12）

ToolSet：`sessions`（目标）。

定义：[App Tools](../../crates/ext/app-tools/src/tool.rs)；执行分发：[共享服务与窗口路由](../../crates/app-server/src/server/request_processors/app_tools.rs)。
共享会话业务由后端服务持有，导航和侧栏行为通过精确客户端绑定执行。

| 工具                             | 用途／主要操作                                    | ToolSet（目标） | 执行归属与条件                                           |
| -------------------------------- | ------------------------------------------------- | --------------- | -------------------------------------------------------- |
| `list_threads`                   | 列出任务及稳定 Session／Thread ID，可包含归档任务 | `sessions`      | 共享会话服务                                             |
| `read_thread`                    | 读取指定任务                                      | `sessions`      | 共享会话服务；精确 Session／Thread ID                    |
| `create_thread`                  | 创建独立的空任务；不发送 prompt                   | `sessions`      | 共享会话服务；工具说明要求用户明确请求新任务             |
| `fork_thread`                    | 从选定任务创建独立分支任务                        | `sessions`      | 共享会话服务；精确来源身份及用户请求                     |
| `set_thread_archived`            | 归档或恢复任务                                    | `sessions`      | 共享会话服务；归档停止运行工作；不可归档执行本调用的任务 |
| `navigate_to_ash_page`           | 在调用方 Agents 窗口打开任务                      | `sessions`      | 发起窗口；Session／Thread ID；有效客户端连接             |
| `list_sidebar_sections`          | 读取侧栏分组及任务归属                            | `sessions`      | 发起 Agents 窗口的 Sessions 服务                         |
| `create_sidebar_section`         | 创建命名分组                                      | `sessions`      | 发起 Agents 窗口的 Sessions 服务                         |
| `rename_sidebar_section`         | 按 section ID 重命名分组                          | `sessions`      | 发起 Agents 窗口的 Sessions 服务                         |
| `delete_sidebar_section`         | 删除分组并将任务放回未分组列表                    | `sessions`      | 发起 Agents 窗口；不删除任务                             |
| `move_thread_to_sidebar_section` | 移动任务到分组或移回未分组                        | `sessions`      | 发起 Agents 窗口；Session ID 与可空 section ID           |
| `reorder_section`                | 重排一个分组内全部任务                            | `sessions`      | 发起 Agents 窗口；每个成员 Session ID 恰好出现一次       |

### 20. 项目（1）

ToolSet：`projects`（目标）。

定义：[App Tools](../../crates/ext/app-tools/src/tool.rs)；执行分发：[共享服务与窗口路由](../../crates/app-server/src/server/request_processors/app_tools.rs)。
项目数据由共享项目服务持有。

| 工具            | 用途／主要操作 | ToolSet（目标） | 执行归属与条件 |
| --------------- | -------------- | --------------- | -------------- |
| `list_projects` | 列出项目       | `projects`      | 共享项目服务   |

### 21. 自动化（1）

ToolSet：`automations`（目标）。

定义：[App Tools](../../crates/ext/app-tools/src/tool.rs)；执行分发：[共享服务与窗口路由](../../crates/app-server/src/server/request_processors/app_tools.rs)。
自动化状态由共享服务持有；动作副作用和授权按具体操作裁决。

| 工具                | 用途／主要操作                            | ToolSet（目标） | 执行归属与条件                                                     |
| ------------------- | ----------------------------------------- | --------------- | ------------------------------------------------------------------ |
| `automation_update` | list、view、save、delete、run、runs、stop | `automations`   | 共享自动化服务；修改使用 expected_revision；运行和停止有独立副作用 |

### 22. 工作台展示（1）

ToolSet：`workbench`（目标）。

定义：[App Tools](../../crates/ext/app-tools/src/tool.rs)；执行分发：[共享服务与窗口路由](../../crates/app-server/src/server/request_processors/app_tools.rs)。
展示操作绑定本轮选定 IDE 或发起窗口，不取得被展示资源的读取或执行权限。

| 工具          | 用途／主要操作                         | ToolSet（目标） | 执行归属与条件                                                  |
| ------------- | -------------------------------------- | --------------- | --------------------------------------------------------------- |
| `open_in_ash` | 打开 file、browser、terminal 或 review | `workbench`     | file／review 优先使用本轮选定 IDE；其余使用发起窗口；只打开界面 |

### 23. 应用操作（2）

ToolSet：`application`（目标）。

定义：[App Tools](../../crates/ext/app-tools/src/tool.rs)；执行分发：[共享服务与窗口路由](../../crates/app-server/src/server/request_processors/app_tools.rs)。
按发起客户端的实际应用能力提供。

| 工具               | 用途／主要操作         | ToolSet（目标） | 执行归属与条件                                             |
| ------------------ | ---------------------- | --------------- | ---------------------------------------------------------- |
| `check_app_update` | 检查当前安装版本的更新 | `application`   | 发起客户端的桌面更新能力；不下载、安装或重启               |
| `fire_confetti`    | 在调用窗口播放庆祝效果 | `application`   | 发起窗口；遵循减少动态效果设置；工具说明限定用户邀请的庆祝 |

### 24. 远程独立任务（4）

ToolSet：`remote_tasks`（目标）。

定义与注册：[Task delivery tools](../../crates/app-server/src/task_delivery_host.rs)；装配：[App Server](../../crates/app-server/src/server.rs)与[本地运行时](../../crates/app-server/src/local.rs)。
需要 task-delivery runtime。目标集合为 `remote_tasks`；代码仍未声明集合，指定当前 Code Profile 会排除它们。默认关闭及按需组合规则见[默认启用与可选组合](tools.md#默认启用与可选组合)。

| 工具                  | 用途／主要操作                                   | ToolSet（目标） | 执行归属与条件                                                                           |
| --------------------- | ------------------------------------------------ | --------------- | ---------------------------------------------------------------------------------------- |
| `remote_task_targets` | 列出保存的 SSH 目的地及 runtime 配置状态         | `remote_tasks`  | 来源机器的远程连接／任务投递服务                                                         |
| `remote_task_list`    | 列出来源 Thread 最近的 50 条已保存投递关系       | `remote_tasks`  | 本地投递存储；不连接远端；用于恢复 delivery_id                                           |
| `remote_task_send`    | 将独立任务及代码快照投递到保存的 SSH 机器        | `remote_tasks`  | Task delivery／SSH；需用户指示委派到该机器；传输 Git HEAD 与磁盘树，不含未保存编辑器内容 |
| `remote_task_read`    | 按 delivery_id 读取远端队列／Turn 状态与最新报告 | `remote_tasks`  | Task delivery／SSH；来源 Thread 必须拥有该投递关系                                       |

远端任务使用目的地自己的模型、凭据和权限，可在来源连接关闭后继续执行，不属于 `spawn_agent` 的子 Agent 范围继承。
投递结果不确定时按原 delivery_id 与相同参数重试，不能通过创建另一条投递隐式重复任务。

### 25. 工具发现与转调（3）

ToolSet：`tool_discovery`（目标）。

定义：[通用搜索](../../crates/app-server/src/tool_composition.rs)、[MCP 搜索与转调](../../crates/app-server/src/tool_composition/mcp_exposure.rs)。
产品默认组合可明确引用本组，仅提供实际已注册的发现／转调入口。搜索候选与实际目标调用都受冻结的目标名单和来源授权约束；只选本组不授予其他工具。
默认与显式选择规则见[默认启用与可选组合](tools.md#默认启用与可选组合)。

| 工具            | 用途／主要操作                                | ToolSet（目标）  | 执行归属与条件                                               |
| --------------- | --------------------------------------------- | ---------------- | ------------------------------------------------------------ |
| `tool_search`   | 在有效范围内搜索可延迟加载的工具              | `tool_discovery` | 共享目录搜索；有 deferred 工具时装配；先筛选范围再排名／截断 |
| `search_tools`  | 搜索冻结 MCP 目录，返回有界精确定义与绑定     | `tool_discovery` | MCP 目录桥；只在相应暴露模式下出现；候选受有效范围约束       |
| `call_mcp_tool` | 用搜索返回的工具名及 digest 调用精确 MCP 工具 | `tool_discovery` | MCP 转调；目标范围与绑定独立检查；桥本身不授予目标权限       |

### 26. Code Mode（2）

ToolSet：`code_mode`（目标）。

定义：[Core 控制目录](../../crates/core/src/turn/code_mode/catalog.rs)、[Broker](../../crates/core/src/turn/code_mode/broker.rs)。
`exec` 与 `wait` 共同管理 JavaScript cell。仅在本组被选择、Tool Mode 启用 Code Mode 且运行时可用时提供；不与 Shell 执行混为一组。
范围与配置冲突处理见[默认启用与可选组合](tools.md#默认启用与可选组合)。

| 工具   | 用途／主要操作                           | ToolSet（目标） | 执行归属与条件                                                                |
| ------ | ---------------------------------------- | --------------- | ----------------------------------------------------------------------------- |
| `exec` | 在隔离 JavaScript cell 中编排工具调用    | `code_mode`     | Core Code Mode；无直接文件、网络、进程或 Node API；嵌套调用沿用范围与动作授权 |
| `wait` | 继续观察或终止已 yield 的 Code Mode cell | `code_mode`     | Core Code Mode；使用对应 cellId；不是 Shell 或 Agent 等待工具                 |

当前代码中的 `exec/wait` 由 Core 注入，不作为普通 App Server 成员出现在开发者注册目录。
目标统一目录与范围解析需要识别这两个入口，执行和 cell 生命周期仍归 Core，不为统一分组复制执行器或另建注册表。
可嵌套的目标还需满足[现有资格筛选](../../crates/tools/src/code_mode.rs)：可转为函数调用且 exposure 为 Direct 或 Deferred；
model-only、hidden 或不支持的调用形式不能仅因进入 ToolSet 就获得嵌套资格。

## 库工具与动态目录

| 工具          | 用途／主要操作                        | ToolSet（目标） | 接入状态                                                                                                                       |
| ------------- | ------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `file-system` | 在授权目录 read、list、metadata；只读 | —               | [库中已有定义](../../crates/file-system-tool/src/lib.rs)，当前未找到 App Server／CLI／TUI 的产品装配调用；不计入 86 个产品名称 |

以下来源不能用一份静态名称清单穷举。工具数量取决于当前安装、启用、连接、来源授权和 scope。

| 来源                                     | 枚举与接入依据                                                                        | 需要保留的身份／限制                                                                |
| ---------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| MCP Server／Connector／Plugin 携带的 MCP | Server 的 tools/list 经 [MCP catalog](../../crates/ash-mcp/src/catalog.rs) 校验并装配 | server ID、精确远端名、连接／目录 generation、definition digest；以当前暴露名称调用 |
| 外部 Extension 提供的工具                | 实际 Provider 激活和工具贡献；遵循[扩展接入契约](../editor-extensions.md)             | 包／Provider／scope 与实例身份；不能仅凭包目录或元数据推断已有工具                  |
| 客户端 dynamic 工具                      | [动态工具适配](../../crates/app-server/src/dynamic_tools.rs)中的客户端注册            | 精确 owner 和连接；断连不能改投同名的新 owner                                       |

`crates/ext/*` 中的进程内产品贡献已在前文逐项列出；目录名含 ext 不表示它们全部是第三方独立扩展。
Plugin／Connector discovery 候选也不等于已经可执行的工具定义。
当前 MCP catalog 的默认边界是每服务器 32 页、512 个工具、2 MiB 目录；这些是资源限制，
不能把“可持续添加工具”描述为无数量或资源约束。

## 复合工具的操作边界

这张表用于审阅操作差异，不宣称现有工具已经具备按产品划分的操作级 allowlist。
工具范围决定能否进入入口，实际动作仍由其 owner 的权限机制裁决。

| 工具                        | 读取／观察类操作                      | 修改／执行类操作                                                    | 组合时要明确的边界                                                        |
| --------------------------- | ------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `environment`               | `read`                                | `write`、`command`                                                  | 位于 `execution` 集合不表示所有操作都是进程执行，也不表示没有文件写入     |
| `shell-session`             | `read`、`wait`                        | `start`、`write`、`close_input`、`interrupt`、`resize`、`terminate` | 既要检查启动权限，也要检查既有进程 owner；读输出不授予任意进程控制        |
| `automation_update`         | `list`、`view`、`runs`                | `save`、`delete`、`run`、`stop`                                     | 需要只读自动化范围时，工具名选择不足；现有 AppToolPolicy 主要按工具名裁决 |
| `open_in_ash`               | 无纯读取动作                          | 打开 file／review／browser／terminal 界面                           | 不等于读文件、浏览网页或执行终端命令；展示目标依参数分支绑定              |
| `board_read`／`board_write` | channels、topics、posts、unread、post | create_channel、post、subscription、acknowledge                     | post 在两个入口分别表示读正文与发帖；写入不授予调度或权限能力             |
| `call_mcp_tool`             | 由目标实际动作决定                    | 由目标实际动作决定                                                  | 转调入口不能据此推断目标副作用                                            |
| `exec`                      | 由嵌套目标决定                        | 由嵌套目标决定                                                      | JavaScript 编排入口不替代每次嵌套调用的检查                               |

## 如何查看当前实例的实际目录

在命令面板运行 **开发者：查看 Agent 工具目录**（`workbench.action.chat.showToolCatalog`），
读取本实例的注册快照。命令可用范围、字段及诊断限制统一见[查看工具目录与范围诊断](tools.md#174-查看工具目录与范围诊断)。
