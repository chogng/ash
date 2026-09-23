# 配置系统

> 本文拥有用户配置、目录配置、作用域合并和运行时生效点。实现见
> [`ash-config`](../ash-rs/config/README.md)。目录能力的长期语义见
> [`environment-access.md`](environment-access.md)。

## 结论

配置表达“期望什么”，领域管理器维护“当前实际可用什么”，App Server 在安全点冻结“这次执行
能使用什么”。三者不能合并成一个状态。

```text
Desired configuration
    User Config + Dir Config + Session/launch inputs

Operational state
    Plugin / MCP / Skill / Hook / provider managers

Runtime snapshot
    App Server freezes one exact generation for a Turn or request
```

目录配置只是来源意图。读取它需要 `LoadConfig`，发现其中的 Skill、MCP、Hook 或 Plugin 还需要
各自的来源能力；目录文件不能给自身增加 capability、绑定凭据、安装包或放宽沙箱。

## 权威分布

| 所有者 | 拥有 | 不拥有 |
| --- | --- | --- |
| User Config | Agent 默认值、Provider、MCP、Skill source、Plugin request、Hook、Tool Search、execution policy、目录权限、Git 自动获取，以及前端自有的 `gui`、`tui` 键值表 | secret、live connection、已安装包、运行健康状态，以及 `gui`、`tui` 字段含义 |
| Dir Config | 目录提供的 Agent/MCP/Skill/Plugin/Hook 意图和只收紧的执行规则 | 授权、凭据、安装、激活和运行状态 |
| Device Settings | TUI/Electron 主题、可访问性、hover、sash 等设备界面偏好 | Rust GUI 编辑器字体、Agent、Provider、目录权限和运行状态 |
| Secret Store | opaque secret bytes | 配置类型、OAuth 流程和作用域决定 |
| 各领域管理器 | 实际安装、连接、激活、健康状态和生命周期 | 用户配置正文 |
| App Server | 组合不可变快照并选择生效点 | 重新拥有各领域状态 |

## 用户配置

`ConfigStore` 使用 `<profile>/config.toml` 保存 typed 用户文档，使用 SQLite 保存 revision、generation
和命令回执。修改命令携带 `commandId + expectedRevision`：

- revision 不匹配时拒绝写入；
- 同一命令重放返回原结果；
- TOML 替换和回执提交保持原子；
- 成功提交只影响后续安全点，不改写已经冻结的 Turn。

`config.toml` 顶层使用 `schemaVersion` 标记文件格式。读取旧版本或无版本的历史文件时，Config 只执行已登记且无歧义的迁移，完成严格校验后原子重写为当前版本；历史字段和当前字段同时出现、未登记字段、过新版本或低于最低支持版本都会拒绝启动。v2 的 `agent.preferredModel`、`agent.preferredReasoningEffort` 会分别迁到 v3 的 `agent.model`、`agent.modelReasoningEffort`。`semanticCodeIndex` 迁到 `codebase` 时不会保留旧的源码外发授权；`workspaceTrust` 只转换路径仍存在、旧身份与路径一致的 `trusted` 项，并为它生成当前目录身份，其他项不落盘。

用户文档的主要 section 是 `agent`、`gui`、`tui`、`providers`、`mcp`、`skills`、`plugins`、
`hooks`、`toolSearch`、`execPolicy`、`dirPermissions`、`codebase`、`network` 和 `git`。Config 保存非敏感引用，不保存
API key、OAuth token、authorization header 或 refresh 状态。

`[network]` 控制 App Server 内置的模型、鉴权、图片、tokenizer 下载和通话请求。缺省允许所有主机；`allowedHosts` 只接受完整的小写主机名或 IP 地址，不支持通配符。空数组禁止这些出站请求。修改文件后，App Server 会热更新策略，让被收紧策略拦住的 HTTP 调用返回错误，并结束对应的 WebSocket 与通话会话。命令执行的网络审批仍由 `execPolicy` 管理。

```toml
[network]
allowedHosts = ["api.openai.com", "github.com"]
```

Git 自动获取由 App Server 对已授权可修改的仓库逐个调度，Desktop、Rust GUI 和 TUI 共用一份 `[git]` 配置。默认关闭；`autofetch` 可设为 `"off"`、`"default"` 或 `"all"`，`autofetchPeriod` 是 1–86400 秒，默认 180 秒：

```toml
[git]
autofetch = "default"
autofetchPeriod = 180
```

Desktop 旧的 `git.autofetch` 和 `git.autofetchPeriod` 设备设置只用于一次性迁移，后续通过 `config/read` 和 `config/update` 读写 `[git]`。

图形界面的主题选择和编辑器排版由图形界面解释根级 `[gui]`：

```toml
[gui]
theme = "system"
interfaceFontFamily = "sans-serif"
interfaceFontSize = 13
editorFontFamily = "monospace"
editorFontSize = 13
editorLineHeight = 20
```

`theme` 使用内置主题入口、用户主题 ID 或 `system`。`interfaceFontFamily` 和 `interfaceFontSize` 控制 Workbench 导航和设置页等界面文字；`editorFontFamily`、`editorFontSize` 和 `editorLineHeight` 只控制编辑器。字体族可用 `monospace`、`sans-serif`、`serif` 或具体字体名称，字号范围为 6–96 px，编辑器行高不能小于字号且不能超过 192 px。这些默认值、校验和生效方式都属于图形界面，不进入 Config 或 App Server 的领域类型。

TUI 独立解释根级 `[tui]`，其中保存主题、屏幕模式、输入模式等界面设置；字段含义和交互见 [TUI 配置说明](../ash-code/tui/README.md#终端生命周期)：

```toml
[tui]
theme = "ash-code-dark"
screenMode = "fullscreen"
inputMode = "standard"
```

Config 和 App Server 将 `[gui]`、`[tui]` 作为不透明键值表保存，不校验字段含义。更新任一表时，
前端必须先读取当前值、保留自己不认识的键，再携带 `expectedRevision` 替换完整表；两个表彼此独立。

## 供应商默认模型

主 Agent 使用 `[agent.model]` 中的 `provider`、`model` 选择模型；可选的 `[agent] modelReasoningEffort` 指定推理强度，缺失时使用模型目录默认值。审批审查和提交说明分别使用独立的 `approvalReviewModel`、`commitMessageModel`。

保存供应商配置时，若 `agent.model` 尚未设置，Config 从内置模型目录中选取该供应商
首个 `ProviderApi` 模型，并与供应商配置一起持久化。已有选择保持不变，包括新增其他供应商时。
没有内置 API 模型的连接不生成模型 ID。保存过程不请求模型列表，也不验证远端调用权限。
重新保存旧连接可以补齐缺失选择；目录顺序后续变化不会改写已经保存的模型。

## 目录配置

`DirConfigStore` 严格读取一个目录中的 `.ash/config.toml`。Host 在文档之外提供 `DirId` 与内容
revision；文件不能选择自己的身份或 generation。目录文件中的 Agent 字段同样使用 `model` 和 `modelReasoningEffort`；旧字段需要由目录文件所有者改名，读取过程不会修改受版本控制的目录文件。

```rust
pub struct DirConfigDocument {
    pub agent: DirAgentConfig,
    pub mcp: DirMcpConfig,
    pub plugin_requests: DirPluginRequests,
    pub skills: DirSkillsConfig,
    pub hooks: HooksConfig,
    pub exec_policy: DirExecPolicyConfig,
}
```

目录声明使用 `dir:<dir-id>:` namespace。它可以请求 Provider 已存在时的模型默认值、无凭据的 MCP
声明、Skill source、Plugin package、Hook 和执行约束，但不能：

- 写入 User Config；
- 给目录增加 capability；
- 选择 credential；
- 安装或启用 Plugin；
- 建立 MCP 连接；
- 执行 Hook；
- 使用 `AllowUnsandboxed` 放宽执行策略。

## 目录权限

`DirPermissionsConfig` 按 `DirId` 保存明确的 `Capability` 集合。缺失条目表示没有持久授权；系统不
保存 `Trusted / Restricted` 或目录级 Trust。

```text
config/dirPermissions/list
config/dirPermissions/read
config/dirPermissions/set
config/dirPermissions/forget
```

`set` 接受完整 capability 集合，而不是一个 `trusted` 布尔值。App Server 将配置解析为 `Grant`，
动作入口再为具体 Permission 取得 `Authorization`。Config 不签发 Authorization，也不执行动作。

## 合并与来源

```text
BuiltInDefaults
  + UserConfig
  + DirConfig
  + SessionSettings
  + LaunchOverrides
  constrained by SystemRequirements
  = ResolvedConfigSnapshot
```

这不是递归对象合并。每个字段必须明确来源、merge/replace/clear 语义、provenance 和生效点。

| 配置 | 来源 | 关键规则 |
| --- | --- | --- |
| Agent model | User、Dir、Session、launch | 只影响下一次模型安全点 |
| Tool Mode | User、StartTurn override | Turn 接受时冻结 |
| Provider endpoint | User、Host | Dir 不能替换认证或网络边界 |
| MCP / Skill / Plugin / Hook | User、Dir | Dir 只提供待处理意图；领域管理器决定实际状态 |
| Execution policy | Host、Organization、User、Dir | Dir 只能保持或收紧 |
| Directory permissions | User、Organization、Host | Dir Config 无权自授 |
| Rust GUI theme/editor typography | User | 进入 `config/read`，不参与 Agent Turn 执行 |
| TUI/Electron device preference | Device Settings | 不进入 Agent runtime snapshot |

目录来源未获得对应能力时，解析结果保留其待处理意图和诊断，但不会静默激活。运行时协调失败只
更新实际状态，不回滚用户期望。

## 生效点

| 变化 | 生效时机 |
| --- | --- |
| 模型与 Tool Mode | 下一次模型请求或 Turn 创建 |
| MCP / Skill / Plugin / Hook catalog | 各管理器完成协调后，由新 generation 发布 |
| 目录权限 | 新 Grant 发布后；撤销会使旧 Authorization 失效并停止依赖资源 |
| execution policy | 下一次动作评估；已经准备的调用保留冻结版本 |
| Rust GUI theme/editor typography | Workbench 收到新 config generation 后重建完整样式 |
| TUI/Electron device preference | 对应 Renderer 服务自己的更新周期 |

运行中的 Turn 不读取可变 ConfigStore，也不持有 live manager。它只消费创建时冻结的快照和后续
明确允许的安全点更新。

## 文件与接口

```text
<profile>/
├─ config.toml
└─ state.sqlite3

<dir>/.ash/config.toml
```

公共类型使用 `DirConfigDocument`、`DirPermissionsConfig` 等完整名称，因为它们跨模块表达具体配置
种类。进入 `dir_config.rs` 或目录权限模块后，私有变量使用 `dir`、`permissions`、`revision`，不再
重复 `directory_configuration` 一类上下文限定词。

## 不变量

- 一个 scope 内同一份期望状态只有一个 authority。
- 配置提交成功不等于 Plugin 已激活、MCP 已连接、Skill 已可用或 Hook 已执行。
- 目录配置不能扩大 capability、credential scope、policy 或 sandbox。
- Secret 不进入 TOML、日志、索引或协议快照。
- 已冻结的 Turn 不随可变配置漂移。
- Config 使用 `Dir` 与明确权限，不重新引入 Workspace 身份或目录级 Trust。
- 配置迁移必须先完成完整校验再替换原文件；失败时保留原文件并阻止运行时启动。
