# `external-agent-migration`

> 文档所有权：本 README 是外部 Agent 配置只读发现、有界源格式解析、导入计划与失败语义的当前
> 实现契约。
>
> 产品交互与长期演进由
> [`docs/ash-desktop-architecture.md`](../../docs/ash-desktop-architecture.md#22-外部-agent-配置导入仅限-desktop)
> 拥有；Ash 原生 Instructions/Skills/Agents、`.ash` 命名空间和 Import/source registration
> 边界由 [`docs/agent-customizations.md`](../../docs/agent-customizations.md) 拥有；Skill 来源与激活
> 语义由 [`docs/skills.md`](../../docs/skills.md) 拥有。
>
> 上游对照：本 crate 对应 codex 仓库的 `codex-rs/external-agent-migration`，名称一致。

`external-agent-migration` 识别 Codex 和 Claude 已知的用户级、项目级配置位置，产出两层只读结果：
`AgentPathInspection`（已知路径的元数据检查）和 `MigrationPlan`（读取有界源格式后的类型化迁移
计划，覆盖 instructions、settings、skills、commands、agents、rules、MCP servers、hooks、plugins
与 memory 文件）。本 crate 不递归扫描未知目录、不修改 Ash 配置，也不导入认证、会话、日志或
历史记录；把 plan fragment 映射到 Ash 领域并应用，仍是调用方 adapter 的职责。

## 1. Crate 边界与依赖方向

本 crate 拥有：

- 外部 Agent、用户/项目作用范围和导入条目类型；
- Codex/Claude 已知相对路径与预期文件类型；
- 调用方所选根目录的规范化和目录包含关系校验；
- 确定性排序、去重、候选与安全诊断；
- 外部源格式的有界解析：Claude `settings.json` 合并、`config.toml`、`.mcp.json`/`.claude.json`
  MCP 声明、hooks 声明、agent frontmatter、enabledPlugins 与 marketplace registry、项目 memory
  文件发现；
- 私有绝对路径和设置文档的 `Debug` 隐藏。

本 crate 不拥有：

- Desktop 目录选择、预览、确认、进度或撤销界面；
- App Server 方法、配置 revision 或导入应用流程；
- Config、Skill、MCP、Plugin 或 Multi-Agent 内容 schema；
- 内容信任、工具批准、脚本执行、网络连接或凭据解析；
- `CODEX_HOME`、`CLAUDE_CONFIG_DIR` 等宿主环境解析；
- `.ash/{instructions,skills,agents}` 的原生发现、加载或 runtime activation。

生产代码依赖 [`ash-utils-path`](../utils/path-utils/README.md) 的 host canonical containment
primitive，以及 `serde`、`serde_json`、`serde_yaml`、`toml` 格式 crate，测试使用
directory `tempfile`。它不得反向依赖
`ash-config`、`ash-skills`、App Server、Core 或 Desktop，也不能为了落库或 UI 方便引入上述高层领域。

## 2. 公共契约

| Symbol | 当前职责 | 不承担 |
| --- | --- | --- |
| `ExternalAgent` | 区分 `Codex` 与 `Claude` 布局 | 动态 provider registry |
| `ImportScope` | 区分 `User` 与 `Project` 来源 | directory capability 或配置优先级 |
| `AgentImportLocation::{codex_user,codex_project,claude_user,claude_project}` | 将来源、作用范围和调用方选择的根目录绑定为一个发现输入 | 环境变量解析、文件访问授权 |
| `inspect_agent_paths` | 校验所有输入根并检查已知相对位置 | 转换内容或应用配置 |
| `detect_migration_plan` | 校验输入根并解析有界源格式，产出按条目排序的 `MigrationPlanItem` | 映射到 Ash 领域、过滤已导入项、应用配置 |
| `MigrationPlanItem` / `MigrationItemDetail` | 一个可迁移条目及其类型化源格式 fragment | Ash config schema、目标 authority 命令 |
| `repository_root_for_cwd` | 从任意 cwd 向上解析 `.git` 仓库根 | home/project 作用范围决策、目录授权 |
| `AgentImportCandidate` | 返回来源、作用范围、条目类型、审查类别、相对路径和 canonical host path | 表示内容已受信任、已批准或可执行 |
| `AgentImportDiagnostic` | 说明一个已存在的已知路径为什么未进入候选 | 暴露根目录、正文或凭据 |
| `AgentImportError` | 表达调用方选择的根目录整体无效 | 表达单个候选的隔离错误 |

典型调用点保持自解释，不传递布尔模式或裸来源字符串：

```rust
use external_agent_migration::{AgentImportLocation, inspect_agent_paths};

let inspection = inspect_agent_paths([
    AgentImportLocation::codex_user(user_home),
    AgentImportLocation::claude_project(project_root),
])?;
```

`AgentPathInspection` 与 `MigrationPlan` 都只是预览输入。调用方仍须让用户选择具体条目，把 fragment
映射到目标领域并重新解析校验；不能把 `candidates()` 或 `items()` 非空解释为可自动导入。

```rust
use external_agent_migration::{AgentImportLocation, detect_migration_plan};

let plan = detect_migration_plan(
    [AgentImportLocation::claude_user(user_home)],
    Some(user_home),
)?;
```

## 3. 已知布局与审查分类

`agent_paths.rs` 拥有元数据 inspection 的静态路径表；`detect.rs` 和各内容模块拥有计划读取的固定布局。
当前识别的路径如下：

| 来源 | 用户级路径 | 项目级路径 |
| --- | --- | --- |
| Codex | `~/.codex/{AGENTS.md,AGENTS.override.md,config.toml,agents/,rules/}`、`~/.agents/skills/` | `{AGENTS.md,AGENTS.override.md}`、`.codex/{config.toml,agents/,rules/}`、`.agents/skills/` |
| Claude | `~/.claude/{CLAUDE.md,settings.json,settings.local.json,skills/,commands/,agents/,rules/}`、`~/.claude.json`（MCP 声明）、`~/.claude/projects/*/memory/` | `{CLAUDE.md,CLAUDE.local.md,.mcp.json}`、`.claude/{CLAUDE.md,settings.json,settings.local.json,skills/,commands/,agents/,rules/}`、`~/.claude.json` 对应项目条目（MCP 声明） |

路径映射依据 Codex 的
[导入说明](https://learn.chatgpt.com/docs/import)和
[Skill 位置说明](https://learn.chatgpt.com/docs/build-skills)，以及 Claude 的
[设置位置说明](https://code.claude.com/docs/en/settings)和
[Skill 位置说明](https://code.claude.com/docs/en/skills)。外部产品改变路径时，先更新
官方契约证据和 fixture，再修改 `agent_paths.rs`；不能靠扫描整个 home 猜测新位置。

| `ImportItemKind` | `ImportReviewCategory` | 原因 |
| --- | --- | --- |
| `Instructions`、`Skills`、`Commands`、`Memory`、`InstructionRules` | `Content` | 包含将进入模型上下文的外部指令 |
| `Settings`、`Agents`、`Plugins` | `Configuration` | 需要目标领域映射，不能按原格式直接生效 |
| `McpServers` | `Connection` | 可能引入进程、网络、header 或重新登录要求 |
| `ExecutionRules`、`Hooks` | `ExecutionPolicy` | 可能改变命令是否提示、允许或阻止 |

Claude commands 按 plan 条目发现（文件 stem），与上游一样作为可迁移为 skill 的候选；把 command
body 转成 Ash Skill 仍是 adapter 的职责，本 crate 不读取 command 正文。Codex execution rules 只发现
`.rules` 文件，Claude instruction rules 发现 `.md` 文件。

审查类别只用于 UI 分组和后续处理路由，不是授权结果。特别是 `ExecutionPolicy` 不能生成 Ash
长期批准，`Connection` 不能自动启动 MCP。

`~/.codex/auth.json` 永不进入候选。`~/.claude.json` 同时包含 OAuth session、MCP、
per-project state 和 cache，因此只允许专门的有界 parser 读取其中的 `mcpServers` 与匹配项目的
MCP 声明；整个文件不进入候选，也不交给 Desktop、模型或普通日志。

## 4. 文件与内部所有权

| 文件 / private symbol | 单一职责 | 修改时同步检查 |
| --- | --- | --- |
| `import.rs` | 公共导入值类型、named constructor、getter 和私有路径 `Debug` | App Server DTO、Desktop preview、隐私测试 |
| `plan.rs` | `MigrationPlan`/`MigrationPlanItem` 与类型化源格式 fragment；`Debug` 隐藏路径与设置文档 | App Server DTO、preview UI、redaction |
| `detect.rs::detect_migration_plan` | 按 agent/scope 编排 discovery 与解析，排序去重 plan item 与 diagnostic | 新条目类型、排序契约 |
| `source.rs` | 读取前路径校验、有界文件读取和目录枚举、按来源诊断 | 软链接、大小与深度上限、失败隔离 |
| `settings.rs` | JSON/TOML 解析、Claude 两份设置的合并与来源记录 | 源格式变化、失败语义 |
| `frontmatter.rs` | Markdown frontmatter 拆分与标量提取 | agent/命令 frontmatter 字段 |
| `mcp.rs` | 外部 MCP 声明收集、`${VAR}` 语义、stdio/http 归一化与 unsupported 标记 | transport 类型、placeholder 规则 |
| `hooks.rs` | Claude hooks 组发现与可转换组计数 | hook 字段白名单 |
| `plugins.rs` | enabledPlugins 分组与 marketplace source 解析 | registry 格式、official fallback |
| `memory.rs` | 外部项目 memory markdown 发现 | 项目 key 归属（adapter 职责） |
| `scope.rs::repository_root_for_cwd` | `.git` 仓库根向上解析 | 作用范围决策调用方 |
| `agent_paths.rs::paths_for` | `ExternalAgent + ImportScope` 到固定 `AgentPath` 的穷尽映射 | 官方路径、review category、fixture 和本表 |
| `agent_paths.rs::{file,directory}` | 构造带预期 entry 类型的 Agent 路径 | type-mismatch diagnostic |
| `inspect_path.rs::inspect_agent_paths` | 逐 root 检查 Agent 路径、排序、去重并构造 immutable inspection | 多 root 失败语义和顺序测试 |
| `inspect_path.rs::validate_import_root` | 拒绝不可用、非目录或 symlink root，并建立 `CanonicalPathRoot` | `AgentImportError` 与错误脱敏 |
| `inspect_path.rs::inspect_path` | 检查一个 Agent 相对路径的 metadata、类型和 symlink，再委托通用 canonical containment | diagnostic code、候选 canonical path |
| `error.rs` | 根目录级类型化错误与不含绝对路径的显示文本 | Desktop 错误映射与日志 |
| `inspect_path_tests.rs` | 临时目录上的路径检查与隐私回归 | 新来源、路径、错误或 redaction |

`lib.rs` 保持私有模块和显式 re-export。若调用方开始依赖 `agent_paths`/`inspect_path` 私有函数，或 crate
root 重新实现路径判断，说明公共 API 或 ownership 已经漂移。

## 5. 真实调用路径

```text
inspect_agent_paths
  → validate_import_root
      → symlink_metadata(root)
      → reject symlink / non-directory
      → CanonicalPathRoot::new(root)
  → agent_paths::paths_for(agent, scope)
  → inspect_path for each fixed relative path
      → missing: omit
      → symlink_metadata(candidate)
      → expected file/directory check
      → CanonicalPathRoot::canonicalize_within(candidate)
      → AgentImportCandidate | AgentImportDiagnostic
  → sort + dedup candidates and diagnostics
  → AgentPathInspection::new
```

`inspect_agent_paths` 只访问根目录和静态 `AgentPath` 指向的 metadata，不枚举子项、不打开文件。
`detect_migration_plan` 在同一 root 校验之后枚举固定目录并读取有界文件（settings、config、
`.mcp.json`、`.claude.json` 的 MCP 字段、agent frontmatter、plugins registry、memory 文件名），
输出：

```text
detect_migration_plan
  → Source::new → validate_import_root（同 inspection）
  → Source::read / directory
      → 检查各级路径、文件类型、symlink 和 canonical containment
      → 限制读取字节数与目录条目数
      → 有界解析 → 文档与实际 source_paths，或隔离 diagnostic
  → Claude: settings 合并；hooks 分文件累加；MCP 按来源合并；memory 独立发现
  → Codex: config.toml → document + mcp_servers fragment；.rules 文件发现
  → sort + dedup items（agent, scope, kind, source_paths）与 diagnostics
  → MigrationPlan::new
```

不读取 skill/command/memory 正文，不执行任何内容。计划读取在打开文件或枚举目录之前拒绝候选及其
根内祖先的 symlink；无效候选不产生内容 fragment。

`source.rs` 统一拥有资源限制，按一次选中 root 的读取累计：

| 资源 | 上限 |
| --- | --- |
| 单文件 | 1 MiB；实际读取也受上限约束，不能只检查 metadata 大小 |
| 单 root 累计读取 | 16 MiB |
| 单目录直接条目 | 1,024 |
| 单 root 累计枚举条目 | 4,096 |
| root 以下相对路径层数 | 16 |
| JSON/TOML/YAML 文档嵌套层数 | 64；格式解析器也保留自身递归限制 |
| 单文档节点数 | 65,536 |
| YAML 别名展开后的累计文本 | 1 MiB；构造值树前校验展开预算 |

超过限制产生 `LimitExceeded`；不能读取的目录不返回部分目录清单，其他预算允许的来源继续处理。
传入的跨 home MCP 来源独立校验，并使用自己的 root 预算和 User scope diagnostic。

- Settings 保留两份成功解析的文件路径；仅有 `settings.local.json` 也产生条目，单份文件无效不丢弃有效的另一份。
- Hooks 分别收集两份设置中的事件组；`disableAllHooks` 按 local 优先级生效，非法 hook 元素使整组不可转换。
- MCP 按既定优先级合并有效来源，记录实际读取的 `.mcp.json`、`.claude.json` 和参与 enablement 的设置文件；Codex `enabled = false` 标记为 `Disabled`。
- Memory 发现只由 User scope 控制，不依赖 settings 存在或有效。
- Plugins 记录设置及有效 registry 的来源；registry 错误通过脱敏 diagnostic 返回，不写原始路径或解析错误日志。

## 6. 失败、隔离与隐私语义

| 条件 | 结果 | 是否继续其他候选 |
| --- | --- | --- |
| 输入 root 不可访问 | `AgentImportError::RootUnavailable` | ❌ 整个调用失败 |
| 输入 root 不是目录 | `AgentImportError::RootNotDirectory` | ❌ 整个调用失败 |
| 输入 root 本身是 symlink | `AgentImportError::RootSymlinkNotAllowed` | ❌ 整个调用失败 |
| 已知相对路径不存在 | 不产生候选或 diagnostic | ✅ |
| 候选 metadata/canonicalize 失败 | `MetadataUnavailable` | ✅ |
| 候选类型与 specification 不符 | `UnexpectedFileType` | ✅ |
| 候选自身是 symlink；或计划读取遇到根内 ancestor symlink | `SymlinkNotAllowed` | ✅ |
| inspection 的 ancestor symlink 使 canonical candidate 逃出 root | `EscapesSelectedRoot` | ✅ |
| settings/config/MCP/frontmatter/registry 解析失败 | `InvalidContent` diagnostic，跳过该文件 | ✅ |
| 读取、枚举或文档深度超限 | `LimitExceeded` diagnostic | ✅ 继续剩余预算允许的来源 |
| 候选合法 | 保存 canonical path | ✅ |

多 root 调用不是部分成功协议：任一输入 root 无效都会返回 `Err`，不会返回其他 root 的半份 inspection。
单候选问题则通过 diagnostic 隔离，不影响同一 root 的其他候选。

`AgentImportLocation` 和 `AgentImportCandidate` 的 `Debug` 隐藏绝对路径，错误和 diagnostic 只携带
来源、作用范围、固定相对路径或 `io::ErrorKind`。但 `AgentImportCandidate::source_path()` 会
显式返回 canonical host path，供可信 host adapter 后续读取；调用方不得把该值放入普通 telemetry、
Thread history、模型上下文或未脱敏错误。

## 7. Host 接入义务

Desktop/App Server 接入时必须：

1. 只从用户明确选择或产品已定义的根目录构造 `AgentImportLocation`；
2. 在受信 host 侧调用 `discover`，不接受 Renderer 提交任意候选路径；
3. 用 `agent + scope + kind + relative path` 展示候选，默认不显示完整 home path；
4. 让用户按条目确认，并将 review category 对应的风险和后续动作分开说明；
5. 在应用前由目标领域重新打开、限制大小、解析、校验并生成自己的 typed mutation；
6. 对读取与应用之间的文件变化重新校验 identity/digest，不能把 preview 当作冻结内容；
7. 认证、凭据、连接批准和执行批准继续走各自 authority。

当前没有 App Server DTO 或 inspection identity。任何 wire contract 都应传 source-qualified identity
和受控相对路径，不应直接把 `source_path()` 序列化给 Renderer。

### 7.1 应用到目标权威

Import 的最终目的不是让 Ash runtime 直接解释外部格式，而是把用户选中的内容转换成目标
authority 能重新校验的 typed fragment。App Server adapter 根据条目路由到 Config、Instruction、
Skill、Agent 或其他 authority；本 crate 不拥有这些领域的 canonical schema。依赖方向保持为：

```text
external source
  → external-agent-migration normalized preview fragment
  → App Server import adapter
  → target authority typed command / prepare-publish contract
```

`external-agent-migration` 不依赖 `ash-config`，也不直接构造 `UserConfigCommand`。App Server adapter 同时
依赖两者，负责 source-specific conversion、conflict preview、用户逐项确认和 Config transaction。
这样外部格式变化不会反向决定 Ash Config schema，inspection 成功也不会被误当成 configuration
commit。

| Import item | Ash apply target | 当前状态与安全边界 |
| --- | --- | --- |
| `Skills` | `AddSkillSource` / Skill source authority | Config command 已有；仍需 parser、digest、conflict 与 source identity |
| `McpServers` | `UpsertMcpServer` | Config command 已有；导入时默认不连接，credential 必须剥离并单独绑定 |
| Settings 内的 Plugin request | `UpsertPluginRequest` | Config command 已有；只接受可解析的 exact package/version request，不代表安装或激活 |
| Settings 内的 Hook | `UpsertHook` | Config command 已有；导入后保持 disabled，执行仍需 trust、policy、approval 与 sandbox |
| `Instructions`、`InstructionRules` | Ash Instruction authority | 目标模型尚未完成，不能把原始文件塞入普通 Config |
| `Agents` | Ash Agent definition authority | 目标模型尚未完成 |
| `Settings` 其他字段 | 对应 Ash typed field-by-field mapping | 不支持项必须显示为 skipped/unsupported，禁止 raw passthrough |
| `ExecutionRules` | Policy migration review | 不能生成长期 approval，也不能自动转换为 Hook |

一次 Import 可能同时修改 Skill、MCP、Plugin 与 Hook section，因此 apply 必须先构造完整 plan。
Config 子批次使用 expected-revision 约束：
重新校验 source identity/digest，验证全部 typed mutation，成功时一次推进 Config revision，任一项
失败则不提交任何 Config 项。`Instructions` 与 `Agents` 等非 Config target 尚未完成；在对应
authority 可以 prepare/publish 前，它们必须保持 unsupported，不能伪装成同一 Config transaction。
当前 Config 只有逐 command mutation；atomic import batch、跨 authority prepare/publish、import
receipt、provenance 与 remove/rollback contract 尚未实现。

共享的项目 `AGENTS.md` 已由 Ash Instruction authority 直接读取，不能再导入成第二份。
`CLAUDE.md` 等专有来源的目标为 Ash 专属 `ASH.md` 或细分 `instructions/` 文件；
导入应由 App Server 协调受信文件读写：选定来源、重新校验、仅在目标缺失或为空时直接复制正文；
已有非空 `ASH.md` 应报告冲突，不由 Agent 合并或覆盖。
全程不调用 Agent，也不把来源正文放进 `/init` 的模型上下文。`/init` 只负责让 Agent 根据
项目事实生成或更新 Ash 自己的 `ASH.md`。目前只有发现与预览，写入目标的 apply 尚未实现。

`ash-file-access` 与 Import workflow 是两条不同路径。前者保存目录 Grant，并按明确的来源能力开放 Skills、Agent definitions 或 Plugin declaration；后者让用户预览、选择并迁移外部 Agent 配置，不授予持续文件访问。两条路径可以复用来源检查和解析，但不能复用授权生命周期或应用决定；本 crate 不依赖 `ash-file-access`，由 App Server 根据 Authorization 调用。

原生加载是第四条独立路径：directory `.ash/{instructions,skills,agents}`、Ash user root、
built-in resources 和 Plugin contribution 由各目标 authority 直接发现，不经过本 crate。若
Instruction/Skill/Agent loader 开始扫描 `.codex`、`.agents` 或 `.claude`，或者本 crate 开始加载
`.ash` 并构造 runtime snapshot，都表示 compatibility boundary 已经漂移。

Import 与 source registration 也不能画等号。Import 生成由 Ash authority 独立管理的 artifact；
source registration 保存一个可撤销的窄只读来源，当前只对 standalone Skill source 具备 Config
desired-state 基础。两者可以复用 discovery/parser，但由目标 authority 决定 persistence、refresh
和 removal semantics。

## 8. 常见修改及影响面

### 增加一个已知路径

1. 在对应 inspection 的 `agent_paths.rs` 表或计划的内容模块增加固定路径；
2. 选择准确的 `ImportItemKind`、`ImportReviewCategory` 和 expected file/directory；
3. 增加存在、缺失、错误类型和敏感排除测试；
4. 更新本 README 的布局表，并检查 Desktop/Skill/权限文档是否受影响。

### 增加一种外部 Agent

1. 扩展 `ExternalAgent` 和 named `AgentImportLocation` constructor；
2. 为 User/Project 分别定义静态已知路径，保持 `paths_for` 穷尽匹配；
3. 增加官方路径证据、完整 fixture 和 redaction 测试；
4. 定义目标领域映射前只返回 preview candidate，不增加隐式 apply；
5. 同步 App Server DTO、Desktop picker 和系统文档。

### 增加内容 parser

parser 必须位于新的 private module，设置 byte/entry/depth 上限，拒绝未知 active content，并输出
不含 secret 的 typed fragment。它不能在解析阶段写 Config、连接 MCP、执行 hook/script 或生成
批准。若单个模块接近 500 LoC，应按来源或内容类型拆分并把测试放到 sibling `*_tests.rs`。

## 9. 验证

```bash
just check external-agent-migration
just test external-agent-migration
just rust-warnings external-agent-migration
bazel test //ash-rs/external-agent-migration:external-agent-migration-unit-tests
```

当前测试覆盖：

- Codex user 候选与 `auth.json` 排除；
- Claude user 候选与 `.claude.json` 排除；
- Claude project 内容、配置和连接审查分类；
- 已知路径错误文件类型的 diagnostic；
- ancestor symlink 逃逸；
- inspection `Debug` 不泄露临时 root；
- Claude settings 合并、hooks 计数、MCP 归一化与 placeholder 语义、plugins marketplace source、
  memory 发现（各模块 sibling 测试）；
- Codex/Claude 端到端 plan：条目种类、排序、去重、`InvalidContent` 隔离、空布局；
- 文件/ancestor symlink 在计划读取前被拒绝、跨 home 文件实际来源及诊断 scope；
- local-only Settings、hooks 跨文件累加与非法元素、独立 memory 发现、Codex `.rules` 和禁用 MCP；
- 单文件与累计读取大小、单目录与累计条目数量、memory 路径深度、三种文档节点与深度限制、YAML 别名展开预算；
- frontmatter sibling 测试已注册并参与 Cargo 与 Bazel 测试。

测试只使用 `tempfile`，不读取真实 home。修改根目录错误分支、去重或多 root 行为时，应补充对应
failure fixture；当前测试尚未覆盖所有 `AgentImportError` 分支，这是明确的测试缺口。

## 10. 当前限制与扩展点

- **Current**：Codex/Claude 已知路径的元数据检查、根目录/候选校验、确定性 inspection、有界源
  格式解析与 `MigrationPlan` fragment、diagnostic 与私有路径 `Debug` 隐藏。
- **Current limitation**：不读取 skill/command/memory 正文，不能生成按条目选择的转换 diff；
  sessions、认证与历史导入明确不在本 crate 范围。
- **Current limitation**：user constructor 只识别默认 home layout；自定义 `CODEX_HOME`、
  `CLAUDE_CONFIG_DIR` 或独立外部 source root 尚无公共构造契约。
- **Current limitation**：没有 stable inspection identity、TOCTOU revalidation 或 App Server wire
  contract。
- **Current limitation**：没有 Config batch adapter、import receipt 或 source-qualified rollback
  contract。
- **Proposed**：App Server 组合 `MigrationPlan` fragment 并调用各 authority；Desktop 只提交用户
 确认后的 exact item identity。
- **Proposed**：为 host `add-dir` adapter 提供只返回 allowlisted contribution kind 的窄
  inspection projection；它不等同完整 Import，也不处理 directory authorization。

无论后续实现如何演进，以下不变量保持不变：不扫描整个 home、不导入认证状态、不把 preview
当作执行授权、不让 Desktop 或本 crate 绕过目标领域的最终校验。
