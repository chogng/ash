# 环境与目录访问

> 本文拥有 Environment、`cwd`、目录范围和目录授权的跨组件语义。对话与产品组织边界见
> [`domain-model.md`](domain-model.md)，动作审批与执行策略见 [`permissions.md`](permissions.md)。

## 快速理解

| 问题 | 使用的概念 | 不使用 |
| --- | --- | --- |
| 在哪里执行？ | `Environment` / `Env` | Workspace、Project |
| 相对路径从哪里解析？ | `cwd` | 主工作区 |
| 目录属于哪个运行位置？ | `Dir = EnvId + canonical path + 目录对象身份` | 裸路径身份 |
| 主体可以对目录做什么？ | `Permission + Grant` | Trusted / Untrusted |
| 当前动作是否允许？ | `AuthorizationDecision` | 持久 Permit |
| 缺少授权时怎么办？ | `ApprovalRequest` | 自动把目录设为 trusted |

Workspace 可以继续表示编辑器窗口、多根 folder 集合或 workspace 配置作用域，但不是 Agent 执行、
Session 身份或目录安全边界。

计划中的 Project 可以长期关联多个 Environment 和 Dir，但这些引用不是 Grant。Session 从 Project 选择明确目录子集后，仍要逐目录取得权限并冻结实际使用的范围；Project 目录变化不会自动扩大活动 Session。Project 语义见 [`domain-model.md`](domain-model.md#11-project多根与共同工作)。

## 1. 执行结构

```text
Thread defaults
└── execution context
    ├── EnvironmentRef
    ├── cwd
    ├── dirs
    └── grants

Turn overrides?
└── environment / cwd / dirs / grants
```

运行时从 Thread 默认值与 Turn 覆盖计算有效上下文。这组值可以跨接口包装成 `ExecutionContext`，但
不建立独立生命周期、数据库表或全局 manager。

`Environment` 拥有执行和文件系统连接所需的事实：环境 ID、平台、Shell、文件系统入口、临时
目录、连接状态与生命周期。它不拥有 Project、Session tree 或某个用户的全部目录授权。

## 2. 路径、目录与 cwd

裸路径不能跨环境定位资源。`Dir` 至少冻结：

```rust
struct Dir {
    env: EnvId,
    requested_path: AbsolutePathBuf,
    canonical_path: PathBuf,
    object_id: [u64; 2], // 环境文件驱动提供，并保留对应目录句柄。
}
```

路径相同但环境不同，必须是不同目录。同一环境内的路径重新绑定到另一个文件系统对象时，旧 Grant
不得自动沿用。

`cwd` 只决定相对路径如何解析。改变 `cwd` 不会：

- 改变 Project 或 Session tree 身份；
- 把该目录变成“主目录”；
- 增加 Permission；
- 允许加载配置、指令或自动化。

目录集合没有“主目录”和“附加目录”的安全差异。UI 可以突出 `cwd`，但每个目录都必须独立获得
所需 Grant。

## 3. Permission、Grant 与单次决定

```text
Permission
  = 动作种类

Grant
  = subject + scope + permissions + source + revocation lifetime

AuthorizationDecision
  = allow(Authorization) | deny(PermissionDenied)
```

当前 Rust 表达为：

```rust
type AuthorizationDecision = Result<Authorization, PermissionDenied>;
```

`GrantSubject` 明确区分：

- `Environment(EnvId)`：环境级主机授权；
- `SessionTree(SessionId)`：共享一个 `session_id` 的执行范围；
- `Thread(ThreadId)`：只属于具体分支的授权。

`SessionTree` 只是主体作用域，不代表存在 Session store 或 Session event log。

允许分支携带的 `Authorization` 只在当前操作入口与执行之间传递。它绑定主体、目录、Permission、
来源和撤销租约。它可复制、可重复使用，每次操作必须重新校验完整绑定，不是一次性凭证。
文件执行入口持有租约直到 I/O 完成；撤销等待已获准操作结束，返回后旧 Authorization 不能开始新操作。
它不持久化，也不升级成新的领域对象。

`ApprovalRequest` 是缺少 Grant 时的交互。批准可以只覆盖当前动作，也可以由明确的配置入口创建
长期规则；不能把一次批准历史模糊匹配成长期授权。

## 4. 授权流程

```mermaid
flowchart TD
    request["具体动作<br/>subject + Env + Dir + Permission"] --> resolve["解析路径并校验目录边界"]
    resolve --> check["检查有效 Grant 与策略"]
    check --> decision{"AuthorizationDecision"}
    decision -- "allow" --> auth["Authorization<br/>当前操作完整校验"]
    decision -- "deny: 缺少可请求授权" --> approval["ApprovalRequest"]
    approval -- "批准" --> recheck["建立精确授权并重新检查"]
    approval -- "拒绝" --> denied["deny(reason)"]
    decision -- "deny: 不可批准" --> denied
    recheck --> auth
    auth --> sandbox["沙箱强制边界"]
    sandbox --> execute["执行"]
```

批准、Grant、AuthorizationDecision 和沙箱互相独立：

- 批准交互取得用户决定；
- Grant 保存主体在范围内获得的 Permission；
- AuthorizationDecision 判断当前动作；
- 沙箱在操作系统层强制边界。

任何一层都不能替代另外三层。

## 5. 来源权限取代目录 Trust

目录能否贡献行为，由明确 Permission 决定：

| 行为 | Permission | 含义 |
| --- | --- | --- |
| 读取项目指令 | `LoadInstructions` | 允许读取并加入当前 Turn 上下文 |
| 读取配置 | `LoadConfig` | 允许读取该目录的配置贡献 |
| 发现 Hook | `DiscoverHooks` | 只允许发现；运行还需执行授权 |
| 发现 Skill | `DiscoverSkills` | 允许发现并按 Skill 生命周期加载 |
| 发现 MCP | `DiscoverMcp` | 只允许发现声明，不自动连接 |
| 发现 Plugin | `DiscoverPlugins` | 只允许发现声明，不自动安装或激活 |

一个 `Trusted / Untrusted` 布尔值无法表达只读、可写但不可执行、允许指令但禁止 Hook 等组合，
因此不进入目录模型。签名、证书与发布者验证仍可使用各自的 trust 语义。

## 6. 命令与命名

用户命令使用环境、目录和动作组成的短词：

```text
env list
env use <env-id>
env dir list <env-id>
env dir add <env-id> <path> --allow read,search
env dir allow <env-id> <dir-id> write
env dir deny <env-id> <dir-id> exec
env dir remove <env-id> <dir-id>
```

在目录领域内使用 `dirs`、`add_dir`、`remove_dir`；不要写
`additional_directories` 或 `add_additional_directory`。跨模块公开类型使用完整且无歧义的
`AuthorizationDecision`、`DirPermissionsService`；局部变量使用 `dir`、`grant`、`permission`、
`authorization`。

## 7. 所有权与不变量

| 所有者 | 负责什么 |
| --- | --- |
| `ash-environment` | 环境身份、物理目录绑定、安全路径解析和目录句柄 |
| `ash-file-access` | `Dir`、`Permission`、`Grant`、撤销、快照与授权决定 |
| `ash-file-system` | 按完整授权执行文件操作，目录句柄约束实际 I/O |
| 权限策略 | 判断动作应允许、询问还是拒绝 |
| 批准交互 | 收集用户决定 |
| 沙箱 | 强制文件、网络和进程边界 |
| Git | `Repo / Worktree` 身份与 Git 操作 |

长期不变量：

- 路径、`cwd`、Workspace、Project 和 Repo 都不会自动授予 Permission；
- 每个 Grant 都有明确主体、目录范围、Permission、来源和撤销生命周期；
- `AuthorizationDecision` 是一次检查结果，不保存为 Grant；
- 来源配置不能给自身扩权；
- Project、Project 根目录表和同 Project 关系不能产生 Grant；
- Workspace 只表示编辑器窗口、多根 folder 集合、配置作用域、Cargo 或外部标准中的同名概念；
- 后端执行位置使用 Environment，执行范围使用 `cwd`、`dirs` 和 `grants`，不能再借用 Workspace 表达。

## 8. 文件执行契约

- 读文件需要 `ReadFiles`；元数据、列举需要 `BrowseFiles`；写入、条件写入、创建、重命名、删除需要 `WriteFiles`。
- `Access` 绑定唯一主体，所有查询与撤销使用包含环境和物理对象身份的目录键。
- 本地驱动在实际承载环境的进程中运行；不能把任意远端环境 ID 当成本机路径的归属。
- 目录规范化只确定名称；实际 I/O 使用保留的目录句柄。重新绑定后旧 Grant 不获得新对象的权限。
- 条件写入在同一物理目录的进程内写锁下检查和提交；不承诺与其他进程的文件修改进行事务隔离。
- 配置来源可以影响签发政策；配置目录引用不能签发 Grant，已明确签发的贡献权限不再被来源过滤。
- 旧的仅路径目录 ID 不匹配新的物理对象绑定，必须重新建立绑定并取得授权。
