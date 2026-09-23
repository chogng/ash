# Git 与 Desktop SCM：系统边界和当前状态

> 本文拥有 Git 跨进程 ownership、用户可见语义和演进状态。`ash-git` 的命令、解析、
> timeout 与失败细节以 [`ash-rs/git/README.md`](../ash-rs/git/README.md) 为准；
> worktree 切换目标与 Codex 兼容归属以 [`ash-rs/worktree/README.md`](../ash-rs/worktree/README.md) 为准；
> external wire shape 以 [`ash-app-server-api.md`](ash-app-server-api.md) 为准。

## 快速理解

Desktop Renderer 和 TUI 不启动 Git 进程，也不解析 Git 输出。App Server 在明确的 `Dir` 内
接收 typed Git intent，调用 `ash-git`，再把 client-safe DTO 返回产品入口。SCM 是
Workbench 的通用展示与 provider 编排层；Git 是当前注册到 SCM 的版本控制 provider 和后端领域。

```text
Desktop SCM View（当前直接消费 IGitService；目标改由 SCM contract 消费）
  → Desktop Git domain service（目标由 frontend Git provider adapter 投影）
  ↔ Electron typed IPC + Git notification
  ↔ App Server GitRuntime
  → GitService
  → ash-git
  → system Git
```

这条依赖方向让目录边界、Git executable identity、process limits 和 output
parsing 留在 Rust host。Renderer 只拥有展示状态和用户 intent。

Git 查询和修改使用不同 capability：

| Git 能力 | `InspectRepository` | `MutateRepository` |
| --- | --- | --- |
| 当前分支、HEAD、改动状态、变更路径 | ✅ | ✅ |
| 本地分支、分页 history/graph、已 fetch 的 remote-tracking refs、受限文本 diff | ✅ | ✅ |
| 暂存、取消暂存、丢弃、提交、切分支 | ❌ | ✅ |
| fetch、pull、push | ❌ | ✅ |

只读入口要求 `Authorization<InspectRepository>`，修改入口要求 `Authorization<MutateRepository>`。Git query
继续由 `ash-git` 以禁用 hooks、非交互和有界进程的 query profile
执行，不能借此启用目录代码或远程操作。

| 用户操作 | 当前行为 | 关键限制 |
| --- | --- | --- |
| 查看更改 | `git/repositories` 列出已授权目录内的仓库，并逐仓库读取状态 | 重复 worktree 只投影一次 |
| 暂存或取消暂存 | 使用明确的 `repositoryId` 与仓库相对路径 | 不能越过对应目录 Grant |
| 丢弃更改 | 只恢复已跟踪文件，并在界面确认 | 不删除未跟踪文件 |
| 切换本地分支 | Native 点击底栏当前分支，在菜单中选择另一个本地分支；请求通过 App Server | 冲突时 Git 拒绝切换并保留当前工作树 |
| 查看 history graph | SCM Graph 以 `limit`/`cursor` 分页读取 `git/graph`，自动连续合并全部页面，按 lane 分配颜色并显示 local/remote refs；列表本身按视口虚拟化；history item 可展开 `git/commitChanges` 文件列表，点击文本文件再按需读取 `git/commitFile` 并挂到 Editor | 只包含本地已存在的 refs；自动 fetch 需主动开启；binary 或超限文件不作为文本 editor 打开 |
| 自动获取远端更新 | App Server 读取共享 `[git]` 配置并逐仓库调度；`autofetch` 默认为 `"off"`，`"default"` 获取默认远端，`"all"` 获取全部远端；`autofetchPeriod` 默认 180 秒 | 三端共用配置，不提供仓库级覆盖；只对有修改授权的仓库执行，各仓库独立定时获取；只更新远端引用，不执行 pull |
| 拉取远端 | 只允许 fast-forward | 需要交互认证时失败 |
| 提交和推送 | 使用系统 Git 的当前仓库配置 | 尚无凭据提示和进度 UI |

## SCM 与 Git 的分层决策

VS Code 的 SCM Workbench 不执行 Git，也不定义 Git wire DTO；Git provider 把 repository、resource
group、history item、reference 和 command 投影成 SCM contract。Ash 应保持同一依赖方向，但不照搬
VS Code 的 extension-host 进程布局。

| 层级 | 长期 owner | 当前状态 | 边界判断 |
| --- | --- | --- | --- |
| Workbench SCM | provider registry、通用 repository/resource/history contract、树与 Graph 展示、Editor 打开语义 | 尚未完成：`ScmViewPane`、`ScmGraphViewPane` 和 `ScmStatusContribution` 仍直接消费 `IGitService` | 需要解耦；新增 VCS 不应修改 SCM View |
| Desktop Git provider adapter | 把 `IGitService` 的 status、refs、history、changed-file URI 和命令映射为 SCM contract | 尚未抽取为独立 provider；当前映射散落在 SCM consumer | 是前端迁移落点，不拥有 Git RPC 或 Git output parsing |
| Desktop `IGitService` 与 Electron bridge | client-safe Git domain、连接事件和 typed `git/*` transport | 已实现 | 保持 Git 专属；不改名为 SCM service |
| App Server `GitRuntime` / `GitService` | Git operation serialization、`Authorization<InspectRepository>` / `Authorization<MutateRepository>`、repository projection 与通知 | 已实现 | 保持 Git 专属；不新增仅转发 Git DTO 的 `scm/*` facade |
| `ash-git` | Git executable、命令、解析和 failure semantics | 已实现 | 与 SCM UI 无依赖 |
| `git-turn-changes` | 按 Session/Thread/Turn 捕获 Git tree、归属 Tool 写入、维护 ChangeSet 与提交状态 | 已实现 | 只接受 Git repository，不拥有 Thread 目录或 GitHub Issue |
| `worktree` | 组合 `ash-git` inventory、维护 Thread 独占 checkout/目录和持久化绑定 | 已接入 App Server 的 Thread 创建与恢复 | 不拥有 Turn 归属、摘要或提交状态机 |

前端迁移必须从调用者 contract 开始：先定义通用 `IScmService`、repository/provider 和 history
provider，再让 Git adapter 注册实现，最后把现有 SCM panes 改为只依赖通用 contract。不能让
`IScmService` 直接暴露 `GitStatus`、`GraphPage`、`git/commitFile` 或 `fetch/pull/push` 方法；这些能力
应由 provider 以 resource group、history item change、status bar command 和 menu action 投影。

后端只有在出现真正共享的跨 VCS authority、队列或 durability 语义时才增加对应通用层。仅为了让
目录名与前端 SCM 对齐而包装 `git/*` 会增加一层同形 DTO、模糊错误 ownership，并使未来 provider
被迫服从 Git 的 branch/index/worktree 模型，因此明确不采用。

## 所有权

| 层级 | 当前职责 | 不拥有 |
| --- | --- | --- |
| Desktop SCM（当前实现） | 分支/upstream、Merge/Staged/Working Tree 分组，提交输入，Git intent，history graph lane/ref/remote presentation，以及按 revision 接收自动状态更新；其中 Git DTO 到 SCM contract 的 provider adapter 尚待抽取 | Git process、porcelain parser、任意 host path authority |
| Electron bridge | 校验 `repositoryId`、仓库相对路径、commit message 和空参数，再把 typed Git intent 转发给 App Server | Git domain semantics、最终路径授权 |
| App Server `GitRuntime` | 发现目录集合中的仓库，按 repository 串行化 operation、维护 projection/revision、消费 watcher hint、去重并发布状态 | Git command/parsing、Renderer state |
| App Server `GitService` | 冻结 canonical `Dir` 与 repository projection root、映射目录/仓库路径、持有 Tokio runtime并调用 `ash-git`；按 `InspectRepository`/`MutateRepository` 再校验读写边界 | live projection、notification |
| `ash-app-server-protocol` | Git query/mutation、`git/statusChanged`、DTO、capability 和 stable error name | process/runtime state |
| `ash-git` | system Git identity、仓库发现、porcelain-v2 snapshot、分页 graph、local/remote refs、credential-free remote identity、HEAD/worktree 文本 Diff 与增删行统计、typed mutation 与结构化 parsing | App Server lifecycle、目录产品边界、Renderer state |
| `worktree` | 同仓库 worktree 清单、按 branch/path 解析可用 target、来源目录 nested cwd 映射、Codex Desktop settings 与 `codex-thread.json` 归属 | Git process、Session lifecycle、产品目录切换、选择器 UI |

Thread 提交不走普通 `git/commit`。`git-turn-changes` 把每个 Turn 封存为不可变 before/after tree，
`ash-git::commit_tree_delta` 将这一个 delta 三方重放到目标分支最新 HEAD。目标 checkout 原有 index、
未暂存和未跟踪内容先分别捕获并计算重放结果；ref 更新使用 expected HEAD CAS，checkout 安装前再比较
tree 指纹。事务 journal 位于 Git common directory，进程重启后可以继续安装或确认已回滚状态。

该路径不读取正在运行的 Thread 目录，也不执行 commit hooks。目标分支推进且重放干净时允许提交；
同一路径冲突、分支删除、checkout 变为 detached、index/文件变化都会返回明确冲突，不静默带入其他 Turn。

## 当前状态

当前已经实现 status 与常用用户 mutation 的完整纵向切片：

- App Server 从具备 `InspectRepository` 的目录 Grant 发现仓库，并在存在可用仓库时声明 `initialize.capabilities.git = true`；
  只有具备 `MutateRepository` 的仓库才能执行 mutation；
- `git/repositories` 返回稳定、目录相对的 repository identity；`git/status` 与其他 query/mutation 接受可选 `repositoryId`，省略时选择排序后的首个仓库；mutation 只接受 repository-relative path，Electron 和 Rust 边界都会
  拒绝绝对路径、空路径和父目录逃逸；
- 授权目录位于更大 repository 内时，App Server 会过滤 repository 其他目录并把 path 重新映射为
  directory-relative；mutation 则把合法目录 path 映射回 repository-relative path；
- 每次请求重新打开仓库并读取 authoritative snapshot，不把旧 snapshot 当作 mutation 前提；
- response 保留 HEAD branch/detached/unborn、upstream ahead/behind、index/worktree 状态、
  rename original path、conflict 和 submodule flags，并带 `repositoryId`、directory-relative `path`、
  Git runtime `streamInstanceId` 与在该实例内单调递增的 repository status revision；协议不暴露
  repository 的 host 绝对路径；
- `git/stage`、`git/unstage` 和 `git/discardWorktree` 使用明确 path set；discard 只恢复 tracked
  working-tree 内容，不删除 untracked 文件，Desktop 在执行前要求确认；
- `git/commit` 从 stdin 传入经过校验的 message，并返回新 commit object ID；
- `git/textDiff` 返回 repository-scoped status、受限 UTF-8 HEAD/worktree 文本与增删行统计；
- `git/branch/list` 返回现有本地分支，`git/branch/switch` 只接受 branch name，并在 host 重新解析为
  当前仓库真实分支后执行切换；
- `git/graph` 首次接受有界 `limit`，后续使用不透明 `cursor` 继续同一次 `git log --all --topo-order`
  traversal；游标启动时读取一次 local/remote refs 和 configured remote identity，并通过 `hasMore` 与
  `nextCursor` 表示是否还有下一页。remote identity 只保留 provider、host、owner、repository，原始
  URL、token 和 `gh` 登录配置不会进入协议；状态变化、mutation 或连接关闭会使游标失效；
- `git/fetch` 接受 `mode: "default" | "all"`；省略时沿用 all-remotes prune，默认远端模式执行 `git fetch --prune`。手动 Fetch 仍获取全部远端。`git/pull` 仅允许 fast-forward，`git/push` 使用 Git 当前
  upstream/default 配置；所有 remote operation 都是 non-interactive；
- 每个成功 mutation 都返回新的 `GitStatusResult`，Desktop 立即重绘；首次打开 View 也会自动刷新；
- App Server 监听已授权目录、Git metadata 和目录上层 repository `.gitignore`，以 100ms
  debounce 合并 burst；事件只触发重新查询，不直接成为 Git 状态；
- 新 snapshot 按 repository 投影去重；HEAD/change 未改变时 revision 不推进也不发通知，变化时通过
  `git/statusChanged` 推送完整 snapshot；
- SCM View 只在相同 `streamInstanceId` 内按 revision 拒绝旧 notification/response；连接重新
  ready 时主动刷新，并接受新 runtime 从较小 revision 开始的 snapshot。已退役实例的迟到通知
  不能覆盖新状态。Watcher 初始化失败不会关闭 Git RPC，用户仍可手动 Refresh。

Native 通过 `ash-app-server-client` 消费 `git/textDiff`，在 Composer 底栏展示
`Changes files • +additions -deletions`，并从协议中的原始/修改文本重建 presentation-only
`DiffDocument`。文件内容读取、replacement 计数和 binary/size skip 规则仍由 `ash-git` 统一拥有；
Native 只负责标签、侧栏状态和 MultiDiff presentation。点击 Changes action 会请求刷新 Git
projection、展开右栏并选择 Changes Pane。cwd picker 使用当前 Git status 与 Environment cwd 还原
repository root 快捷项；选择该项会把 cwd 切换到 repository root，使 Changes 投影覆盖整个仓库。

Native 的底栏分支按钮复用通用 `ContextMenu`，候选项来自 `git/branch/list`，切换通过
`git/branch/switch`。Git 对脏工作树或 linked worktree 冲突保持权威：失败时不重试、不丢弃改动，
菜单保留并显示失败；成功后使用新的 typed projection 刷新 Files、HEAD、Changes 和 MultiDiff。
`app` 不再依赖 `ash-git`。

`worktree` 已能从任意 repository nested cwd 列出 primary、linked、locked 与 prunable checkout，并按 branch 或 checkout path 返回可用 worktree target。它还在 Thread 执行前创建持久化的独占受管目录：Git 使用 detached linked worktree；非 Git 使用一次性隔离目录副本，不创建 ChangeSet。失败时 Thread 创建失败，不会转回来源目录。

稳定失败边界为 `GitUnavailable`、`GitNotRepository` 和 `GitOperationFailed`。内部 executable、
stderr、磁盘绝对路径和非 UTF-8 path 不进入 Renderer。

## 当前限制

- `GitRuntime` 已支持目录集合中的 multi-repository registry；前端仍需完成通用 SCM provider 抽取；
- Workbench SCM 尚无通用 provider registry；现有 panes 直接依赖 `IGitService`，因此第二种 VCS
  仍会迫使 UI 分支。这是明确的前端架构债务，不是后端增加 `scm/*` facade 的理由；
- operation 由 runtime mutex 串行化，但尚无可观测 queue、progress、caller cancellation 或 retry；
- App Server 与 Native 已支持切换现有本地分支；系统仍无 branch 新建/删除/重命名、
  tag/worktree 创建删除 mutation 或 credential prompt；`worktree` 已解析现有 worktree target，但 App Server 和产品选择器尚未接入 directory retarget；`ash code` TUI 只消费 branch/dirty 会话上下文，
  当前产品定义不包含 SCM 管理 UI；
- pull 固定为 fast-forward only；discard 不删除 untracked 文件；
- 当前 registry 来自已授权目录集合，不接受客户端提交任意 repository root；
- 工作树 change row 尚未接入 editor diff/open workflow；history changed-file row 已支持打开
  commit/parent 文本 Diff。
- `git/graph` 展示的是本地 repository 中已经存在的 refs；当前不会读取 `~/.config/gh/hosts.yml`，
  也不会调用 GitHub API，因此尚未提供 PR、Checks、review 或实时远端分支状态；这些属于独立的
  provider connector/权限能力，不能由 SCM graph 猜测；

这些限制必须在 UI 中保持可见：未实现的 mutation 不注册空命令，也不显示会误导用户的按钮。

## 分阶段演进

近期扩展顺序：

1. 增加显式 repository identity 与 multi-root registry；
2. 抽取前端 `IScmService`、repository/history provider contract 与 Git adapter，让 SCM panes 不再
   import `IGitService` 或 Git DTO；
3. 为长时间 remote operation 增加 progress、queue state 和 caller cancellation；
4. 为工作树 change row 接入 diff/open，并补充更细粒度的错误 UI；
5. 在明确的 connector/权限 contract 下接入 GitHub PR、Checks 等 provider data；
6. 按明确产品语义增加 branch lifecycle 等额外 mutation，并让已接受该产品需求的
   UI consumer 消费同一协议。协议存在不自动使其成为 TUI 功能。

长期不变量是：Desktop、Native 与 TUI 不直接执行 Git；App Server adapter 不复制 Git
command/parsing；watch event 只触发重新确认，不能自身成为 repository truth。
