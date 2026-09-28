# Ash 领域模型与命名

> 本文是 Agent、Team、Project、Session、Thread、Environment、Workspace、目录与授权概念的长期架构契约。
>
> 状态：Session、Thread、Environment、Dir、目录授权以及 Project 的持久实体和长期多根目录表已经进入当前后端协议与实现。Project 的 Desktop/CLI/TUI 产品入口、根选择和跨 Environment 交互仍未完成；多个 Session 保持独立，不再建立第二套跨 Session 工作状态机。

## 快速理解

> **Project 是长期多根工作中心，弱关联根目录表、Session 和共同工作；`session_id` 是 Thread 树的分组身份，`thread.id` 是具体执行分支，Environment 是执行位置，`cwd` 与目录集合是环境内的工作范围。**

这些概念不能设计成一组平级的“大实体”。它们回答的问题不同，生命周期也不同。

## 1. 对话与组织

| 概念 | 回答的问题 | 是否独立持久化 |
| --- | --- | --- |
| `Project` | 用户长期保存哪些根目录、Session 和共同工作入口？ | 是；拥有名称、描述、多根目录表、弱关联和生命周期 |
| `Team` | 哪些长期 Agent 身份作为成员跨任务协作？ | 目标设计；拥有成员关系、协调者和关联任务，当前尚未实现 |
| `TeamRunId` | 哪次工作使用了哪个 Team 与成员快照？ | 目标设计；持久关联一次工作与所属 Session，不保存执行状态机 |
| `AgentId` | 哪个长期 Agent 身份执行这些分支？ | 是；一个身份可绑定多个任务的 Thread，删除任务后保留 |
| `session_id` | 哪些 Thread 属于同一棵会话树？ | 作为 Thread 字段保存，不单独建立事实源 |
| `Thread` | 当前操作的是哪条具体对话分支？ | 是；拥有自己的事件、顺序、恢复和执行状态 |
| `Turn` | Thread 中一次输入与执行周期是什么？ | 随 Thread 保存 |
| `Item` | Turn 中具体消息、工具调用或结果是什么？ | 随 Thread 保存 |

基本关系：

```text
Project?  ⋯⋯ associates ⋯⋯> root catalog*
          ⋯⋯ groups     ⋯⋯> Session tree*

session_id = S1
├── Thread T1   id=T1, parent=None
├── Thread T2   id=T2, parent=T1
└── Thread T3   id=T3, parent=T1
```

`Session` 可以作为按 `session_id` 聚合 Thread 的领域视图，但不能因此再建立 Session event log、
Session store 或第二套 sequence。最初实现应等价于：

```text
get_session(session_id)
  = all Threads where thread.session_id == session_id
```

根 Thread 通常满足 `thread.id == session_id`；持久 fork 或子 Agent 通常产生新的 `thread.id` 并保留
原 `session_id`。这不是所有派生模式的普遍定律：需要新会话树的临时派生可以使用新的
`session_id`。因此代码只能依赖显式字段，不能靠 ID 相等猜关系。

Agent 身份、任务分组和执行分支分别表达。普通 fork、消息恢复、rewind 和 replacement 延续 AgentId，委托创建独立 AgentId；复用身份不共享上下文、取消域或权限。云端认证身份单独映射，不替代业务 AgentId。绑定、来源和迁移规则见 [`protocol.md`](protocol.md#2-身份)。

目标 Team 为新成员分配持久 `AgentId`，或明确绑定已有 `AgentId`；成员可以先于首次 Thread 存在。每次工作创建独立协调 Thread 和成员 Thread，可关联新 Session 或 `/develop` 的已有 Session。现有普通委托创建新的 AgentId；Team 成员再次执行需要明确绑定原身份的受验证入口，不能根据角色名推断。Team、Project 与任务的关系见 [Agent Team](../ash-rs/docs/agent-teams.md)。

`Project` 与会话树是弱关联。删除 Project、移动 Project 或重新归类 Thread，不得改变 Thread 与 `session_id` 的核心身份。当前关联保存在 Project 的 `session_ids` 集合中，不向 Thread 增加 Project 身份，也不建立 Session store；`ProjectId`、完整 Project 记录和命令回执由独立 Project store 持久化。窗口 Workspace、目录集合或 Session 标题都不能被客户端推断成 Project。

### 1.1 Project、多根与共同工作

Project 在后端表示长期多根工作中心，但它不是目录、Workspace、权限主体或跨 Session 协调器。它当前关联：

| 关联内容 | 负责什么 | 不负责什么 |
| --- | --- | --- |
| 根目录表 | 保存 Environment + Dir 的稳定引用、显示名称、用途和可选仓库摘要 | 授予文件、命令、配置或 Hook 权限 |
| Session tree | 让用户长期查找和归类独立 Agent 方向 | 改变 Session/Thread 身份、取消或上下文 |
Project 可以关联同一 Environment 中的多个根，也可以关联本地和远程等不同 Environment 的根。每个 Session 明确选择自己的 Environment 和目录授权；Project 不会把多个 Session 自动解释成一次协作，也不能让一次工具调用隐式跨越执行位置。

受信 host 只能把 Session 已有目录授权中的精确 `DirId` 加入 Project，路径和 Environment 由 host 重建，客户端不能提交路径冒充根。这个动作只写 Project 目录表，不创建、恢复或修改 Grant。Session 创建或扩大工作范围时仍需选择 Project 根目录表的明确子集并为每个根取得独立 Grant；实际执行绑定选中根的 `DirId`、权限、配置来源和不可变 baseline。Project 后续增加、删除或重新排序根，不会静默改变已运行 Session 或工作尝试。

同属一个 Project 不产生信任、授权、上下文共享、取消传播、目标分支写入权或结果接受权。Project 名称、描述和归类变化不应让验证失效；只有实际消费的根、配置、决定或 baseline 变化才使相关证据过期。

### 后端协议与前端产品模型不是同一个层次

前端可以拥有稳定的 `ISession`，这不等于后端要把 `session_id` 扩成第二套持久化实体。两层关系
应当明确写成：

| 后端事实 | 前端产品对象 | 作用 |
| --- | --- | --- |
| `session_id` + `Session { title, status, threads }` | `ISession` | 让列表、标题、状态和多个 Chat 有稳定对象可用 |
| `Thread` | `IChat` | 表示一条可恢复、可执行的具体对话分支 |
| `session/changed` | provider 的失效信号 | 重新读取 Session；它不是事件流，也没有 Session sequence |
| `session/thread/update` + Thread sequence | Chat 的增量更新 | 只推进对应 Thread，不推进 Session |

这里借鉴 VS Code Sessions 的职责边界，而不是照搬它的后端模型：provider 负责把 App Server
协议转成前端 `ISession / IChat`；management service 负责列表、草稿和操作；window sessions
service 负责当前项、可见项、导航与焦点。生成的 App Server DTO 不能越过 provider 进入 Part、
Pane 或普通 Workbench contribution。

前端 `ISession.workspace` 若存在，只能是面向用户的环境摘要，例如当前目录、附加目录和显示名。
它不授予文件权限，也不取代编辑器窗口的 `IWorkspace`。同一个单词在两个产品边界中含义不同：

- `platform/workspace` 的 Workspace 是窗口打开的 Folder / Multi-root Workspace；
- Sessions 的 workspace 是某个 Agent Session 当前在哪些目录工作的人机界面描述；
- Rust/App Server 的执行边界仍然使用 Environment、`cwd`、dirs 和 grants。

## 2. 执行位置与工作范围

```text
Thread defaults
├── EnvironmentRef
├── cwd
├── dirs
└── grants

Turn overrides?
├── EnvironmentRef?
├── cwd?
├── dirs?
└── grants?

effective context = Thread defaults + Turn overrides
```

| 概念 | 负责什么 | 不负责什么 |
| --- | --- | --- |
| `Environment` / `Env` | 本机、远端或隔离环境的执行与文件系统位置 | 项目组织、会话树身份 |
| working scope | 某次执行的 `cwd`、可访问目录和有效授权 | 独立身份与持久生命周期 |
| `cwd` | 相对路径解析起点 | 权限、项目根、主目录 |
| `Dir` | `EnvId + canonical path` 的目录身份与边界 | 是否获权、具备哪些 Permission |
| `Path` | 在环境中定位资源 | 跨环境身份与授权 |
| `Repo` / `Worktree` | Git 仓库与检出关系 | 会话或目录权限 |

工作范围是一组执行参数，不应为了换掉 Workspace 而再造一个同样沉重的
`WorkingScopeService` 或持久表。只有跨公开边界传递这组值时，才使用 `WorkingScope` 或
`ExecutionContext` 这样的组合类型。

## 3. Workspace、Project、Folder 与 Dir 的适用场合

`Workspace` 不需要从所有代码和产品文案中消失。它适合表达编辑器窗口、多根文件夹集合、
workspace 配置作用域和 Cargo workspace 等已经有明确行业语义的对象。

它不适合表达：

- Agent 的运行位置；这里使用 `Environment`；
- 一次执行的可访问范围；这里使用 `cwd + dirs + grants`；
- 会话树身份；这里使用 `session_id`；
- Git 身份；这里使用 `Repo / Worktree`；
- 安全状态；这里使用 `Permission / Grant`。

`Project` 用于长期产品组织；`Folder` 用于面向用户的文件夹或编辑器 folder；`Dir` 用于后端已经
规范化并绑定环境的目录。三者不能因为都可能指向同一路径就互换。

Project 根目录表与 Workspace 都可能展示多个文件夹，但生命周期和权威不同：Project 保存长期工作入口，Workspace 决定当前编辑器窗口打开哪些 folder，Session 的 `dirs + grants` 决定某棵 Thread 树实际能访问什么。Project 可以帮助创建或打开 Workspace，不能与 Workspace 共用一个身份或让窗口内容自动成为 Agent 权限。

## 4. 安全模型

| 概念 | 语义 | 例子 |
| --- | --- | --- |
| `Permission` | 可授予的动作种类 | `ReadFiles`、`WriteFiles`、`ExecuteCommands` |
| `Grant` | 主体在明确范围内获得的一组 Permission，并带来源和撤销生命周期 | Session tree S 对目录 D 可读写 |
| `ApprovalRequest` | 当前缺少 Grant 时，向用户请求一次授权或创建明确规则的交互 | 请求允许本次网络动作 |
| `AuthorizationDecision` | 对一次具体动作的 `allow` 或 `deny(reason)` 结果 | `Result<Authorization, PermissionDenied>` |

`Permit` 不作为领域类型或持久对象。允许分支可以携带一个只供当前操作立即消费的
`Authorization`，用于绑定主体、目录、Permission 和撤销租约；它不是新的 Grant，也不能保存后
复用。

目录级 `Trusted / Untrusted` 同时混合读取、执行、配置加载与批准策略，无法表达常见的细粒度组合，
因此不进入模型。签名验证、发布者身份和 TLS 等安全语义可以继续使用 trust，但不能借这个词表示
目录权限。

## 5. 命名规则

先判断作用域和歧义，再决定写全称还是短词：

| 场景 | 推荐 | 避免 |
| --- | --- | --- |
| 跨模块公开类型 | `AuthorizationDecision`、`DirPermissionsService` | `AuthResult`、`PermSvc` |
| 目录模块内公开动作 | `add_dir`、`remove_dir` | `add_additional_directory` |
| `Dirs` 或 `DirGrants` 的私有方法 | `add`、`remove`、`list` | 重复接收者已经表达的领域词 |
| 局部集合 | `dirs`、`grants` | `additional_directories`、`permission_grant_items` |
| 稳定领域缩写 | `Env`、`Dir`、`cwd`、`id` | 随意的 `cfg`、`ctx`、`auth` |

`snake_case` 的 `_` 只分隔真实单词。`add_dir` 是动词加对象，需要 `_`；`dirs` 是一个词，不需要。
公开类型要在脱离文件上下文后仍然清楚；局部变量则使用最短且不歧义的名字。

## 6. 架构检查

修改相关代码时必须同时满足：

- Thread 是唯一的对话事件流和恢复事实源，`session_id` 只负责分组；
- Session 聚合视图不得拥有独立 sequence、事件表或 store；
- Project 不拥有 Thread，只建立可选归类关系；
- Project 根目录表只保存资源引用和长期入口，不授予权限，也不自动改变活动 Session；
- 一个工作尝试只绑定一个 Environment；跨 Environment 协作使用多个 Session；
- Environment、路径、目录、Git 与权限身份彼此独立；
- `cwd` 和目录集合的变化不会暗中扩大 Grant；
- 每个 Grant 明确记录主体、Permission、范围、来源和撤销生命周期；
- `ApprovalRequest` 只取得授权，`AuthorizationDecision` 只回答当前动作允许或拒绝；
- Workspace 只在确实存在编辑器/产品 workspace 语义时出现。
