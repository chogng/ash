# Skill 指令系统

> 物理位置：`ash-rs/skills/`
> Rust crate：`ash_skills`
> 当前状态：Phase S0、S1 显式选择、可信 built-in metadata 自动 selector、模型按需读取、通用 package resource、有界文本模型切片与 binary asset Resource materialization 已实现；Renderer preview、script execution adapter 与 S3–S4 仍为 Proposed。TUI 与 Desktop 已把
> 可直接调用的 Skill 通过独立的 `$name` 选择器调用；`/skills` 只承担目录管理。
> Crate 实现契约：[`ash-rs/skills/README.md`](../ash-rs/skills/README.md)
> Runtime extension 实现契约：[`ash-rs/ext/skills/README.md`](../ash-rs/ext/skills/README.md)
> 通用扩展生命周期：[`ash-rs/ext/extension-api/README.md`](../ash-rs/ext/extension-api/README.md)
> Core architecture：[`core.md`](core.md)
> Agent runtime：[`ash-agent-runtime-architecture.md`](ash-agent-runtime-architecture.md)
> Config authority 与 runtime snapshot 接入：[`config.md`](config.md)
> Instructions/Skills/Agents 领域划分与外部导入：[`agent-customizations.md`](agent-customizations.md)
> Marketplace package 入口：[`core-plugins.md`](../ash-rs/docs/core-plugins.md)
> Legacy Plugin 兼容来源：[`plugins.md`](plugins.md)
> MCP runtime：[`mcp.md`](mcp.md)

> 外部格式核对日期：2026-07-28。Skill package 以
> [Agent Skills specification](https://agentskills.io/specification) 为兼容基线；Ash 自己的
> source、trust、activation 和执行权限语义由本文定义。

## 快速理解

Skill 是按任务逐步加载的工作方法和参考资料，不是工具权限。Agent 可以按照 Skill 建议行动，
但任何脚本、网络或文件操作仍经过正常工具、权限和沙箱流程。

| 发生的事情 | 加载什么 | 安全边界 |
| --- | --- | --- |
| 启动或刷新 Skill 目录 | 只读取名称、描述和来源等元数据 | 不把全部正文塞入上下文 |
| 用户输入 `$commit` 等 Skill 选择 | 接受 Turn 时完整读取对应 `SKILL.md` | `$` 候选只持有元数据和精确 `SkillRef` |
| Turn 文本唯一高置信匹配 verified built-in Skill | host 只用有界 metadata 选择，冻结 exact `SkillRef` 后才读取正文 | 歧义、低置信、user/Directory/Plugin/Marketplace 来源都不自动激活 |
| 用户打开 `/skills` | 浏览、启用、禁用和查看诊断 | 不从管理面板直接执行 Skill |
| 模型按需选择 Skill | 模型先看到有界元数据目录，再调用 `skills-read` 加载正文 | 后端不做关键词分类，也不暴露本地路径 |
| 正文引用参考资料 | 只在当前任务确实需要时读取 | 路径必须受来源目录约束 |
| Skill 建议运行脚本或工具 | 转成普通工具请求 | 不授予文件、网络、凭据或沙箱绕过能力 |
| Marketplace package 提供 Skill | Manager 验证 exact package，再把 Skill capability 投影进共享 catalog | 安装不等于启用、选择或执行 |
| Legacy Plugin 提供 Skill | 保留 Plugin、版本和内容摘要来源 | Plugin 启用不等于 Skill 自动执行 |

## 1. 结论

`ash-skills` 是 Ash 的 Skill 文件、catalog、解析和 exact activation 底层 authority；
`ash-skills-extension` 负责来源组合、选择策略、watcher 和向 Core 注入上下文。Skill 是一个以
`SKILL.md` 为入口的指令目录，可以附带 references、scripts 和 assets。它帮助 Agent 判断“这类
任务应采用什么工作流”，但本身不是可执行权限、tool implementation、MCP server 或 Plugin。

核心原则：

```text
发现时只加载 metadata
→ 任务匹配后完整加载 SKILL.md
→ 只有真实需要时读取 references/scripts/assets
```

Skill 内容是带来源的外部 instruction：

- 它低于 Ash system/developer/product policy；
- 它不能授权 tool、network、filesystem、credential 或 sandbox bypass；
- 它可以建议使用工具或脚本，但实际执行仍经过标准 tool loop；
- 它不能通过“忽略上层规则”改变 instruction precedence；
- 未激活 Skill 的正文不得占用每次模型调用 context。

## 2. 当前仓库状态

当前 `ash-skills` 已实现 S0 format/catalog：built-in/user/Directory controlled root、bounded
frontmatter parse、metadata-only scan、完整 `SKILL.md` digest、isolated diagnostic 和 immutable
catalog generation。内置内容由 `ash-rs/skills/assets/` 拥有，release staging 将其复制到
`ash-resources/skills/`，`ash-install-context` 提供 directory candidate，host 再构造
`SkillSourceRoot::built_in`。当前正式内置内容只有 `skill-creator`；新增 built-in 需要明确的
产品语义、触发边界和选择评测，不能把 catalog fixture 直接升级为产品能力。实现细节与 limits 由
[`ash-rs/skills/README.md`](../ash-rs/skills/README.md) 维护。

`ash-skills-extension` 当前拥有 catalog runtime：它组合 release built-in root、user config 中
明确 enabled 的绝对 source root 和 active Directory 的 `.ash/skills`，叠加 durable per-Skill
enablement，缓存 immutable projection，并通过通用 contributor 提供 Turn activation 与 context
fragment。App Server 提供 `skills/list`、`skill/enablement/set`、digest-pinned
`skill/resource/open` 与 `skills/changed` 协议投影。
`ash-file-watcher` 的
invalidation 会触发完整重扫；只有 entry、diagnostic 或 enablement 的 consumer-visible projection
变化才推进 runtime generation。共享的 `SkillName`、`SkillSourceId` 与 `SkillId` 已下沉到
`ash-protocol`，因此 config、catalog、App Server 与客户端不再靠 raw string 隐式绑定。

TUI 与 Desktop 消费同一 typed catalog，并把 enabled、compatible、名称无歧义的 Skill 显示为 `$name` 候选。选择 `$commit` 后，客户端保留用户可见的 `$commit …` 文本，同时提交 exact pinned `SkillRef`；目录发现阶段不读取正文。Skill 与 Slash Command 使用不同前缀，因此同名不会冲突。`skills/changed` 会刷新 `$` 候选列表。

TUI `/skills` 提供 All/Enabled/Disabled/Manage/Errors tabs、搜索、左右切页和上下选择；只有 Manage
中的动作修改后续 catalog eligibility。它是管理入口，不是日常执行 Skill 的二级 picker。

当前显式和受信任自动激活链已经接通。显式协议输入为：

```rust
UserInput::Skill { skill: SkillRef }
```

Core 在接受 Turn 前调用 extension registry；`ash-skills-extension` 先从当前 enabled/compatible
catalog 解析显式 `SkillRef`，再对未显式选择的 `BuiltInVerified` 候选运行 metadata-only、唯一
高置信 selector。两条路径都先得到 exact pinned `SkillRef`，再完整读取受控根中的 `SKILL.md`，冻结
`SkillId + content digest + catalog generation + activation reason` 并持久化到 `TurnAccepted`。
每个 model safe point，Core 再调用 `TurnInputContributor`，接收按 frozen digest 解析出的
`PromptFragment` 并交给 context planner。客户端不能提交 raw path；文件缺失、换
identity、hard link、越界 symlink 或 digest 变化都会失败即关闭，不会悄悄跟随新内容。

Skill body 不复制进 Thread history；durable activation provenance 足以审计，恢复执行则要求原
source 仍能提供 exact bytes。已经开始的 Turn 即使随后被 catalog disable，仍按冻结 snapshot
完成；内容改变则停止，而不是替换 in-flight 指令。

上述 exact-byte 要求适用于尚需继续执行的 Turn。重复提交已经 accepted 的同一 `commandId` 时，
App Server 先按 durable command receipt 校验输入并返回原 Turn 结果，不重新读取当前 catalog 或
Skill 文件；因此源文件删除不会破坏已完成命令的幂等重放。

当前 runtime source composition 包含 built-in、user、active Directory 的 `.ash/skills` source、
Marketplace Manager 安装的 exact Skill capability，以及 effective legacy Plugin manifest 声明的 exact
Skill directory。Manager installation generation 或 Plugin activation generation 变化都会触发 catalog
refresh，未声明的同包 sibling directory 不会进入 catalog。Marketplace provenance 作为独立
`SkillSourceKind::Marketplace` 保留，不伪装成 built-in 或 Plugin。Directory config 中额外声明的独立
Skill source intent 与 script execution adapter 尚未接入；正文读取、通用 package resource resolver、有界 UTF-8 模型
读取、binary asset Resource materialization、compatibility gate、显式激活和模型按需读取已接入。

仓库已有可复用边界：

- `ash-protocol` 的 UserInput、Resource、ToolName 和 provider-independent model contract；
- Core `ContextAssembler`、`ModelInvocationSnapshot` 与 durable checkpoint pipeline；
- App Server 的 typed command、Resource store 和 generated client contract；
- Marketplace Manager 提供 digest-pinned immutable Skill capability root；
- legacy Plugin authority 提供 manifest-declared exact Skill contribution root；
- 目标 `ash-tool-executor` / `ash-sandboxing` 负责脚本执行，而不是 Skill loader；产品层
  `ash-exec` 是 headless Agent runner。

## 3. 格式基线

[Agent Skills specification](https://agentskills.io/specification) 规定：

```text
skill-name/
├── SKILL.md          # required: YAML frontmatter + Markdown instructions
├── scripts/          # optional executable helpers
├── references/       # optional on-demand documentation
├── assets/           # optional templates/static resources
└── ...
```

`SKILL.md` 必须有：

```yaml
---
name: code-review
description: Reviews code changes for correctness and maintainability. Use for PR or diff review.
---
```

兼容字段：

| Field | Ash 处理 |
| --- | --- |
| `name` | 严格校验，并要求与 Skill 目录名一致 |
| `description` | discovery/selection metadata，必须同时说明做什么和何时使用 |
| `license` | 展示与分发 metadata，不影响 runtime permission |
| `compatibility` | 环境提示；解析为 warning/gate，但不自动安装依赖 |
| `metadata` | string map；只允许 namespaced extension 影响 Ash 展示 |
| `allowed-tools` | experimental hint；绝不作为 Ash approval grant |
| Markdown body | Skill 激活后作为完整 instruction 加载 |

Ash 不修改第三方 Skill format 来塞入 executable grant、credential 或 MCP launch config。这些属于
Plugin manifest/config。独立 Skill 需要额外能力时只能产生明确 compatibility diagnostic。

## 4. 职责与非职责

### 4.1 Skill manager 拥有

- Skill source 的注册、隔离、扫描和 invalidation；
- `SKILL.md` frontmatter strict parse 与 Agent Skills format validation；
- stable Skill identity、source、digest、availability 和 compatibility projection；
- metadata-only catalog 与 immutable generation；
- 显式选择、自动候选检索和冲突解释；
- 激活时完整读取 `SKILL.md`；
- 按需、安全地解析 relative references/scripts/assets；
- context budget、递归深度、文件数、单文件和总 bytes 限制；
- `SkillActivationSnapshot`、provenance 和 content digest；
- file change/update 后只在下一个 model safe point 生效；
- 不含正文和 secret 的 diagnostics/telemetry。

### 4.2 Skill manager 不拥有

- Marketplace/Plugin package 下载、签名、安装、enablement 或 grants；
- script 执行、shell、dependency install、network 或 filesystem mutation；
- MCP session、tool call 或 resource read；
- Agent loop、model selection、prompt tokenization 算法；
- system/developer instruction 或 product policy authority；
- Thread event append、Tool Result 或 retry；
- 把 Skill 自动转成全局 memory；
- 扫描整个 home directory 或任意绝对 path。

## 5. 目标依赖与组合

```text
config / Directory / built-in roots
Marketplace Manager / legacy Plugin authority
                │
                ▼
          ash-skills
  file / catalog / exact loader
                │
                ▼
     ash-skills-extension
 source composition / watcher / selection / fragment contribution
                │ implements
                ▼
       ash-extension-api
 activation + model-safe-point contracts
                │ invoked by
                ▼
       Core ContextAssembler
                │
                ▼
           ModelRequest

App Server 只在组合根安装 extension，并把 Config、RPC DTO 和 `skills/changed` 接到对应端口。
```

规则：

- `ash-skills` 不依赖 `ash-core`、stores、App Server 或 Plugin live manager；
- `ash-file-identity` 只提供已打开文件的跨平台 identity/link-count，不拥有 Skill path
  policy；具体 Win32/Unix contract 见
  [`ash-rs/file-identity/README.md`](../ash-rs/file-identity/README.md)；
- Skill source 以窄 `SkillSourceRoot`/file resolver port 注入；
- Marketplace Manager 或 legacy Plugin authority 只提供 immutable exact root，Skill manager 仍重新校验 Skill format；
- Core ContextAssembler 只接收通用 `PromptFragment`，不依赖 Skill catalog 或 filesystem；
- `ash-skills-extension` 在 safe point 按 frozen digest 精确重读已激活正文，但不重新做选择；
- Skill scripts 通过普通 Tool/exec port 执行，`ash-skills` 不依赖
  `ash-tool-executor`；
- 只有 `SkillId`、`SkillRef`、选择 intent 等至少跨两个组件共享的稳定 value 才进入
  `ash-protocol`；catalog cache、filesystem handle、parse error 留在 `ash-skills`。

## 6. 身份、来源与优先级

### 6.1 稳定身份

Skill format 的 `name` 只在一个 source root 内唯一。Ash identity 必须包含 source：

```rust
pub struct SkillId {
    pub source: SkillSourceId,
    pub name: SkillName,
}

pub struct SkillRef {
    pub id: SkillId,
    pub version: SkillVersionSelector,
}
```

wire `SkillRef` 通过显式 version selector 区分两种用户意图：

- `FollowLatest`：解析当前 source 中同一 Skill ID，适合普通 picker；
- `PinnedDigest`：必须匹配 exact content，适合 Plugin lock、replay 和审计。

使用具名 enum，不使用 `Option<digest>` 让调用者猜含义：

```rust
pub enum SkillVersionSelector {
    FollowLatest,
    PinnedDigest { digest: ContentDigest },
}
```

### 6.2 来源

```text
BuiltIn { release }
User { configuredRoot }
Directory { sourceId, configuredRoot }
Plugin { pluginId, version, packageDigest }
Marketplace { packageId, version, packageDigest, capabilityId }
LocalDevelopment { canonicalRoot }
```

source root 是 host 验证后的 opaque handle，不是未经校验的字符串 path。

### 6.3 优先级

Precedence 只用于候选排序，不用于静默覆盖：

```text
用户在当前 Turn 显式选择
> directory enabled
> user enabled
> Marketplace enabled
> Plugin enabled
> built-in fallback
```

两个不同 `SkillId` 即使 `name` 相同也同时存在，UI 和模型目录都必须显示 source。模型调用
`skills-read` 时提交 exact source，因此不按目录扫描顺序取同名条目。

显式 Skill 可以和自动 Skill 同时激活，但去重按 exact `SkillId + digest`，不是 display name。

## 7. 发现与目录

### 7.1 元数据-only 发现

启动/刷新时只：

1. 枚举受控 source root 下的直接 Skill 目录；
2. 打开该目录的 `SKILL.md`；
3. 读取有界 frontmatter 和必要 metadata；
4. 校验 name/description/path；
5. 计算内容 identity 所需的 digest 或 filesystem validator；
6. 建立 catalog entry。

不得在 discovery 时：

- 加载 Markdown body 到全局 prompt；
- 递归读取 references/assets；
- 执行 scripts；
- 探测网络或安装 compatibility dependency；
- 跟随逃出 source root 的 symlink；
- 因单个坏 Skill 让整个 built-in/user catalog 丢失。

Marketplace/Plugin package 是原子安装来源，但 Skill 仍由本领域重新校验。一个 exact Skill capability
无效时，该 capability 不进入 catalog 并产生来源诊断；普通 user source 可按 entry 隔离错误。其他同包
capability 是否可用由各自领域 consumer 决定，Skill loader 不回滚整个 Marketplace installation。

### 7.2 目录快照

```rust
pub struct SkillCatalogSnapshot {
    pub generation: u64,
    pub entries: Vec<SkillCatalogEntry>,
    pub diagnostics: Vec<SkillDiagnostic>,
}

pub struct SkillCatalogEntry {
    pub id: SkillId,
    pub description: String,
    pub source: SkillSourceView,
    pub content_digest: ContentDigest,
    pub compatibility: SkillCompatibility,
    pub availability: SkillAvailability,
}
```

排序必须确定，相同 generation 的序列化结果稳定。只有 consumer-visible metadata、digest、
availability 或 diagnostic 变化才递增 generation。

当前 `ash-file-watcher` 已提供共享、多订阅者的 filesystem invalidation substrate：
`PathsChanged` 传递排序去重后的 coarse path hint，backend error/overflow 通过
`RescanRequired` 传递 subscriber 自己的 watched roots。其 backend/ref-count/path fallback contract
由 [`ash-rs/file-watcher/README.md`](../ash-rs/file-watcher/README.md) 维护。

Watcher 仍只发 invalidation hint。当前 App Server adapter 订阅 built-in/user roots、active
Directory 的 `.ash` metadata root 与 user config authority path；收到普通 change、backend error
或 overflow 后都调用
`SkillCatalog::refresh` 重新扫描/校验，再按可见 projection 决定是否发布 `skills/changed`。
Watcher backend 无法启动时不会阻止 App Server 启动，调用方仍可用
`skills/list { reload: "refresh" }` 显式重扫；当前没有对外 watcher-health projection。
这条 catalog refresh 路径不代表 activation safe-point composition 已完成。

## 8. 选择

### 8.1 显式选择

用户通过独立 Skill selector 中的 `$name`，或直接通过 `session/request` `StartTurn` typed input 选择 exact
`SkillRef`。显式选择：

- 由用户预先固定，不依赖模型是否决定读取某个 Skill；
- 仍要通过 enablement、availability、compatibility 和 trust policy；
- 若 pinned digest 已变化，返回 `SkillContentChanged`，不能悄悄跟随新内容；
- 若 source 不再存在，historical display 仍保留 ID/digest，但新 Turn 不能激活；
- 不允许客户端提供 catalog 外 absolute path。

当前 wire shape 已迁移为：

```text
UserInput::Skill {
  skill: SkillRef
}
```

旧 `name + path` serde shape 会被拒绝，不保留双入口。App Server schema、generated TypeScript、
Core、TUI 和 Desktop 共享同一 `SkillRef` contract。TUI 与 Desktop 的 `$` 候选目录只加载 metadata，
真正接受 Turn 时才由 App Server 加载完整 `SKILL.md`。

### 8.2 模型按需选择（已实现）

每次模型调用的 Skill 层会收到一个最多 8 KiB 的 `<available-skills>` 目录。目录只包含当前
enabled、compatible Skill 的稳定 source、name 与截断后的 description，不包含正文或本地路径。
模型判断某个 Skill 适用时，使用目录中的 exact `source + name` 调用 `skills-read`；该工具通过
`SkillRuntime` 的受控 catalog 完整读取并校验 `SKILL.md`，把正文与 content digest 作为普通工具
结果返回。工具结果进入 durable Turn history，并参与下一次模型调用。

这条模型按需路径不依赖后端 selector：模型负责语义判断，runtime 负责目录边界、enablement、
compatibility、exact identity 与文件安全。它与下一节的受信任 pre-Turn 自动 activation 是并行
入口。手动选择与模型选择复用同一个 catalog/loader，但持久化
形态不同：手动选择在 `TurnAccepted.activated_skills` 中预先冻结；模型选择发生在 tool loop 中，
由 durable Tool Result 保存已读取内容。

`ash-extension-api::ReadOnlyToolContributor` 是通用接入面，`SkillReadTool` 属于
`ash-skills-extension`，App Server 只把 executor 适配到已有 Extension ToolPort 与策略管线。
因此该能力不依赖目录 shell/file tool，也不要求产品端了解 Skill 读取协议。

### 8.3 后端自动 selector（已实现，严格受信任）

当前 selector 在 host 内只接收最多 16 KiB 的当前 Turn 文本和 immutable catalog metadata，不把
catalog 或候选正文写进 prompt。它只考虑 enabled、compatible 且 trust 为 `BuiltInVerified` 的
Skill；user、Directory、Plugin、Marketplace 等来源即使描述匹配也不会自动激活：

```text
enabled catalog
→ compatibility/source/policy filter
→ name/description 与有界用户文本的 deterministic score
→ 唯一高置信候选，否则不选择
→ freeze pinned SkillRef
→ load exact SKILL.md and persist automatic reason
```

当前实现是可测试的 lexical matcher，不做 embedding、网络检索或模型调用。显式 Skill 先解析，
selector 会排除其 exact `SkillId`；每个 Turn 最多自动加入一个 Skill。catalog generation、正文
digest 与 `Automatic` reason 和显式 activation 一样进入 durable `TurnAccepted`。

规则：

- `description` 是唯一 startup selection text；
- 低置信度时不自动激活；
- 自动 Skill 数量有上限；
- 互斥或顺序依赖在没有 accepted contract 前不通过自由文本猜测；
- 只有 exact body 成功读取并冻结后才记录为“已激活”；候选分数本身不是 activation；
- 用户明确说不使用某 Skill 时，当前 Turn 不得重新自动加入；
- Skill 不能通过 description 要求自己在所有任务激活。

## 9. 激活与渐进加载

[Agent Skills progressive disclosure](https://agentskills.io/specification#progressive-disclosure)
分三层：

| Level | 内容 | 加载时机 |
| --- | --- | --- |
| Metadata | name + description + source/compatibility | catalog/selection |
| Instructions | 完整 `SKILL.md` body | Skill 激活 |
| Resources | references/scripts/assets | 指令明确需要且 Agent 决定读取 |

激活流程：

```text
resolve exact SkillId + version selector
→ open file relative to immutable/validated source root
→ revalidate frontmatter and digest
→ read complete bounded SKILL.md
→ parse referenced-path inventory
→ build instruction fragment with provenance
→ publish SkillActivationSnapshot
```

```rust
pub struct SkillActivationSnapshot {
    pub id: SkillId,
    pub source: SkillSourceView,
    pub content_digest: ContentDigest,
    pub catalog_generation: u64,
    pub instructions: String,
    pub root: SkillRootHandle,
    pub diagnostics: Vec<SkillDiagnostic>,
}
```

snapshot 对一次 model invocation 不可变。Skill 文件变化只使 catalog stale；已经开始的调用仍使用
旧 bytes/digest。下一个 model safe point 重新解析，并在 pinned mismatch 时要求用户决定。

## 10. 上下文分层

Core ContextAssembler 使用明确层级：

```text
1. system safety / platform policy
2. Ash developer/product instructions
3. directory policy and active Turn constraints
4. Skill instructions（带 source + digest 边界）
5. user input
6. retrieved references/resources/tool results（不可信数据）
```

Skill 不能把自己声明为更高层。多个 Skill 的顺序由 activation controller 确定并记录，不依赖
filesystem enumeration order。

每个 instruction fragment 包含：

- exact Skill ID；
- source kind；
- digest；
- bounded body；
- `Required / BestEffort` context retention。

catalog generation、activation reason、`$` selector 等入口信息留在 durable provenance 和外部
selection/runtime，不写入模型可见 Skill 正文。外部 adapter 负责把具体选择策略映射为
`Required / BestEffort`；Core 不解释 Skill 是显式还是自动选中的。

Core ContextAssembler 应用总 token budget。超限时：

1. 不截断 frontmatter 与 body 到无法解释；
2. 优先减少自动 Skill 数；
3. 显式 Skill 仍超限则返回可见错误或要求用户选择；
4. references 不预载；
5. 不能把被截断的 Skill 标成完整激活。

## 11. 参考资料、脚本与资源

### 11.1 文件解析器

当前 package 文件通过 `SkillCatalog::read_resource` 和 `SkillResourcePath` 的 rooted contract；
它绑定 pinned `SKILL.md` digest，允许 Skill root 下非空无 traversal 的相对路径，拒绝 symlink、
hard link、special file、越界路径和超过 256 KiB 的内容，并返回原始 bytes 与内容摘要。
`SkillResourceKind` 只标识 reference/script/asset 等用途，不切换 resolver，也不授予执行权限。

跨 host/provider 抽象仍可使用同一读取语义：

```rust
/// Resolves bounded, read-only files beneath one validated Skill root.
///
/// Implementations must reject absolute paths, traversal, escaping links, special files and
/// content that exceeds the supplied limit. A returned file must retain its digest and provenance.
pub trait SkillFileResolver: Send + Sync {
    fn read(
        &self,
        request: SkillFileReadRequest,
    ) -> impl Future<Output = Result<SkillFile, SkillFileError>> + Send;
}
```

request 使用 `SkillResourcePath`、`SkillResourceKind` 和具名 size policy，不使用 raw `PathBuf` 或
`allow_large: bool`。

相对路径始终从 Skill package root 解析，调用方传完整路径，例如 `references/api.md` 或
`scripts/check.py`。当前每次调用只读一个文件，不递归展开文件中的链接，因此不会产生 runtime
resource cycle。未来若增加自动递归解析，必须再引入明确 depth budget 和 visited-set。

### 11.2 参考资料

- 作为不可信 data/context 读取，不提升 instruction precedence；
- 只有当前任务需要时加载；
- lower layer 保留相对 path、kind、digest 与 bytes；模型工具只接受 UTF-8 text；
- Markdown 中的外部 URL 不自动 fetch；
- reference 再引用的文件必须由模型再次显式调用统一的 `skills-read` resource target；
- 超大表格/文档通过 Resource store 分块，而不是塞入单个 model message。

### 11.3 脚本

`scripts/` 中存在文件不代表它可执行。Skill manager 只返回 file metadata/handle。

执行必须：

```text
Skill instruction suggests script
→ resolve exact script under Skill root
→ materialize command without shell concatenation
→ evaluate Plugin/source trust and executable grant
→ approval + sandbox + resource limits
→ ash-tool-executor
→ durable Tool Call/Result
```

独立 user/directory Skill 默认没有 Plugin activation grant。用户可以显式通过普通 exec tool 运行
已审阅脚本，但仍遵守 directory sandbox。`allowed-tools` 是 Agent Skills experimental field，
只能作为作者意图/兼容性提示，不能跳过 Ash approval。

Skill manager 绝不自动执行：

- dependency installer；
- `postinstall` / `setup` / shell hook；
- 网络下载器；
- 脚本用来“探测 compatibility”；
- 首次激活 callback。

### 11.4 资源

Assets 是模板、图片或静态数据：

- 不自动加入 context；
- 按 MIME/size/digest 读取；
- 写入目录时必须通过对应 tool 和 approval；
- 模板展开后的结果是新 artifact，不反向修改 immutable Skill；
- HTML/SVG 等 active content 在 UI preview 中必须 sanitize/sandbox。

当前 App Server 的 `skill/resource/open` 要求 exact `SkillId + SKILL.md digest + package-relative
path`，重新经过 `SkillRuntime::read_resource` 的 enablement、compatibility、root containment 与
digest 校验，再把 bytes 写入 connection-owned `ResourceStore`。PNG/JPEG/GIF/WebP/PDF 只有在扩展名
与文件签名同时匹配时才投影对应 MIME；HTML/SVG 强制投影为 `application/octet-stream`。客户端随后
沿用 `resource/metadata`、`resource/read` 与 `resource/release`，不能从该接口执行 script 或写回
Skill package。Renderer 的 sandboxed/sanitized preview 仍未实现。

## 12. 兼容性

Agent Skills `compatibility` 是自由文本，不能作为 machine-enforced permission。Ash 处理为：

```text
Compatible
Incompatible { reason }
Unknown { warning }
RequiresUserAction { requirements }
```

BuiltIn/Plugin Skill 可以由受控 manifest contribution 提供额外 machine-readable requirement：

```text
required Ash version
required tool capability
required MCP contribution ID
required platform/architecture
required package-relative asset
```

这些 requirement 由 Plugin/Skill resolver 校验，不能藏在 Markdown 并在运行时自动安装。

如果 Skill 依赖某 MCP tool：

- dependency 指向 stable namespaced contribution ID，不指向 model-facing alias；
- MCP server unavailable 时 Skill 可以 `Blocked` 或按 manifest 明确声明 `Degraded`；
- 不能通过 tool name 字符串碰撞绑定到另一个 Plugin/server；
- Skill 激活 snapshot 和 MCP tool catalog snapshot 必须在同一 App Server composition generation
  中解析。

## 13. 信任、prompt injection 与数据安全

Skill instructions 可能恶意或被供应链篡改。所有来源都需要 provenance：

```text
BuiltInVerified
SignedPlugin { publisher, digest }
UnsignedLocalDevelopment
UserManaged
DirectoryManaged
```

trust label 不改变 instruction precedence。即使 BuiltIn Skill 也不能绕过 platform safety。

必须防御：

- frontmatter/YAML alias 或 parser resource exhaustion；
- Markdown/HTML active content；
- path traversal、absolute path、symlink/hardlink escape；
- reference cycle 和 recursive expansion；
- oversized body/file/tree；
- Skill 名称 Unicode/confusable collision；
- directory repository 提交 Skill 后自动执行；
- 指令要求读取或发送 credential；
- 指令伪造 system/developer message；
- 更新后同 ID 内容改变但 historical/pinned invocation 无提示；
- Skill asset 在 Renderer 中触发 script/network。

默认不把 Skill body、references、scripts 或 assets 写入 telemetry。可记录 ID、source、digest、
activation reason、bytes/token count、duration 和 error code。

## 14. 持久化、恢复与来源

Skill catalog 是可重建 projection，不是 authority。Authority 分布为：

- BuiltIn Skill：Ash release；
- Plugin Skill：Plugin installed/activation authority；
- User/directory Skill：显式 configured source；
- current Turn selection：typed UserInput/command。

Thread history 当前在 `TurnAccepted.activated_skills` 保留显式和 host automatic activation 的 stable
identity、digest、catalog generation 与 reason。模型按需选择不伪造该 pre-Turn activation：
`skills-read` 成功结果仍通过标准 Tool Call/Result 持久化。

无论是否进入 Thread event，每次 model invocation 的 diagnostic/provenance snapshot 都应记录：

```text
SkillId
source
content digest
catalog generation
activation reason
loaded references and digests
effective instruction bytes/token estimate
```

Skill 内容本身不复制进 canonical Thread snapshot。Historical display 即使 source 已删除，也可依赖
stored identity/digest；重新执行必须重新授权/解析，不能假定旧 path 仍安全。

## 15. App Server API 与客户端

| Method | 语义 | 状态 |
| --- | --- | --- |
| `skills/list` | 读取 metadata-only catalog；`refresh` 请求重扫 | ✅ 已实现 |
| `skill/enablement/set` | 按 exact `SkillId` 修改 future eligibility | ✅ 已实现 |
| `session/request` StartTurn Skill input | 选择 exact `SkillRef` | ✅ 已实现 |
| `skill/resource/open` | 将 digest-pinned package resource materialize 到 connection-owned Resource store | ✅ 已实现 |
| `skill/read` | 读取 entry metadata/diagnostics，不默认返回完整 body | Proposed |

Skill install/remove 不属于 Skill manager：

- Plugin Skill 通过 Plugin methods 管理；
- user/directory standalone Skill 通过明确的 source/config 或将来 artifact import 管理；
- 客户端不能向 `skill/read` 传 arbitrary filesystem path。

客户端 `$` 候选展示 name 和 description，并在独立管理界面展示 source、version/digest 摘要、compatibility、availability 和 trust。同名 Skill 不静默合并；名称有歧义时不提供无来源限定的 `$name`。Skill 与 `/name` 命令不共享命名空间。自动激活结果在 Turn/status 中可解释，但 UI 不需要显示 Skill 正文。

### 15.1 外部 Agent Skill 导入（仅限 Desktop）

[`external-agent-migration`](../ash-rs/external-agent-migration/README.md) 当前已经能只读发现 Codex 的
`~/.agents/skills`、项目 `.agents/skills`、Claude 的 `~/.claude/skills` 和项目
`.claude/skills`（含 Claude commands 候选），并把 canonical path、来源、scope 与 review
category 放入 `AgentPathInspection`，同时在 `MigrationPlan` 中给出 skill 名称清单；它不读取或
转换 Skill 正文，也不修改 Config。

用户可见的导入工作流只在 Desktop 提供。Desktop 的目录选择、导入预览、冲突确认和撤销入口，
以及 App Server/Config authority 把用户确认结果保存为明确用户 Skill 来源的 apply path 仍是
计划设计。Skill manager 继续拥有来源 containment、格式、摘要和身份校验。

TUI `/skills` 只浏览、启用或禁用 App Server 已发布的统一 catalog。若某个外部来源已经通过
Desktop 导入，其 Skill 可以与其他来源一起出现在 TUI catalog 中；TUI 不提供外部目录发现、
`/add-dir`、`/import-agent`、导入配置 mutation 或用户主目录扫描。

外部导入必须遵守以下边界：

- 只注册用户明确选择的窄 Skill 根，不开放整个 `~/.codex`、`~/.claude` 或用户主目录；
- 不读取或导入认证文件、凭据、日志与历史记录，`~/.codex/auth.json` 明确排除；
- Claude 的 `~/.claude.json` 同时包含 OAuth session、MCP、per-project state 和 cache，当前
  整体排除；
- 保留外部 Agent 类型、规范化来源根和内容摘要，不能把外部 Skill 冒充 built-in 或 directory
  来源；
- 导入来源必须可查询、禁用和移除，移除后不能继续激活其中的 Skill；
- 导入只建立只读内容来源，不授予脚本执行、网络、凭据或沙箱绕过能力。

外部路径发现和导入计划由 `external-agent-migration` 拥有，来源注册与内容解析仍属于 Config/Skill
边界，不属于通用 `utils`；只有不理解外部 Agent 格式的路径规范化、目录 containment 和文件
identity 原语可以下沉到已有基础 crate。Desktop 交互所有权与其他外部配置类型的映射见
[`ash-desktop-architecture.md`](ash-desktop-architecture.md#22-外部-agent-配置导入仅限-desktop)；
TUI 当前不提供外部 Agent 导入入口；Ash Code 的公共边界以其[API 入口](../ash-code/README.md)为准。

目录贡献不是 Import。`ash-file-access` 拥有目录来源与能力契约；只有带 `DiscoverSkills` 的有效 Grant 才能发现 Skill。该发现可以复用 `external-agent-migration` 的安全路径检查，但不写入 Config、不产生 imported source，也不改变 `cwd`。完整语义见 [`environment-access.md`](environment-access.md#5-来源权限取代目录-trust)。

## 16. 错误与诊断

至少区分：

```text
SourceUnavailable
SkillNotFound
SkillAmbiguous
InvalidFrontmatter
InvalidSkillName
DescriptionInvalid
PathEscapesRoot
UnsupportedFileType
ContentTooLarge
ReferenceCycle
ContentChanged
Incompatible
DependencyUnavailable
PermissionRequired
CatalogStale
```

错误携带安全的 Skill/source identity 和相对 path；不返回 host private absolute root、Skill 正文
或 secret。diagnostic 必须能解释为什么 Skill 没被发现、没被选择、没被激活或只处于 degraded。

## 17. 性能与预算

建议第一版本地上限作为 Ash policy，而不是 Agent Skills 标准：

| 项目 | 初始 policy |
| --- | --- |
| 每 source Skill 数 | 有界，超限产生 source diagnostic |
| frontmatter bytes | 小型固定上限 |
| `SKILL.md` bytes | 与 context budget 联动，硬上限独立存在 |
| 模型可读取的 Skill 正文 | 由正常 Tool Result 与上下文预算约束 |
| reference depth | 1 为推荐，硬上限不超过少量层级 |
| loaded reference bytes | per invocation 总预算 |
| file count/tree depth | 防目录/归档资源耗尽 |

具体数值在实现 benchmark 和真实 Skill corpus 后固定到 policy/config。测试注入 tokenizer estimator
和 fake filesystem，不依赖真实 home directory。

## 18. 目标目录

```text
ash-rs/skills/src/
├── lib.rs
├── identity.rs
├── source.rs
├── format/
│   ├── mod.rs
│   ├── frontmatter.rs
│   └── validation.rs
├── catalog/
│   ├── mod.rs
│   ├── scanner.rs
│   ├── entry.rs
│   └── snapshot.rs
├── selection/
│   ├── mod.rs
│   ├── explicit.rs
│   └── automatic.rs
├── activation/
│   ├── mod.rs
│   ├── loader.rs
│   ├── resolver.rs
│   └── snapshot.rs
├── compatibility.rs
├── diagnostic.rs
├── error.rs
└── *_tests.rs
```

不建立同时负责 Plugin/MCP/Skill 的 `extensions` 巨型 crate。实现模块超过约 500 LoC 时按
catalog/selection/activation 拆分；新 trait 必须有职责和实现约束 doc comment；新测试模块使用
显式 sibling `#[path = "..._tests.rs"]`。

## 19. 分阶段实施

### 阶段 S0：format、目录与运行时 browser（当前状态）

- Agent Skills frontmatter/parser/validator；
- BuiltIn + controlled user + Directory source；
- metadata-only scan、digest 和 immutable catalog；
- path/size/cycle security fixtures；
- App Server `skills/list`、`skills/changed` 与 watcher refresh；
- durable per-Skill enablement overlay 和 TUI catalog browser/toggle。

完成条件：启动不会加载所有 Skill body，坏 entry 不会逃出 root 或拖垮整个 catalog；source
变化与 enablement 变化只发布新的 metadata projection。

### 阶段 S1：显式选择纵向切片（核心、TUI 与 Desktop 已实现）

- `SkillRef`/version contract 与 raw path rejection；
- 激活时完整、安全地加载 `SKILL.md` 并冻结 digest；
- `TurnAccepted` durable provenance 与 recovery fail-closed；
- Core ContextAssembler layering、budget 和 provenance；
- App Server/generated contract，以及 TUI/Desktop 独立 `$name` Skill selector；
- TUI `/skills` 目录管理和 enablement mutation。

完成条件：客户端不能通过 raw path 激活 catalog 外文件，已开始 invocation 使用 frozen digest。

当前限制：同名 Skill 不提供无歧义的 `$name`；调用这类 Skill 需要未来带来源限定的选择交互。与 local/server command 同名不影响 `$name` 选择。CLI 的 `/skills` 提供目录管理，但当前 `$` 候选本身不展示来源限定；typed protocol 入口不受影响。

### 阶段 S1.5：模型按需读取（当前状态）

- 每个模型 safe point 注入 metadata-only `<available-skills>`，固定上限 8 KiB；
- `ReadOnlyToolContributor` 把 `skills-read` 接入共享 Tool registry/policy/runtime；
- exact source/name、enablement、compatibility 与 content digest 由 `SkillRuntime` 校验；
- 成功读取通过标准 durable Tool Call/Result 进入下一次模型调用；
- 同一个 `skills-read` 使用 tagged target 区分完整说明与 package resource；resource target 必须提交
  exact source/name + pinned Skill digest 和完整 package-relative path；
- 模型选择不被伪装为 pre-Turn activation；受信任 automatic selector 是独立、可解释入口。

完成条件：模型只看到目录元数据，正文必须经 exact read 才进入上下文；只有具备
`DiscoverSkills` 的目录才参与发现，且 App Server 不拥有 Skill 选择或文件加载逻辑。

### 阶段 S1.6：可信自动 selector（当前状态）

- 只使用 immutable metadata 与有界 Turn 文本；
- 只允许 `BuiltInVerified`、enabled、compatible 候选；
- 唯一高置信才冻结 pinned `SkillRef`，歧义时不激活；
- exact body 加载后持久化 digest、generation 与 `Automatic` reason；
- 显式选择优先并从自动候选中排除。

完成条件：catalog 增长不加载更多正文或线性扩写 selector prompt，任何非可信 Skill 都不能仅凭
description 获得自动 activation。

### 阶段 S2：资源与脚本（资源读取、文本切片与 binary materialization 已实现）

- ✅ rooted package resource reader、kind/digest/bytes 与统一模型工具接入；
- ✅ 模型工具只把 UTF-8 资源作为文本返回，binary asset 明确拒绝注入文本上下文；
- ✅ assets 的安全 MIME 投影与 connection-owned Resource integration；
- Renderer 的 sanitized/sandboxed preview；
- scripts 只通过 exec/tool/approval/sandbox；
- reference cycle、MIME 和 active-content policy。

完成条件：读取 Skill 不产生副作用，运行脚本一定产生标准 durable Tool Call/Result。

### 阶段 S3：包来源与 MCP 依赖（Marketplace/Plugin 来源纵向切片已完成）

- ✅ Marketplace Skill exact source、独立 provenance 与 Manager generation refresh；
- ✅ Plugin Skill exact source；
- ✅ Plugin activation generation 触发 catalog composition refresh；
- machine-readable MCP/tool requirements；
- Plugin Skill update/disable 的 frozen Turn snapshot drain 仍需专项验证。

完成条件：Skill 不能按名称碰撞绑定错误工具，Plugin update 不改变 in-flight invocation。

### 阶段 S4：大目录候选检索

- 仅在元数据目录规模需要时增加 bounded lexical retrieval；
- threshold、ambiguity 和 explicit opt-out；
- 候选解释与 quality evaluation；
- 检索只缩小模型可见目录，不直接激活 Skill；有证据后再评审 embedding retrieval。

完成条件：候选检索有稳定离线评测，低置信度时保留“不推荐候选”，context 不随 catalog 数量
线性增长，最终选择仍由模型显式调用 `skills-read`。

## 20. 验证门

除常规 working-tree 检查外，必须覆盖：

- Agent Skills name/description/frontmatter contract；
- YAML/parser resource exhaustion；
- metadata-only startup 与 body lazy load；
- source/name ambiguity 和 deterministic order；
- raw path rejection、traversal、symlink/hardlink 和 normalization collision；
- file change race、digest pin 和 catalog generation；
- explicit selection、auto threshold、opt-out 和 max active Skill；
- instruction precedence 与 prompt injection boundary；
- context/token/bytes budget；
- reference cycle/depth、external URL 不自动 fetch；
- script 不被 loader 执行且必须经过 exec/approval/sandbox；
- Plugin/MCP dependency identity、disable/update/drain；
- schema/telemetry/error 不泄露 Skill 正文、secret 或 private absolute root。
