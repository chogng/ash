# Slash Commands 与 Slash Launcher 架构

> 本文拥有 Slash Commands 的跨产品语义、运行时边界与当前接入状态。Rust 实现细节由
> [`ash-slash-commands` README](../ash-rs/slash-commands/README.md) 拥有；通用斜杠启动面板
> （Slash Launcher）的实现契约由
> [`ash-slash-launcher` README](../ash-rs/slash-launcher/README.md) 拥有；App Server wire snapshot
> 由 [`ash-app-server-api.md`](ash-app-server-api.md) 拥有。Slash Command 与
> Instructions/Skills/Agents artifact 的关系由
> [`agent-customizations.md`](agent-customizations.md) 统一定义。

## 快速理解

Slash Command 是一种真正可调用的命令；斜杠启动面板只是用户输入 `/` 后出现的命令选择器。Skill 使用独立 `$name` selector，文件和 Plugin 上下文使用 `@`，三条入口不共享命名空间。

| 用户看到或产品要做的事 | 正确抽象 | 谁决定内容 |
| --- | --- | --- |
| 输入 `/` 后出现快速选择面板 | Slash Launcher | 产品选择并组合列表 |
| TUI 展示可执行 `/command` | Slash Command list | `ash-code` 的命令 adapter |
| TUI/Desktop 展示可调用 Skills | `$name` Skill selector | 客户端的 Skill adapter |
| app 展示文件或 Plugin 上下文 | `@` context selector | 对应上下文来源 |
| 选中一项后真正执行或注入上下文 | 来源自己的 typed binding | 对应产品/领域 owner |

App Server 当前在 `initialize.slashCommands` 发布服务端命令；每个客户端再与自身真正可执行的本地命令合并。TUI 的 `/` 补全和 `/help` 同时投影这份合并目录，因此本地与服务端命令使用同一名称、描述和参数声明。命令定义、名称冲突、补全和提交解析属于 Slash Commands；列表组合、跨来源匹配和面板选择属于 Slash Launcher；行布局、DOM、WGPU、Ratatui 绘制和平台输入事件仍留在各呈现层。默认服务端快照包含 `/compact`，允许保留可选的行内提示。

命令候选先按名称相关程度排序：完整名称、开头、连字符后的词首、连续片段、有序字符；然后按 description 的词首、连续片段、有序字符排序。`/cofig` 因而能找到 `/config`，`/settings` 也能找到描述中写有 settings 的命令。单字符仍只匹配名称开头，避免候选过多。候选检索忽略 ASCII 大小写；命中字符逐字加粗，未选中候选使用主题前景色，选中候选使用选中色。名称开头匹配可默认选中；词中、跳字和 description 命中只展示候选，需先用方向键或点击选择。每个命令只有一个名称；`/chats` 不再作为 `/history` 的别名。只有补全为完整规范名称后才会执行。

## Launcher 分层

`ash-slash-launcher` 只接受产品构造的 `SlashLauncherList`，并返回稳定的 `(list_id, item_id)` 选择。它不依赖 `ash-slash-commands`，但产品的 `/` 入口只传 Slash Command list：

- TUI、Desktop 和 app 都只传 Slash Command list；
- `$` Skill selector 和 `@` context selector 使用各自的 catalog、typed binding 与输入状态；
- 新命令列表通过产品 adapter 加入，不修改 Launcher 的领域模型。

选中项的业务 target、执行 handler、Skill 上下文注入和授权都留在列表来源。Launcher 不允许按展示
名称猜测业务对象，也不拥有 App Server protocol。

**当前状态**：通用 crate、列表组合、查询和选择状态已经实现；三种产品尚未迁移到该 crate。下面
表格描述的是迁移前的现有 Slash Command 接入，不能据此把 Skill projection 当作 Launcher 的长期
抽象。

| 现有 Surface | Catalog 来源 | Core/adapter | Renderer owner |
| --- | --- | --- | --- |
| TUI | built-ins + initialize snapshot | 直接使用 `ash-slash-commands` | Ratatui popup |
| Codex Rust UI | local `/model` + initialize snapshot | 直接使用 `ash-slash-commands`；该端另拥有 model picker | WGPU composer interaction rows |
| Desktop Chat | Workbench actions + initialize snapshot | canonical generated `SlashCommandDefinition` + action binding | Stanza completion widget；textarea/legacy editor runtime 可复用同一 catalog |

TUI 与 Desktop 的 Skill adapter 独立消费 `skills/list` metadata，并为 `$name` 候选绑定 exact pinned `SkillRef`；Skill 不再生成 command definition，也不参与 Slash Command 冲突检查。

## 所有权与执行

```text
App Server composition
  → initialize.slashCommands (immutable server snapshot)
  → client merges executable local commands
  → validated SlashCommandCatalog
  → input/query/matches/selection/completion
  → renderer projection
  → activation
      local  → client product command
      server → name-specific binding（`/compact` → CompactContext；prompt command → StartTurn text）
```

`SlashCommandDefinition` 是三端共享的 Slash Command catalog entry model，不是被调用对象的领域
model。`origin`、Workbench `actionId` 和 TUI dispatcher identity 都是与 entry 分离的 client binding。Skill `SkillRef` 属于 `$` selector，不能包装成 Slash Command。Skill authority 继续拥有 enablement、compatibility 和 activation validation。

Server-advertised Slash Command 必须有真实执行语义，不能仅凭 origin 猜测统一分发。当前内置
`/compact` 由 Desktop 直接调用 `SessionRequest::CompactContext`，以独立 Turn 执行并把成功或失败留在
当前对话；它不会把 `/compact` 文本发给模型。其他 server prompt command 继续把 unchanged invocation
作为普通 `StartTurn.input`。`/team` 与 `/develop` 也通过 `StartTurn.input` 传输，但 App Server 识别后交给持久工作流执行，控制命令不会作为普通提示词调用模型；命令契约见 [Develop 当前命令](develop.md#当前可执行命令) 和 [Team](core-multi-agent.md#31-团队共享讨论)。Local command 必须存在真实 client execution path，否则不能进入 catalog。
Desktop 的 `/new`、`/history` 属于
Workbench command mapping；Codex TUI 的 `/model` 属于 Session model selector；Ash TUI 的 `/theme` 属于
device-local presentation preference：无参数时打开由 `theme` 拥有的固定 Ash Code
Theme picker，带 ID 时静默直接切换；Theme picker 不启用搜索，通用 `ListSelection` 则以显式
的上下焦点移动进入 SearchBox。其他 built-ins 属于 TUI coordination。任意 local/server 同名都拒绝
整份合并结果，不按客户端优先级静默覆盖。Skill 与命令使用不同前缀；同名 Skill 仍因来源歧义不进入无来源限定的 `$name` 候选，但不会覆盖或屏蔽 `/name` 命令。

## 参数模式与行内虚提示

命令定义通过 `argument_mode` 声明是否接受参数，通过 `argument_hint` 声明输入框光标后的参数占位虚提示（Ghost Text）。

### 1. 参数模式

| 模式 (`argument_mode`) | 含义 | 行为表现 |
| :--- | :--- | :--- |
| `none` | 不接受参数 | 命令后若输入额外参数，整行不作为该命令执行 |
| `required` | 必须提供参数 | 提交时若缺少参数则提示错误或拒绝执行 |
| `optional` | 参数可选 | 无参数时触发默认行为或打开选择面板，有参数时直接应用 |

### 2. 占位虚提示与内置命令规范

`SlashCommandDefinition` 的 `argument_hint`（Rust `Option<String>`，TypeScript `argumentHint?: string`）定义参数占位符。占位符遵循统一规范，使用尖括号包裹小写描述（如 `<path>`）：

| 命令 | 模式 | 虚提示 (`argument_hint`) | 说明 |
| :--- | :--- | :--- | :--- |
| `/cd` | `required` | `<path>` | 切换工作目录 |
| `/add-dir` | `required` | `<path>` | 添加工作区目录 |
| `/export` | `required` | `<path>` | 导出当前对话内容 |
| `/model` | `optional` | `<model> [effort]` | 切换模型与思考量级别（如 `openai/o3-mini high` 或 `clear`），无参数打开选择器 |
| `/theme` | `optional` | `<theme>` | 切换主题，带参数直接设置，无参数打开选择器 |
| `/resume` | `required` | `<session-id>` | 恢复指定会话 |
| `/rewind` | `required` | `<checkpoint>` | 回退到指定检查点 |
| `/branch` | `optional` | `<name>` | 从当前节点复制分支并立即切换；不启动模型 |
| `/fork` | `optional` | `<prompt>` | 复制当前对话到独立 session，留在当前会话；有 prompt 时后台执行，无 prompt 时等待输入；结果不自动回传 |
| `/new` | `optional` | `<prompt>` | 新建会话，可选初始提示语 |
| `/compact` | `optional` | 无 | 压缩上下文，由服务端声明 |
| `/clear` | `none` | 无 | 清空当前对话，不接受参数 |
| `/help` | `none` | 无 | 显示帮助信息，不接受参数 |

### 3. 虚提示交互生命周期

- **激活条件**：输入完整合法命令后键入空格，参数文本尚为空（或仅包含空白），且光标位于末尾。
- **隐藏条件**：光标离开末尾（如回退编辑命令名），或用户开始键入非空白参数字符时，虚提示立即消失。
- **呈现规范**：输入框在光标后以置灰弱化样式（如 `context.muted()`）绘制虚提示；光标保持在实际输入的空格处，不移动物理光标，实际输入文本也不包含占位符内容。

## Marketplace 与领域管理入口

Web/Electron Workbench 和 Ash Code TUI 使用一个包管理入口，加上各领域的使用入口。命令只打开对应功能；安装状态由
[`Core Plugins`](../ash-rs/docs/core-plugins.md#一个包入口多个领域消费方) 统一持有。

| 入口 | 用户操作 | 安装相关操作 |
| --- | --- | --- |
| `/marketplace` | 搜索所有来源、查看包内容与版本、安装、更新、卸载 | 使用同一个 Core Plugins 服务 |
| `/skills` | 查看可用 Skill、启用/停用、查看诊断；通过 `$name` 调用 | “获取更多”打开 Marketplace 的 Skill 筛选 |
| `/lsp` | 查看当前语言与服务器、配置启用状态和路径、检查运行故障 | “查找服务器”打开 Marketplace 的语言筛选 |
| `/plugins` | 打开 Marketplace 的插件分类，查看已安装和未安装包 | 按所选安装记录更新和卸载 |
| MCP、Connector 领域 | 管连接、认证、工具与运行状态；当前不新增 Desktop slash command | Marketplace 提供对应 capability 筛选 |

- package 是版本和卸载单位；一个 Plugin 包携带的 Skill、MCP 等能力不分别安装，也不重复登记。
- 领域页面可直接提供安装按钮，但必须调用同一个包管理服务，并明确显示实际安装的整个包。
- 包搜索支持 package family 和 capability 筛选；领域入口按 capability 查询，包含 Plugin bundle 中的能力。
  `/skills` 不使用 `packageType=skill` 限制；`/lsp` 按当前编辑器语言 ID 查询明确的 executable 路由。
- 搜索命中语言包不代表其中每种语言都有 LSP；服务器路由必须来自已验证 catalog 的明确声明。
- 安装、更新和卸载通知使领域重新读取状态；进程、文档、认证、启用设置仍归各领域管理。

Web/Electron Chat 与 Ash Code 共用 `ProductSlashCommand` 的命令定义；Rust 直接读取，TypeScript 由协议生成器生成 `PRODUCT_SLASH_COMMANDS`。名称、描述、参数模式和占位提示只在共享契约中声明，各端仅绑定自身面板，不加入服务端会话命令。
`/marketplace [query]` 打开并搜索包，`/lsp [language-id]` 打开服务器面板并设置查找语言；`/plugins` 与 `/skills` 不接受参数。
页面提供 Tab/方向键导航、Alt+F1 帮助与独立 accessibility verbosity 设置。安装前展示完整包的版本和能力；
已安装列表按安装记录 ID 管理，同包多版本不会混用；目录不可用时仍可读取本地安装列表并卸载。
Skill 启用和 LSP 配置使用后端配置 revision；遇到冲突保留输入并提示刷新，不自动覆盖。
Ash Code 同时注册 `/marketplace [query]`、`/plugins`、`/lsp [language-id]`，命令直接打开终端面板。
Marketplace 按能力分类提供页签，另有插件包页签；`/marketplace` 默认进入技能分类，`/plugins` 进入插件包分类。每个分类内分“已安装”和“未安装”，收起的列表行只显示名称；左右键展开或收起来源、描述和版本。
`/` 聚焦搜索，`i` 打开安装审阅，`u` 打开卸载确认，`r` 刷新当前分类。Tab/Shift+Tab、方向键和 Esc 沿用 Config 面板的焦点与返回规则；安装前仍审阅整个包，已安装版本按具体安装记录更新和卸载。
`/lsp` 的 Available、Configured、Directories 页签显示可用服务器、配置和会话目录；输入语言 ID 后进入
Marketplace 精确路由搜索。可用表示已启用且程序可解析，不表示进程已启动。
`/skills`、`/mcp`、`/connectors`、`/lsp` 的获取入口进入同一个 Marketplace；语言服务器配置统一由 `/lsp` 管理，Config 不再重复提供页签。
分类不对应独立来源：Ash 发行配置已包含 `ash` Marketplace，只有接入另一个独立目录才需要增加来源与信任根。
终端在显示边界翻译共享命令描述和参数提示；面板动态文案使用翻译模板，包名、语言 ID、路径、权限标识和第三方描述保持原文。
终端使用共享列表的 Tab/方向键、搜索与鼠标路径；请求期间可按 Esc 关闭，迟到结果不会重开面板。

## Config 边界

`initialize.slashCommands` 不进入通用 config，也不由 slash command view 读取 config。它是 connection
初始化时冻结的 server capability snapshot。`skills/changed` 只使客户端重建独立 `$` selector catalog，不修改 Slash Command catalog 或 server snapshot。

## 当前限制

Rust surfaces 直接共享 `ash-slash-commands` 的 headless state。Desktop 直接消费同一个 generated
`SlashCommandDefinition` model，并由 Stanza Editor 的通用 completion/session state 投影交互；TypeScript
只保留运行时 catalog binding。Rust crate 与 Desktop adapter 共同执行
`ash-rs/slash-commands/fixtures/conformance.json`，确保名称校验、大小写、候选排序和参数规则一致。

## 修改影响

新增 wire 字段先修改 `ash-app-server-protocol` 并重新生成 TypeScript/schema。修改名称、参数、匹配或
输入规则必须同时更新 crate tests、跨运行时 fixture、TUI/Rust UI adapter tests 和 Desktop tests。
纯视觉变化只修改对应 renderer，不得把 host-specific state 反推到 catalog 或 protocol。
