# Git 与 Desktop SCM：系统边界和当前状态

> 本文拥有 Git 跨进程 ownership、用户可见语义和演进状态。`ash-git` 的命令、解析、
> timeout 与失败细节以 [`ash-rs/git/README.md`](../ash-rs/git/README.md) 为准；
> worktree 切换目标与 Codex 兼容归属以 [`ash-rs/worktree/README.md`](../ash-rs/worktree/README.md) 为准；
> 能力划分与 Session 文件选择提交见 [`git-capabilities.md`](git-capabilities.md)；
> external wire shape 以 [`ash-app-server-api.md`](ash-app-server-api.md) 为准。

## 快速理解

Desktop Renderer 和 TUI 不启动 Git 进程，也不解析 Git 输出。App Server 在明确的 `Dir` 内
接收 typed Git intent，调用 `ash-git`，再把 client-safe DTO 返回产品入口。SCM 是
Workbench 的通用展示与 provider 编排层；Git 是当前注册到 SCM 的版本控制 provider 和后端领域。

```text
Desktop SCM History View → Git history provider → Desktop Git domain service
Desktop SCM Changes View → SCM repository/provider → Desktop Git domain service
  → TS Git API adapter → renderer protocol client
  ↔ MessagePort relay（Electron）或 Web transport + Git notification
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
| 本地分支、工作树清单与目标解析、分页 history/graph、已 fetch 的 remote-tracking refs、受限文本 diff | ✅ | ✅ |
| 暂存（含选区和块）、取消暂存、丢弃、提交及修改或撤销提交、分支管理、工作树增删、整合流程、stash、tag、remote 管理、初始化 | ❌ | ✅ |
| fetch、pull、push | ❌ | ✅ |

只读入口要求 `Authorization<InspectRepository>`，修改入口要求 `Authorization<MutateRepository>`。Git query
继续由 `ash-git` 以禁用 hooks、非交互和有界进程的 query profile
执行，不能借此启用目录代码或远程操作。

| 用户操作 | 当前行为 | 关键限制 |
| --- | --- | --- |
| 查看更改 | `git/repositories` 列出已授权目录内的仓库，并逐仓库读取状态 | 重复 worktree 只投影一次 |
| 暂存或取消暂存 | 使用明确的 `repositoryId` 与仓库相对路径 | 不能越过对应目录 Grant |
| 丢弃更改 | 只恢复已跟踪文件，并在界面确认 | 不删除未跟踪文件 |
| 切换本地分支 | 在桌面端点击底栏当前分支，在菜单中选择另一个本地分支；请求通过 App Server | 冲突时 Git 拒绝切换并保留当前工作树 |
| 创建或删除本地分支 | 命令面板提供 `git.branch` 和 `git.deleteBranch`；新分支基于 HEAD 创建，当前分支保持不变；删除前确认 | Git 拒绝删除未合并或在任何工作树中检出的分支；成功后后端通知所有连接刷新历史引用 |
| 创建或打开工作树 | 命令面板提供 `git.createWorktree` 和 `git.openWorktree`；创建 detached 工作树后可打开；打开已有目录前通过后端重新解析 | 目录由后端的 worktree 配置决定；保留来源仓库的子目录位置；不打开锁定、失效或会话持有的工作树 |
| 删除工作树 | `git.deleteWorktree` 选择非当前、可用且未绑定会话的工作树并确认删除 | 后端拒绝主工作树、脏工作树或会话持有的目录；普通 Git 命令不删除会话 |
| 初始化 | `git.init` 在选中的已授权工作区文件夹创建仓库，并重新发现仓库 | 拒绝在已有仓库内部创建嵌套仓库；要求该文件夹的修改权限 |
| 分支改名与远端分支删除 | `git.renameBranch` 和 `git.deleteRemoteBranch` 经封闭的 `git/command` intent 执行 | 删除远端分支前确认；远端必须仍在当前仓库配置中 |
| 合并、变基、拣选 | `git.merge`、`git.rebase`、`git.cherryPick`；`git.continue`、`git.abort` 读取 Git 元数据确定当前流程 | 开始时要求 index 和工作树干净；冲突作为结果返回并发布实际状态；继续不会启动终端编辑器 |
| 储藏 | `git.stash` 选择已跟踪或包含未跟踪更改；`git.stashApply`、`git.stashPop`、`git.stashDrop` 选择提交 ID | 后端重新定位该 ID，拒绝已不存在的储藏；删除前确认 |
| 标签与远端配置 | `git.createTag`、`git.deleteTag`、`git.addRemote`、`git.removeRemote` | 清单不返回远端 URL 或凭据；删除标签和移除远端前确认 |
| 修改或撤销提交 | `git.commitAmend` 提交当前 index；`git.undoCommit` 撤销最后提交并保留 index 和工作树 | 明确提示改写历史；撤销使用确认时的 HEAD 做原子比较，拒绝已变化的 HEAD；不撤销根提交 |
| 部分暂存 | `git.stageHunk`、`git.unstageHunk` 选择文件与更改块；`git.stageSelectedRanges`、`git.unstageSelectedRanges` 使用编辑器选区 | Rust 重新计算 diff，检查两侧内容并持有 Git index 锁后更新 index；不修改工作文件；冲突、重命名、子模块、二进制和非 UTF-8 文件不支持部分操作 |
| 查看 history graph | SCM Graph 以 `limit`/`cursor` 分页读取 `git/graph`，首屏读取一页，后续随列表渲染范围追加页面，按 lane 分配颜色并显示 local/remote refs；列表按视口虚拟化；history item 可展开 `git/commitChanges` 文件列表，点击文本文件再按需读取 `git/commitFile` 并挂到 Editor | 从本地分支、已 fetch 的远端分支、标签和当前 HEAD 遍历；stash、内部引用及其他工作树的 detached HEAD 不作为起点；自动 fetch 需主动开启；binary 或超限文件不作为文本 editor 打开 |
| 自动获取远端更新 | App Server 读取共享 `[git]` 配置并逐仓库调度；`autofetch` 默认为 `"off"`，`"default"` 获取默认远端，`"all"` 获取全部远端；`autofetchPeriod` 默认 180 秒 | 三端共用配置，不提供仓库级覆盖；只对有修改授权的仓库执行，各仓库独立定时获取；只更新远端引用，不执行 pull |
| 拉取远端 | 只允许 fast-forward | 需要交互认证时失败 |
| 提交和推送 | 使用系统 Git 的当前仓库配置 | 尚无凭据提示和进度 UI |

## SCM History 行布局

History 使用公共 [`ListView`](../app-ts/src/ash/base/browser/ui/list/listView.ts) 管理滚动、行高、
可见范围、行复用和有界缓存释放。SCM 提供提交内容、展开后的高度和操作资源，
在列表永久移除行时释放对应资源；行离开渲染范围时关闭其详情卡片。
“加载更多”作为列表的一行，在进入包含预渲染区域的渲染范围时请求下一页。
分页保留已有提交行的对象，追加历史不会重建仍在显示的操作区或打断焦点。
SCM 的 lane 分配和合并连线算法继续由 `scmHistory.ts` 负责。

标题操作的刷新和忙碌状态属于发起操作时选中的仓库。切换仓库会结束旧操作对窗格的控制；
旧操作随后完成或失败时，不刷新新仓库，也不改变新仓库的操作按钮状态。
切回原仓库不会恢复旧操作对窗格的控制；窗格释放后，未完成的标题操作也不再触发刷新。

提交行只排列图形和标题，短 SHA 和日期不常驻，也不预留列宽。鼠标悬停或键盘焦点进入
提交时，卡片按需读取作者、相对时间和完整时间、完整提交说明，以及文件数和增删行数。
变更统计按第一父提交计算；根提交使用空树，二进制文件计入文件数而不计入行数。
卡片底部显示短 SHA，完整 SHA 可查看和复制；有可识别远端时提供浏览器入口。
Alt+向下键进入卡片操作区，Escape 返回提交行。标题在窄、宽侧栏中都使用图形列右侧的可用宽度。
卡片内 Alt+F1 打开无障碍帮助，Alt+F2 以纯文本阅读详情；帮助提示可通过
`accessibility.verbosity.scmHistoryDetails` 设置控制。

History 提交行的右侧使用浮层，包含分支标签（例如 `main`）、远端引用图标和操作按钮。
这些组件覆盖标题右端，不参与标题的宽度分配。相同图形列宽度下，有无引用标签、鼠标悬停或
键盘焦点进入操作区，都不改变标题的布局宽度，也不影响相邻行的宽度。

引用标签仍按原有条件显示，保留 HEAD 标记、引用分组、数量和完整名称提示；操作按钮仅在
鼠标悬停该行或焦点位于该提交内时显示。按钮出现时，标签在浮层内向左让出按钮位置。
浮层背景随行的普通或悬停状态变化，遮住下方文字，避免文字与图标叠在一起。
提交展开、打开比较、更多菜单和键盘操作沿用原有行为。

与当前对照的 VS Code 源码相比：

| 布局行为 | Ash History | VS Code History |
| --- | --- | --- |
| 隐藏的操作按钮 | 不占宽度 | 不占宽度 |
| 显示的操作按钮 | 覆盖标题右端，标题宽度不变 | 参与行内布局，占用可分配宽度 |
| 分支标签与远端图标 | 与按钮共用右侧浮层 | 参与行内布局 |

浮层由 [`SCMHistoryViewPane`](../app-ts/src/ash/workbench/contrib/scm/browser/scmHistoryViewPane.ts)
组织，定位、显隐和背景由 [`scm.css`](../app-ts/src/ash/workbench/contrib/scm/browser/media/scm.css)
负责。这条规则只适用于 History 提交行；Changes 文件行和分组工具栏保留各自的布局规则。

[`History smoke tests`](../app-ts/test/smoke/areas/windows/scm-history.spec.ts) 已在网页与 Electron
验证 280px 侧栏中的长标题、分支和远端标签、悬停与键盘焦点下的宽度不变、更多菜单及打开比较，
覆盖 Ash 的深色、浅色和两种高对比主题。

## SCM Graph 操作

提交行的右键菜单和 Shift+F10 提供查看、比较、检出、创建分支、拣选、复制和 Chat 操作。
创建标签放在“更多”中；分支标签上的菜单提供切换、比较和删除，当前分支及其他工作树占用的分支
不显示删除入口。标签可通过 Tab 聚焦，Enter 打开菜单，Escape 返回原焦点。

| 操作 | 行为 |
| --- | --- |
| 打开改动 | 所选提交与第一父提交比较；root commit 与空树比较 |
| 任意比较 | 选择左侧分支、标签或输入提交引用，右侧固定为所选提交 |
| 远程比较 | 当前提交上的本地分支须有本地已存在的远程跟踪引用；不会主动 fetch |
| 共同祖先比较 | 选择另一个引用，左侧使用它与所选提交的 merge base |
| 创建分支 / 标签 | 固定在所选提交创建；创建分支不会自动切换 |
| 检出 | 切换本地分支；从远程引用创建跟踪分支；或确认后进入 detached HEAD |
| Cherry Pick | 将所选提交拣选到当前分支；merge commit 先选择父提交，冲突交给现有解决流程 |
| 复制 / 浏览器 | 复制完整 hash 或含正文的提交说明；已识别的 GitHub、GitLab、Bitbucket remote 提供提交网页 |

比较编辑器和各文件保留已解析的基准提交 ID，分支后续移动不会改变已打开的内容。菜单读取分支与
catalog，不重启 `git/graph`，保留正在消费的分页。Git 命令、引用解析、路径过滤及写授权由 Rust Git
服务执行；SCM 消费通用 history/ref 能力，Git contribution 注册 Git 操作。协议语义见
[`ash-app-server-api.md` 的 Git SCM](ash-app-server-api.md#git-scm)。

## SCM 与 Git 的分层决策

VS Code 的 SCM Workbench 不执行 Git，也不定义 Git wire DTO；Git provider 把 repository、resource
group、history item、reference 和 command 投影成 SCM contract。Ash 应保持同一依赖方向，但不照搬
VS Code 的 extension-host 进程布局。

前端 Git 的服务契约、实现和专属命令位于 `app-ts/src/ash/workbench/contrib/git/`；SCM 的视图和通用展示
留在 `workbench/contrib/scm/`。Git 命令 ID 由 `contrib/git/common/gitCommands.ts` 提供给欢迎页和状态栏。

| 层级 | 长期 owner | 当前状态 | 边界判断 |
| --- | --- | --- | --- |
| Workbench SCM | repository registry、通用 history contract、Changes、历史图展示和 Editor 打开语义 | Changes、状态栏和历史图均通过 SCM contract 消费 provider | 不直接消费 `IGitService` 或 Git 状态 |
| Desktop Git provider | 把 `IGitService` 的仓库、资源组、提交输入、状态栏命令、refs、history 和历史 Chat 上下文映射为 SCM contract | `GitSCMContribution` 注册每个仓库的 `GitSCMProvider` 和 `GitHistoryProvider` | 只拥有前端映射，不拥有 Git RPC 或 Git output parsing |
| Desktop `IGitService` 与 Git API adapter | 前端 Git 契约、固定操作目标仓库、连接事件和 typed `git/*` transport | 已接入分支、独立 worktree、整合流程、stash、tag、remote、提交修改和部分暂存 | 保持 Git 专属；普通 UI 不消费生成 DTO；不改名为 SCM service |
| App Server `GitRuntime` / `GitService` | Git operation serialization、`Authorization<InspectRepository>` / `Authorization<MutateRepository>`、repository projection 与通知 | 已实现 | 保持 Git 专属；不新增仅转发 Git DTO 的 `scm/*` facade |
| `ash-git` | Git executable、命令、解析和 failure semantics | 已实现 | 与 SCM UI 无依赖 |
| `git-turn-changes` | 按 Session/Thread/Turn 捕获 Git tree、归属 Tool 写入、维护 ChangeSet 与提交状态 | 已实现 | 只接受 Git repository，不拥有 Thread 目录或 GitHub Issue |
| `worktree` | 组合 `ash-git` inventory、维护 Thread 独占 checkout/目录和持久化绑定 | 已接入 App Server 的 Thread 创建与恢复 | 不拥有 Turn 归属、摘要或提交状态机 |

Changes、状态栏和前端历史图由通用 `ISCMService`、repository/provider 和 history contract 接收 Git provider。
不能让
`ISCMService` 直接暴露 `GitStatus`、`GraphPage`、`git/commitFile` 或 `fetch/pull/push` 方法；这些能力
应由 provider 以 resource group、history item change、status bar command 和 menu action 投影。

后端只有在出现真正共享的跨 VCS authority、队列或 durability 语义时才增加对应通用层。仅为了让
目录名与前端 SCM 对齐而包装 `git/*` 会增加一层同形 DTO、模糊错误 ownership，并使未来 provider
被迫服从 Git 的 branch/index/worktree 模型，因此明确不采用。

### SCM 文件归属

以下路径相对 `app-ts/src/ash/workbench/contrib/scm/`。这些归属已由用户确认，后续对齐沿用同一决定。

| 职责 | 所属文件 | 已退出的旧文件 |
| --- | --- | --- |
| Quick Diff provider 注册与可见性 | `common/quickDiffService.ts` | `browser/workbenchQuickDiffService.ts` |
| Quick Diff 编辑器控制器、命令目标和 Peek | `browser/quickDiffWidget.ts` | `browser/quickDiffEditorController.ts` |
| SCM 活动与状态栏 | `browser/activity.ts` | `browser/scmStatus.ts` |
| SCM 配置注册 | `browser/scm.contribution.ts`；Quick Diff 配置由 `browser/quickDiff.contribution.ts` 注册，供 Sessions 独立装载 | `common/scmConfiguration.ts` |
| Quick Diff gutter 与 Peek 样式 | `browser/media/dirtydiffDecorator.css` | `browser/media/quickDiff.css` |

Ash 自有的 Agent Review 保留在 `browser/scmAgentReviewViewPane.ts`；冲突编辑保留在
`browser/scmMergeEditorInput.ts`、`browser/scmMergeEditorPane.ts`、`common/mergeConflict.ts` 和
`browser/media/scmMergeEditor.css`；仓库列表样式保留在 `browser/media/scmRepositories.css`。
这些文件不作为 VS Code 同路径对齐项。

Sessions 通过 `sessions.common.main.ts` 装载 SCM 服务和 Quick Diff contribution；普通 Workbench
继续装载 SCM 视图和 Git provider。两种窗口各自创建服务实例。Sessions 的 Editor Part 和 Quick Diff
使用同一个窗口内的 `IDiffService`；服务注册不等于已为每个 Session 目录注册 Git provider。
Sessions 同时使用共享 `EditorContextKeyController` 更新窗口的活动编辑器上下文，Quick Diff
命令才会在代码编辑器激活时进入命令面板。gutter 的位置和点击区域由编辑器管理；
`dirtydiffDecorator.css` 在该区域内绘制标记，不覆盖编辑器的内联几何。
Peek 使用共享 `ZoneWidget`，宽度与锚点按正文区域计算，避免操作按钮落到 minimap 下方。

### 尚未完成的 SCM 对齐

以上完成了已确认的文件迁移、窗口服务装配和现有 Quick Diff 行为验证，不代表 SCM 的公开契约
已经与 VS Code 全量一致。后续必须沿生产调用方迁移，不能用空声明补齐文件清单。

| 范围 | 当前差异 | 需要闭合的调用链 |
| --- | --- | --- |
| Quick Diff provider | 仍使用 `provideOriginalResource` 返回文本快照；注册、可见性和模型引用方法也使用 Ash 契约 | Git provider → URI 原始资源 → 共享文本模型解析服务 → Quick Diff model；迁移后退出旧快照接口 |
| 仓库视图 | `ISCMViewService` 只管理当前仓库；缺少可见仓库集合、排序、固定、焦点与编辑器跟随 | Repositories → view service → Changes、History、活动和状态栏 |
| 提交输入 | 输入由 provider 持有，尚未迁到 repository；验证和输入历史契约不完整 | Git provider → repository input → SCM input editor → 提交与草稿恢复 |
| History refs | remote/base ref、ref 查询、过滤和请求取消契约不完整 | Git history provider → 通用 history contract → History view |
| 浏览器职责 | `menus.ts`、`scmAccessibilityHelp.ts`、`scmRepositoryRenderer.ts` 和 `util.ts` 尚未按同路径落位 | 从现有菜单、帮助和仓库行调用方迁移其对应职责 |
| 扩展 SCM | 缺少 `common/artifact.ts` 对应能力和 SCM 的 extension-host 双向注册链 | 先明确扩展端生产入口、资源解析与生命周期，再接入 SCM registry |

## 所有权

| 层级 | 当前职责 | 不拥有 |
| --- | --- | --- |
| Desktop SCM（当前实现） | 从 provider 显示资源组、提交输入、状态栏命令和历史图；打开操作交给共享 Editor 服务 | Git process、porcelain parser、任意 host path authority |
| Git API adapter / renderer protocol client | 领域 service 组织输入并转换结果；API adapter 调用协议；protocol client 校验生成协议、配对请求并分发通知；Electron relay 只转发消息 | Git domain semantics、最终路径授权、另一份仓库状态 |
| App Server `GitRuntime` | 发现目录集合中的仓库，按 repository 串行化 operation、维护 projection/revision、消费 watcher hint、去重并发布状态 | Git command/parsing、Renderer state |
| App Server `GitService` | 冻结 canonical `Dir` 与 repository projection root、映射目录/仓库路径、持有 Tokio runtime并调用 `ash-git`；按 `InspectRepository`/`MutateRepository` 再校验读写边界 | live projection、notification |
| `ash-app-server-protocol` | Git query/mutation、`git/statusChanged`、DTO、capability 和 stable error name | process/runtime state |
| `ash-git` | system Git identity、仓库发现、porcelain-v2 snapshot、分页 graph、local/remote refs、credential-free remote identity、HEAD/worktree 文本 Diff 与增删行统计、typed mutation 与结构化 parsing | App Server lifecycle、目录产品边界、Renderer state |
| `worktree` | 同仓库 worktree 清单、按 branch/path 解析可用 target、来源目录 nested cwd 映射、Codex Desktop settings 与 `codex-thread.json` 归属 | Git process、Session lifecycle、产品目录切换、选择器 UI |


Git 操作的接入位置：

| 职责 | 源码 |
| --- | --- |
| 前端契约、仓库选择与结果转换 | [`IGitService`](../app-ts/src/ash/workbench/contrib/git/common/gitService.ts)、[`GitService`](../app-ts/src/ash/workbench/contrib/git/browser/gitService.ts) |
| 命令、输入和确认框 | [`gitBranches.ts`](../app-ts/src/ash/workbench/contrib/git/browser/gitBranches.ts)、[`gitWorktrees.ts`](../app-ts/src/ash/workbench/contrib/git/browser/gitWorktrees.ts)、[`git.contribution.ts`](../app-ts/src/ash/workbench/contrib/git/browser/git.contribution.ts) |
| 协议调用与连接 | [`Git API adapter`](../app-ts/src/ash/platform/git/browser/gitApi.ts)、[`protocol client`](../app-ts/src/ash/platform/app-server/browser/appServerProtocolClient.ts) |
| Electron 连接启动和透明转发 | [`daemon launcher`](../app-ts/src/ash/platform/app-server-daemon/electron-main/appServerDaemonLauncher.ts)、[`relay`](../app-ts/src/ash/platform/app-server/electron-main/appServerConnectionRelay.ts)、[`MessagePort transport`](../app-ts/src/ash/platform/app-server/electron-browser/appServerMessagePortTransport.ts) |
| 协议定义和生成边界 | [`Git protocol`](../ash-rs/app-server-protocol/src/protocol/git.rs)、[`request map`](../app-ts/src/ash/platform/app-server/common/generated/AppServerRequestMap.ts)、[`decoder`](../app-ts/src/ash/platform/app-server/common/generated/AppServerProtocolDecoder.ts) |
| Git 执行与部分 index 编辑 | [`references.rs`](../ash-rs/git/src/references.rs)、[`index_edit.rs`](../ash-rs/git/src/working_copy/index_edit.rs) |
| Rust 调度与通知 | [`git_operations.rs`](../ash-rs/app-server/src/server/git_operations.rs)、[`git_runtime.rs`](../ash-rs/app-server/src/server/git_runtime.rs) |

这些入口复用已有协议与连接：每个 renderer 一条独立连接，共享 profile 的 app-server daemon；没有新增 Host 或需要退出的旧 Host 注册。生成协议与 decoder 已覆盖这些方法，前端命令只依赖 `IGitService`。命令通过 `getRepository` 先取得目标 ID，后续查询、输入、确认和执行始终使用该 ID。

取消选择器或确认框会释放 UI 资源且不发送修改请求；修改请求发出后沿用后端的有限 Git 操作，不把关闭输入框当作取消执行。连接关闭仍由 protocol client 拒绝该连接的未完成请求，并取消正在处理的服务端请求；监听订阅由前端 service 释放，重新连接时重新发现仓库。脏 worktree 的删除由 Rust 拒绝；打开目录继续走工作区切换服务，编辑器未保存内容继续由 working copy 处理。会话持有的 worktree 仍由会话生命周期管理。

Thread 提交不走普通 `git/commit`。`git-turn-changes` 保存每轮不可变 before/after tree，
用户从同一 Session / Thread 选择一轮或多轮的部分文件。Git 对象能力按捕获顺序重放选中 delta，
随后 `ash-git-transaction` 准备固定目标 HEAD 与最终 commit 的预览。确认只发布这份准备结果，
目标在预览期间移动时必须重新预览。

每个 Thread 使用独立受管目录；提交读取保留对象，不读取或改写正在执行的 Thread 内容。
目标 checkout 原有 staged / unstaged / untracked 内容分别保留，目标 ref 使用条件更新，
安装 checkout 前再次比较 tree。Git 成功后原子保存精确文件选择的回执，随后确认并清理事务日志；
重启恢复原事务身份，避免已发布却未记账造成重复提交。部分提交的 Turn 保留全部历史并可提交剩余文件。

捕获完整性和实际文本冲突决定可提交性；工具读范围作为审阅提示，不强制整轮提交。跨 Session / Thread
组合和行/块级 Turn 选择不属于本次能力。普通 SCM 的行/块暂存仍由工作区能力提供。

## 当前状态

当前已经实现 status 与常用用户 mutation 的完整纵向切片：

- App Server 从具备 `InspectRepository` 的目录 Grant 发现仓库，并在存在可用仓库时声明 `initialize.capabilities.git = true`；
  只有具备 `MutateRepository` 的仓库才能执行 mutation；
- `git/repositories` 返回稳定、目录相对的 repository identity；`git/status` 与其他 query/mutation 接受可选 `repositoryId`，省略时选择排序后的首个仓库；文件 mutation 只接受仓库相对路径，Rust 边界拒绝绝对路径、空路径和父目录逃逸。worktree 请求使用后端清单返回的 `checkoutRoot`，后端重新检查归属和可用性；
- 授权目录位于更大 repository 内时，App Server 会过滤 repository 其他目录并把 path 重新映射为
  directory-relative；mutation 则把合法目录 path 映射回 repository-relative path；
- 每次请求重新打开仓库并读取 authoritative snapshot，不把旧 snapshot 当作 mutation 前提；
- response 保留 HEAD branch/detached/unborn、upstream ahead/behind、index/worktree 状态、
  rename original path、conflict 和 submodule flags，并带 `repositoryId`、directory-relative `path`、
  Git runtime `streamInstanceId` 与在该实例内单调递增的 repository status revision；协议不暴露
  仓库状态的 host 绝对路径；worktree 接口返回经后端解析的绝对目录，用于选择和打开工作区；
- `git/stage`、`git/unstage` 和 `git/discardWorktree` 使用明确 path set；discard 只恢复 tracked
  working-tree 内容，不删除 untracked 文件，Desktop 在执行前要求确认；
- `git/commit` 从 stdin 传入经过校验的 message，并返回新 commit object ID；
- `git/textDiff` 返回 repository-scoped status、受限 UTF-8 HEAD/worktree 文本与增删行统计；
- `git/branch/list` 返回现有本地分支，`git/branch/switch` 只接受 branch name，并在 host 重新解析为
  当前仓库真实分支后执行切换；
- `git/graph` 首次接受有界 `limit`，后续使用不透明 `cursor` 继续同一次 `git log --topo-order`
  traversal；起点为 local/remote/tag refs 和当前工作树 HEAD，排除仅由 stash、内部引用或其他工作树
  detached HEAD 保留的提交；游标启动时读取一次 refs 和 configured remote identity，并通过 `hasMore` 与
  `nextCursor` 表示是否还有下一页。remote identity 只保留 provider、host、owner、repository，原始
  URL、token 和 `gh` 登录配置不会进入协议；状态变化、mutation 或连接关闭会使游标失效；
- `git/fetch` 接受 `mode: "default" | "all"`；省略时沿用 all-remotes prune，默认远端模式执行 `git fetch --prune`。手动 Fetch 仍获取全部远端。`git/pull` 仅允许 fast-forward，`git/push` 使用 Git 当前
  upstream/default 配置；所有 remote operation 都是 non-interactive；
- 文件、提交和切分支操作返回新的 `GitStatusResult`；创建/删除分支返回分支列表，后端同时推进状态 revision、清理旧 graph cursor 并通知所有连接。worktree 操作返回路径或清单，不改变当前检出的分支；首次打开 View 也会自动刷新；
- App Server 监听已授权目录、Git metadata 和目录上层 repository `.gitignore`，以 100ms
  debounce 合并 burst；事件只触发重新查询，不直接成为 Git 状态；
- 忽略装饰使用独立的 `git/ignoreChanged` 通知：普通文件变化只查询相关路径，嵌套 `.gitignore`
  变化只查询所在目录。index、`info/exclude`、Git 配置（包括 include）和 Git 解析出的全局排除
  文件变化查询对应仓库；这些文件在工作区外也纳入监听。前端保留已完成的颜色直到查询结束，
  合并异步完成通知并跳过相同结果；查询取消通过操作 ID 传到后端，终止排队或正在执行的 Git 查询；
- watcher 比较 HEAD、文件、分支、标签、remote 配置、stash 和整合状态；外部命令仅修改引用也会推进 revision、清理旧历史分页并通过 `git/statusChanged` 通知所有连接。实际状态未改变时保留 revision 和分页；
- 已授权目录即使尚无仓库也持续监听。外部 init、嵌套仓库创建、移动或删除会更新仓库清单，并发送 `git/repositoriesChanged {}`；客户端重新查询 `git/repositories`。仍存在的仓库保留原有状态流和分页，不因清单扫描重新创建；
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

`worktree` 已能从任意 repository nested cwd 列出 primary、linked、locked 与 prunable checkout，并按 branch 或 checkout path 返回可用 worktree target。它还在 Thread 执行前创建持久化的独占受管目录：Git 默认使用 detached linked worktree，显式新分支请求同时创建本地分支与 linked worktree；非 Git 使用一次性隔离目录副本，不创建 ChangeSet。失败时 Thread 创建失败，不会转回来源目录。

`ash code` 首页“新建工作树”打开同仓库选择器；用户可独立创建 detached 工作树，创建后停留在列表并选中新目录。选择已有或新建的工作树时，TUI 先通过 `git/worktree/resolve` 重新验证，再由本地或 Remote host 连接到以该目录为根的 App Server。这个操作不新建 Session，也不改变原会话的目录；随后提交任务才开始新 Session，新 Thread 以所选目录为来源建立自己的受管工作树。工作树选择器不打开已绑定其他 Thread、锁定或失效的目录；选中其他干净、未绑定的关联工作树后按 `d` 可确认删除。顶部“项目分支”面板提供基于 HEAD 新建本地分支、切换现有分支，以及对非当前分支按 `d` 确认删除；Git 拒绝未合并或在任一工作树中检出的分支。

稳定失败边界包括 `GitUnavailable`、`GitNotRepository`、`GitOperationFailed` 和部分暂存内容已变化时的 `GitIndexChanged`。内部 executable、
stderr 和非 UTF-8 path 不进入 Renderer；工作树的绝对目录路径是供用户选择的显式数据。

## 当前限制

- `GitRuntime` 已支持目录集合中的 multi-repository registry。Workbench 通过 `ISCMService`
  注册仓库、由 `ISCMViewService` 选择当前仓库；Git provider 提供 Changes 资源组、输入框、状态栏命令、
  历史记录和冲突操作。SCM 视图从 provider 读取这些数据，不直接读取 Git 状态；
- 交互 Git 写入和 Turn 目标发布按仓库 common directory 共用操作锁；连接取消会中止已接入取消信号的 Git 请求，但尚无用户可见的 queue、progress 或取消按钮；
- App Server 已支持分支改名、远端分支删除和 tag 管理；不提供强制删除或凭据提示；
- 部分暂存要求每侧文本不超过 2 MiB，且 diff 满足后端计算上限；冲突、重命名、子模块、二进制和非 UTF-8 内容不能部分暂存；
- pull 固定为 fast-forward only；discard 不删除 untracked 文件；
- 当前 registry 来自已授权目录集合，不接受客户端提交任意 repository root；
- 工作树 change row 尚未接入 editor diff/open workflow；history changed-file row 已支持打开
  commit/parent 文本 Diff。
- `git/graph` 展示本地分支、已 fetch 的远端分支、标签和当前 HEAD 可达的提交；当前不会读取 `~/.config/gh/hosts.yml`，
  也不会调用 GitHub API，因此尚未提供 PR、Checks、review 或实时远端分支状态；这些属于独立的
  provider connector/权限能力，不能由 SCM graph 猜测；

这些限制必须在 UI 中保持可见：未实现的 mutation 不注册空命令，也不显示会误导用户的按钮。

## 分阶段演进

近期扩展顺序：

1. 为长时间 remote operation 增加 progress、queue state 和 caller cancellation；
2. 为工作树 change row 接入 diff/open，并补充更细粒度的错误 UI；
3. 在明确的 connector/权限 contract 下接入 GitHub PR、Checks 等 provider data；
4. 按明确产品语义增加 branch lifecycle 等额外 mutation，并让已接受该产品需求的
   UI consumer 消费同一协议。协议存在不自动使其成为 TUI 功能。

长期不变量是：Desktop、Native 与 TUI 不直接执行 Git；App Server adapter 不复制 Git
command/parsing；watch event 只触发重新确认，不能自身成为 repository truth。

### 封闭 intent 与状态发布

`git/command` 的参数是生成的封闭联合类型，不接受命令行或任意 Git 参数。前端先固定
`repositoryId`，再打开选择或确认界面。Rust 在同仓库操作锁内校验权限、读取真实状态并执行。
整合、储藏和提交操作涉及整个 checkout，不能通过仅覆盖仓库子目录的授权执行。
即使 Git 命令失败或连接取消，也会重新读取状态并通知所有连接；引用变化同时使旧历史分页失效。

`git/indexDiff` 返回文本及更改块，`git/indexEdit` 接收这次比较的两侧文本和块或行选区。
锁定 index 后内容不同就拒绝修改，前端必须重新查看更改；不重试旧选择或应用任意客户端补丁。
普通文件编辑器中的未保存更改需要先确认保存。取消暂存选区使用源代码管理打开的当前 staged 比较。
