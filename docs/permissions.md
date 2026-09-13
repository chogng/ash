# 权限系统

> 文档所有权：本文件是 Ash 权限系统产品语义、用户心智模型、跨 crate 执行路径和长期
> 不变量的权威文档。
>
> 文档状态：当前契约 + 明确的当前限制 + 计划演进。
> Agent 自定义 artifact、外部 Import 与只读 source registration 的领域边界见
> [`agent-customizations.md`](agent-customizations.md)。

## 快速理解

Ash 使用分层权限系统来平衡功能和安全性：能在明确沙箱边界内完成的动作优先受限执行；需要越过
边界的动作再结合用户意图、风险和已有授权决定是自动批准、询问用户还是阻止。

| 工具类型 | 示例 | 需要批准 | 批准后的行为 |
| --- | --- | --- | --- |
| 目录只读 | 读取文件、搜索、`Grep` | 通常不需要；前提是路径在允许范围内并可使用只读沙箱 `ReadOnly` | 不适用 |
| 目录文件修改 | `Edit`、`Write`、创建或移动文件 | 在目录可写沙箱 `DirectoryWrite` 和允许写入范围内通常不需要；越过范围时需要重新判断 | 如果询问，只批准当前调用 |
| 本地命令 | `cargo test`、`git status`、Shell 执行 | 可在匹配的沙箱策略中运行时不需要；必须在沙箱外执行且无法自动授权时需要 | 只批准当前工具调用 |
| 网络访问 | 下载依赖、HTTP 请求、访问远端 API | 需要显式网络能力 `Network`；当前意图或目标作用范围不足以授权时需要 | 只批准当前动作和网络作用范围 |
| 凭证与外部修改 | 使用令牌（token）、`git push`、创建 PR、修改云资源 | 根据用户意图和风险判断；极高风险直接阻止，不向用户请求放行 | 只批准当前动作、凭证用途和目标资源 |
| 系统与界面控制 | 修改系统配置、控制浏览器或桌面 UI | 沙箱无法覆盖且没有足够执行授权时需要 | 只批准当前动作和能力集合 |

批准交互当前仍只有一次性 `ApproveOnce`，不会因历史点击自动升级。长期规则是另一条显式配置
路径：User Config 可以持久化 typed execution-policy rule；Directory 配置只能增加拒绝、强制沙箱
或强制审批等限制，不能给自己授予沙箱外执行权。当前还没有把规则编辑器包装成“此项目始终允许”
的批准按钮。

### 核心规则

| 规则 | 含义 |
| --- | --- |
| 授权单位 | 对一次已经解析清楚的具体动作授权，不对整个工具全局放行 |
| 判断输入 | 动作、来源、最小能力、作用范围、沙箱兼容性、用户意图和风险 |
| 用户决定 | 一次性批准 `ApproveOnce`、拒绝 `Decline`，或通过配置保存精确 digest 规则 |
| 一次性绑定 | 批准请求、工具调用、动作摘要、完整能力集合和策略版本 |
| 安全原则 | 可以减少无效询问，但不能用模糊匹配、模型自信或历史点击替代精确授权 |

### 四个不能混用的安全概念

| 概念 | 回答的问题 | 生命周期 |
| --- | --- | --- |
| `Permission` | 哪一种目录动作可以被授予？ | 稳定的动作类别 |
| `Grant` | 哪个主体在什么目录范围内获得了哪些 Permission？ | 可撤销，可来自用户、组织或主机配置 |
| `ApprovalRequest` | 当前缺少授权时，需要向用户询问什么？ | 一次交互；批准后仍须建立精确 Grant 或一次性执行授权 |
| `AuthorizationDecision` | 当前这个具体动作允许还是拒绝？ | 单次检查结果，不持久化 |

`Permit` 不作为领域对象。目录检查在 Rust 中返回
`Result<Authorization, PermissionDenied>`；允许值只是从检查入口传给当前操作的临时证明，撤销
Grant 后立即失效。

本文后续的 `Capability` 指动作策略使用的“类型 + 作用范围”，例如网络目标或进程启动参数；目录
访问层的稳定动作种类使用 `Permission`。两者可以在动作解析时映射，但不能因为英文相近而共用
一个含糊类型。

### 每个 Turn 的交互模式

TUI 当前在 footer 最左侧显示并用 Shift-Tab 循环三种模式。模式在提交时冻结到
`TurnAccepted`，所以运行中切换只影响后续 Turn，包括排队的 follow-up。

| Footer 文案 | 模式 | authoritative policy 返回 `AskUser` 时 |
| --- | --- | --- |
| `ask permissions on` | `AskPermissions` | 创建 durable approval，由用户 approve once 或 decline |
| `auto review on` | `AutoReview` | 调用配置的审查模型，再由 `ActionPolicyEngine` 应用风险与授权矩阵；模型不可用或失败时继续询问用户 |
| `bypass permissions on` | `BypassPermissions` | 跳过这次交互并签发精确绑定的 bypass authority |

`BypassPermissions` 不是关闭全部安全检查。base policy 始终先运行；确定性 `Block`、策略版本不匹配、
无效 action/capability binding、沙箱硬约束和 policy error 都不会被改写。bypass authority 仍绑定
当前 action digest、完整 capability set、policy revision 和 exact Tool Call，并在副作用开始前
durable 记录。

### 系统内部如何表达

上表描述用户行为；系统内部将每次判断表示为以下类型化结果：

| 系统结果 | 用户含义 | 谁拥有最终决定 |
| --- | --- | --- |
| `RunSandboxed` | 在明确的文件系统和网络限制中执行 | 确定性策略 |
| `RunExecPolicyGranted` | 命中显式 `AllowUnsandboxed` 规则；authority 精确绑定 rule、exec-policy revision、动作与能力 | `ash-execpolicy` 求值，`ActionPolicyEngine` 签发最终 grant |
| `RunAutoReviewed` | 不适用沙箱或需要额外能力，但上下文风险满足自动授权条件 | 策略引擎 `ActionPolicyEngine`；风险审查器只提供建议 |
| `RunUnsandboxed` | 使用已有的精确用户授权执行 | 用户授权 + `ActionPolicyEngine` 精确匹配 |
| `RunWithPermissionBypass` | 当前 Turn 选择跳过本来需要的交互，但仍保留精确绑定与审计 | 可信产品 policy adapter；只能替换 `AskUser` |
| `AskUser` | 缺少足够、明确的执行授权 | 用户 |
| `ReviseAction` | 当前动作过宽，Agent 应提出更小、更安全的动作 | `ActionPolicyEngine` |
| `Block` | 命中确定性禁令、极高风险、审查失败或沙箱硬约束 | 确定性策略 |

`AskUser` 不是异常，也不等于系统“不够聪明”。它表示当前上下文不足以安全地替用户作决定。

## 权限不是一个开关

权限系统由六层相互独立的约束组成：

| 层 | 解决的问题 | 不负责什么 |
| --- | --- | --- |
| 动作解析 | 把工具参数、工作目录、解析后的路径、环境和来源变成精确动作 | 不批准执行 |
| 能力模型 | 描述动作需要的最小能力与作用范围 | 不判断用户意图 |
| 确定性规则 | `ash-execpolicy` 组合 Host / Organization / User / Directory layer 并返回纯 effect | 不签发 grant、不执行工具 |
| 最终 action policy | `ash-action-policy` 把 rule effect、exact grants、sandbox 与 reviewer 结果合成最终决定 | 不解析或持久化规则、不执行工具 |
| Auto Review | 根据标明信任来源的上下文给出风险建议 | 不能签发最终执行授权 |
| 持久化批准与执行 | `ConfigStore` 保存精确用户规则；Core 保存一次性批准和副作用起点 | 不改变前面的安全判断 |

因此：

- 沙箱负责**强制执行边界**，不负责用户批准；
- Auto Review 是**风险审查建议层**，不是第二套权限系统；
- 批准界面负责**取得用户授权**，不是策略引擎；
- 工具或 MCP 服务器声称“只读”只能作为证据，不能成为执行授权；
- Skill 的 `allowed-tools` 是提示，不是权限；
- Plugin 声明的权限、Plugin 安装授权和单次工具调用批准是三个不同层次。

## 识别哪些能力

当前能力类型 `CapabilityKind` 定义八类能力。真正参与授权匹配的是“类型 + 作用范围”，不只是
下表中的名称。

| 能力 | 典型动作 | 需要特别说明的作用范围 |
| --- | --- | --- |
| 文件读取 `FileRead` | 读取文件、搜索内容 | 目录、文件集合、是否越过授权目录 |
| 文件写入 `FileWrite` | 创建、编辑、删除或移动文件 | 精确路径、可写根、破坏性范围 |
| 启动进程 `ProcessSpawn` | 启动本地程序或 Shell 命令 | 可执行文件、参数、工作目录和环境变量 |
| 网络访问 `Network` | HTTP、下载、远端连接 | 主机、协议、端口、请求范围 |
| 使用凭证 `CredentialUse` | 使用令牌、账号或密钥 | 凭证标识、目标服务、用途 |
| 外部修改 `ExternalMutation` | 修改 GitHub、Linear、云资源等外部状态 | 服务、资源标识、操作类型 |
| 系统配置 `SystemConfiguration` | 修改系统级设置或安装环境 | 系统资源、变更范围、恢复方式 |
| 用户界面 `UserInterface` | 控制浏览器或桌面界面 | 应用、页面、交互目标 |

能力集合必须是完成动作所需的最小集合。把多个未来可能需要的能力预先合并，会扩大授权范围，也会
让批准说明失真。

## 一次动作如何获得执行权

当前权威决策顺序如下：

```text
Agent 提出工具调用
  → 主机解析精确动作、来源、能力集合和沙箱兼容性
  → ash-execpolicy：按 typed selector 求值 Host / Organization / User / Directory rules
  → ActionPolicyEngine：映射 Deny / RequireSandbox / RequireApproval / AllowUnsandboxed
  → AllowUnsandboxed：签发绑定 rule、exec-policy revision、动作与能力的 RunExecPolicyGranted
  → 精确用户授权：匹配动作摘要、能力集合和策略版本
  → 可用沙箱：RunSandboxed
  → Auto Review：Approve / ReviseAction / AskUser / Deny
  → 策略引擎 ActionPolicyEngine：RunAutoReviewed / ReviseAction / AskUser / Block
  → Core 持久化记录执行授权与 ToolExecutionStarted
  → 执行器按 Sandboxed 或 Unrestricted 授权执行
  → 持久记录确定结果
```

顺序本身就是安全契约：

1. 更严格 effect 始终胜出；Directory layer 不能产生 `AllowUnsandboxed`；
2. historical exact grant 必须精确匹配，不能按工具名称、命令前缀或自然语言摘要复用；typed
   command-prefix rule 则是独立、显式、带 revision 的 policy 对象；
3. 风险审查器不能构造自动审查授权 `AutoReviewGrant`；
4. 执行器只消费显式的沙箱授权 `Sandboxed(policy)` 或无限制授权 `Unrestricted`；
5. 沙箱启动失败不得静默降级为无限制执行。

## 用户批准到底批准了什么

当前协议的即时用户决定仍只有两种；持久化规则是独立的 Config authority，不会改变 `ApproveOnce`：

| 决定 | 当前语义 |
| --- | --- |
| 一次性批准 `ApproveOnce` | 允许当前批准请求对应的当前工具调用执行一次 |
| 拒绝 `Decline` | 拒绝当前请求；原工具调用以明确失败结束 |

一次性授权绑定以下标识：

- `RequestId`；
- `ToolCallId`；
- 主机规范化后生成的动作摘要 `ActionDigest`；
- 完整 `CapabilitySet`；
- `ActionPolicyRevision`。

恢复中的批准也必须重新匹配准备执行的动作。只要路径、参数、环境、来源、能力集合或策略
版本发生安全相关变化，就不能沿用旧批准。

### 长期规则与一次性批准必须分开

当前已实现 User rule 的 typed 持久化、command prefix/network/capability/source/action selector、
Host/Organization/User/Directory layer composition、semantic revision 和运行时重组。仍未实现：

- “本次会话始终允许”；
- “此项目始终允许”；
- approval UI 中的“保存为长期规则”；
- rule 到期时间和统一规则管理 UI；
- Organization layer 的产品级远端分发 adapter；
- 由 Agent 自行把一次批准升级为长期规则。

User rule 可以用 typed source、command prefix、network target 或 capability scope 授权；它不是历史
approval 的模糊复用。Directory rule 只允许收紧。任何规则变更都会产生新的 exec-policy revision，
并进入新的 `ActionPolicyRevision`；旧 Turn 和旧 grant 不会静默获得更宽权限。

这些能力未来即使加入，也必须拥有独立、可审计的作用范围和撤销语义，不能改变
`ApproveOnce` 的含义。

### 受控内容来源不是长期执行批准

Desktop 外部 Agent 配置导入计划允许用户把明确选择的 Codex `~/.agents/skills`、Claude
`~/.claude/skills` 等目录注册为可撤销的只读内容来源。当前 `external-agent-migration` 实现已知
路径检查、`AgentPathInspection` 和有界源格式解析的 `MigrationPlan`，尚未实现 Desktop 确认与
Config apply。未来
apply 操作产生类型化配置和受控来源身份，不产生按工具、命令前缀或路径模式匹配的执行授权，
因此不属于“是，不再询问”或“此项目始终允许”。

注册后的读取只能发生在经过规范化和 containment 校验的窄来源根内；整个 `~/.codex`、
`~/.claude` 或用户主目录不会因此变成 Agent 可浏览范围，`~/.codex/auth.json` 和包含 OAuth
session/cache 的 `~/.claude.json` 也不会进入当前发现计划。Skill 中的脚本、网络请求或其他
副作用仍按当前动作单独进入权限与沙箱判断。

该导入入口仅由 Desktop 提供；TUI 可以消费 App Server 已发布的统一 Skill catalog，但不能创建
或管理外部来源。完整产品边界见
[`ash-desktop-architecture.md`](ash-desktop-architecture.md#22-外部-agent-配置导入仅限-desktop)
和 [`skills.md`](skills.md#151-外部-agent-skill-导入仅限-desktop)。

## 沙箱在权限系统中的位置

本地执行的沙箱策略由文件授权、文件隔离模型和网络约束组成：

| 文件系统 | 含义 |
| --- | --- |
| 只读 `ReadOnly` | 授权目录只读 |
| 目录可写 `DirectoryWrite` | 授予经过解析和验证的目录写权限 |
| 完全访问 `FullAccess` | 不以目录文件边界约束动作 |

`FileSystemIsolation::Strict` 另要求授权目录外不可写，是 `SandboxPolicy::new` 的默认值。
Windows 本地工具显式选择 `WindowsAccount`：使用独立账户、限制令牌、目录 ACL 和有范围及预算限制的可写路径审计，不承诺整个宿主只读。调用方要求 `Strict` 时，账户后端在安装检查和命令启动前拒绝，不能自动降低隔离要求。
账户模型仍保护授权目录的只读范围、已有元数据和显式隐藏目录；审计发现授权范围外的 Everyone 可写路径时停止启动，报出路径并要求独立处理宿主权限。审计边界见 [`sandboxing.md`](sandboxing.md)。

Windows 本地工具使用 `HostAclChanges::ScopedWithTraversal`：在范围内 ACL 授权之外，允许必要祖先目录的非继承属性查询和遍历权限。祖先目录枚举、文件读取及设备权限不包含在这项授权中，安装账户和网络规则仍走独立清单。

| 网络 | 含义 |
| --- | --- |
| 禁止 `Denied` | 平台后端必须实际阻止网络访问 |
| 允许 `Allowed` | 动作可使用网络；仍不自动获得凭证使用或外部修改授权 |
| 受管 `Managed` | 进程只能连接此次执行的代理端口，每个实际网络请求单独经过规则和审批 |

本地 Shell 配置中出现网络目标、网络动作或 `network` capability selector 时启用受管网络；未配置时仍断网，
`rg` 保持只读断网。代理在 DNS 和连接前调用最终 action policy，`Deny`、`RequireApproval`
与显式允许规则都作用于真实目标。具体配置格式及平台支持见
[`network-proxy`](../ash-rs/network-proxy/README.md)。

运行中的网络审批绑定当前执行、请求序号、目标和策略版本，复用现有持久审批协议。
批准只继续该请求，Shell 及文件系统限制继续有效；拒绝或取消关闭请求，不重跑已经开始的命令。
命令自身获准扩大文件权限也不能移除已配置的受管网络限制。

目录可写策略 `DirectoryWrite` 只是约束描述，不能代替平台强制执行。对于要求受限执行的动作，
后端缺失、不支持所要求的隔离模型或不能实施该模型的约束时必须拒绝启动。

平台后端、支持矩阵和当前限制见 [`sandboxing.md`](sandboxing.md)。

## 沙箱拒绝后为什么不能直接重跑

“命令在沙箱里失败”不能推出“应该在沙箱外再试一次”。失败可能来自参数错误、程序错误、资源
不存在或部分副作用已经发生。

当前只允许一种受控升级路径：

1. 执行器返回类型化的沙箱拒绝结果；
2. 拒绝结果明确标记为可安全重试 `SafeToRetry`；
3. 长度受限的证据回到策略审查；
4. 策略重新判断；
5. 获得新的明确执行授权后，最多进行一次沙箱外重试。

以下情况不得自动重放：

- 普通非零退出；
- 沙箱拒绝前可能已产生副作用；
- 工具已经开始，但崩溃或恢复后结果未知；
- 证据无法证明失败来自沙箱强制执行；
- 新动作与原动作摘要或能力集合不一致。

“不知道是否成功”必须保留为未知执行结果（unknown outcome），而不是假设失败后再次执行。

## 谁负责什么

| 组件 | 当前责任 | 明确不拥有 |
| --- | --- | --- |
| 主机与工具适配器 | 解析精确动作、来源、最小能力和沙箱兼容性 | 最终批准 |
| `ash-execpolicy` | typed selector、layer validation、effect precedence、semantic revision 与纯求值 | 最终 grant、Tool 执行、配置 I/O |
| `ash-action-policy` | effect 映射、exact grant、sandbox、风险门槛和最终类型化结果 | 规则解析/持久化、工具执行、UI |
| `ash-config` | User rule 的 typed TOML mutation/persistence；Directory restriction 的 strict-read intent | 规则求值、最终执行授权 |
| `ash-guardian-reviewer` | 生成受 schema 约束的风险审查结论 | 覆盖策略、签发授权 |
| Core 的 `ToolScheduler` | 持久化批准、一次性授权、执行生命周期和恢复语义 | 操作系统沙箱强制执行 |
| `ash-exec` 与工具执行器 | 消费明确执行授权并返回类型化结果 | 自行提权 |
| `ash-sandboxing` | 统一策略、目录验证与进程生命周期 | 批准、重试和持久化 |
| `mxc-sandbox` | MXC 依赖、平台选择和强制执行 | 动作授权和审批 |
| `ash-network-proxy` | 拦截真实网络请求、检查连接地址、管理执行独立的监听与连接 | 配置持久化、最终批准、文件权限 |
| App Server、CLI 与 Desktop | 暴露权限 CRUD、展示动作、作用范围、风险和用户选择 | 改写权威策略 |

任何一层同时承担“描述动作、判断风险、签发权限、执行副作用”中的多项职责，都会削弱审计边界。

## 当前实现状态

| 能力 | 状态 | 边界 |
| --- | --- | --- |
| 精确绑定动作、能力集合和策略版本 | 当前已实现 | 规范字节的完整性仍依赖主机动作解析器 |
| Host/Organization/User/Directory typed layer 与 semantic revision | 当前已实现 | Organization 的产品分发 adapter 尚未接入 |
| source、command prefix、network、capability、action selector | 当前已实现 | selector 只消费 host-materialized typed fields |
| User rule 持久化与 Directory 只收紧规则 | 当前已实现 | 统一规则编辑 UI、expiry 尚未实现 |
| exec-policy exact durable execution authority | 当前已实现 | 绑定 rule ID、exec-policy revision、action、capabilities 与 Tool Call |
| Auto Review 类型化建议与风险门槛 | 当前已实现 | 当前是单次审查，没有分层审查或多审查器协作 |
| 持久化批准请求与 `ApproveOnce` / `Decline` | 当前已实现 | 各客户端的呈现体验尚未完全统一 |
| TUI 的 Ask / Auto Review / Bypass per-Turn 模式 | 当前已实现 | 模式在提交时冻结；review model 当前在 App Server 启动时解析 |
| 副作用前记录工具执行开始 | 当前已实现 | 崩溃后的未知结果不自动重放 |
| 类型化沙箱拒绝再审查 | 当前已实现 | 最多一次；真实平台拒绝样本仍有限 |
| macOS、Linux 和 Windows 平台沙箱 | 部分具备 | 具体支持和集成验收以沙箱文档为准 |
| rule expiry | 尚未完成 | 需要独立时间与撤销语义 |
| 面向用户的统一权限解释器与历史审计页 | 尚未完成 | 协议和 Core 契约可作为后续 UI 基础 |

## 计划方向：让权限更容易理解，而不是更模糊

后续产品演进应优先改善解释和管理能力：

1. 批准界面用自然语言展示“动作、目标、能力、作用范围、来源、沙箱差异和风险理由”；
2. 将“为什么这次询问”和“为什么不能在沙箱中完成”分开解释；
3. 提供可查询的权限决定历史，但对密钥和敏感参数做结构化脱敏；
4. 为已实现的 User/Directory rules 提供可解释的管理 UI，并为 Organization 分发和 expiry 增加
   独立 adapter；
5. 用真实沙箱拒绝、危险自动批准率和人工标签评估 Auto Review，而不是只统计减少了多少弹窗；
6. 各客户端共享生成的协议和相同决定语义，不各自创造权限模式。

长期规则不是一次性批准的“快捷保存”。它已经是独立、typed、revision-bound 的策略对象；未来 UI
若提供保存入口，也必须生成并展示该对象，而不能偷偷复用历史点击。

## 这也是开发方法

权限文档不只是功能介绍，它可以作为契约驱动开发（contract-driven development）的入口：

1. **先写用户语义**：用户看见什么、批准什么、拒绝后发生什么；
2. **再划分授权职责**：谁能建议、谁能签发、谁能执行、谁只能展示；
3. **定义不变量**：优先拒绝、精确绑定、失败即关闭、未知结果不重放；
4. **落到类型**：使用枚举、newtype 和类型化分支表达，不使用含糊的布尔值；
5. **映射持久化边界**：副作用前记录什么，恢复时依据什么继续；
6. **派生测试**：每条重要语义都应有单元测试、集成测试或平台验收证据；
7. **标注状态**：当前实现、当前限制和计划设计永远分开。

文档先行不代表“文档说了就算实现”。正确的关系是：

```text
产品语义
  → 权威文档
  → 类型化契约
  → 责任方实现
  → 测试与验收
  → 文档中的当前状态
```

如果代码无法证明文档中的当前行为，应修正实现或把文档降为计划设计；不能用模糊措辞掩盖
二者不一致。

## 审查清单

修改权限、工具、Plugin、MCP、沙箱或批准界面时，至少确认：

- [ ] 动作摘要是否覆盖所有安全相关输入；
- [ ] 能力是否最小且作用范围明确；
- [ ] 确定性规则是否仍早于用户授权和风险审查器；
- [ ] 风险审查器是否仍只能建议、不能签发执行授权；
- [ ] 批准是否绑定精确请求、工具调用、能力集合和策略版本；
- [ ] 副作用前是否已持久化记录执行开始；
- [ ] 未知执行结果是否不会自动重放；
- [ ] 沙箱失败是否不会静默降级；
- [ ] 新 UI 选项是否在协议和 Core 中有唯一、明确的权威语义；
- [ ] 当前实现与计划设计是否仍清楚分离。

确定性规则语言见 [`ash-execpolicy` README](../ash-rs/execpolicy/README.md)；最终决策顺序与 grant
binding 见 [`ash-action-policy` README](../ash-rs/action-policy/README.md)。
