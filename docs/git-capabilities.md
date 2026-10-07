# Git 能力划分与 Session 文件变化提交

本方案实现两个目标：Git 各项能力有明确的接口与所有者；多个 Session 修改同一仓库时，用户能按
Session、Turn 和文件选择准确的变化提交。状态：本文范围内的实现与验收已完成，结果记录在末尾；现有行为见
[Git 总览](git.md) 和 [Turn 变更记录](chat-session-inspector.md)。

## 用户目标

用户在长 Session 中查看每轮 Agent 修改的文件，选择一部分文件变化提交，也能组合多轮的选择。
两个 Session 即使同时修改同一文件，也分别保留自己的版本；提交一个 Session 的变化不会把另一个
Session 的未提交修改带入。已提交部分文件的 Turn 仍可查看全部历史，并继续选择剩余文件。

提交操作固定 Session、Thread、仓库、目标分支、所选变化版本和消息。切换界面选择、后续 Turn
继续执行、目标分支移动或请求重放，都不能改变已保存的提交内容。

## 能力边界

| 能力       | 目标行为                                                 | 明确限制                                                                   |
| ---------- | -------------------------------------------------------- | -------------------------------------------------------------------------- |
| 修改归属   | 按 Session / Thread / Turn / repository 保存文件变化     | 不依据文件名推断唯一 Session；不从共享工作目录的并发修改猜测来源           |
| 编辑隔离   | 每个执行 Thread 使用独立工作目录，同仓库共享对象库       | 单独的提交锁不能代替编辑隔离；非 Git 隔离目录不生成 Git ChangeSet          |
| 文件选择   | 选择一轮中的部分文件，或同一 Thread 多轮的文件变化       | 一项文件变化整体选择；本次不实现行或块级 Turn 提交                         |
| 多仓库     | 每个仓库独立提交并显示结果                               | 不宣称不同仓库之间存在原子提交                                             |
| 提交归属   | 每个 commit 记录精确选择，部分提交后剩余变化可继续提交   | 不把整个 Turn 标记为全部已提交；不重复提交同一项变化                       |
| 提交目标   | 发布到所属仓库的目标本地分支，使用仓库配置的作者与提交者 | 不自动 push；对象提交不执行 commit hooks                                   |
| 历史读取   | 使用捕获并保留的 before / after Git 对象                 | 不用当前磁盘内容替换历史版本；不携带后续 Turn 的内容                       |
| 变化应用   | 将选中 delta 重放到目标分支，预览最终差异并确认该版本    | 文本应用成功不代表业务依赖或构建正确；冲突须先解决再提交                   |
| 并发提交   | 目标发布与交互 Git 写入共用操作锁，并使用 ref 条件更新   | 进程锁不阻止外部 Git；外部修改通过 ref 和 checkout 版本比较检测            |
| 恢复与重放 | 提交请求、结果和事务恢复信息持久化                       | 相同 command ID 改参数返回冲突；未知结果不产生第二次提交                   |
| 保留与清理 | 未提交变化的快照随记录保留，目录清理由所属领域协调       | 未提交文件不能因其他文件已提交而失去快照或被误清理；内部快照目前不自动回收 |

跨 Session 合并提交不是本次入口；各 Session 分别选择自己的变化。跨 Thread 的执行目录和变化
记录保持独立。文件重命名同时保留原路径与新路径，二进制文件、删除和模式变化仍按 Git 对象处理，
文本预览不能展示的内容必须明确告知用户。

空间保留限制：Thread checkout 清理不会删除捕获或 prepared commit 引用，历史仍可读取。
Session 删除会删除账本与提交记录，但本次未实现 `refs/ash/changes` / `refs/ash/turn-commits` 的
自动空间回收；这些引用继续保留对象，长期使用会增加对象库大小，不进入普通 SCM 历史遍历。

## 领域所有权

| 所有者             | 职责                                                                          | 不承担的职责                                   |
| ------------------ | ----------------------------------------------------------------------------- | ---------------------------------------------- |
| Git 基础设施       | system Git 执行、仓库身份与探测、进程期限与取消、按 common directory 协调写入 | Session / Thread / Turn 生命周期               |
| Git 工作区能力     | status、index、部分暂存、工作文件比较、普通提交与 checkout 状态保持           | Turn 修改归属                                  |
| Git 历史能力       | graph 分页、提交详情、历史内容和版本比较                                      | stash / 内部快照作为历史遍历起点               |
| Git 引用与整合能力 | 分支、标签、stash、检出、merge / rebase / cherry-pick                         | 受管目录的位置与 Thread 归属                   |
| Git 远端能力       | remote 配置、身份与 fetch / pull / push                                       | GitHub API 授权                                |
| Git 对象能力       | tree / blob、捕获、保留、选择 delta、重放与对象包完整性                       | 任务投递包、重试和回执                         |
| Git 工作树能力     | worktree 清单、创建、锁定、修复与删除                                         | Thread 绑定与删除资格                          |
| Git 提交事务       | 提交准备、条件发布、checkout 安装、事务日志与恢复                             | ChangeSet 的可选范围和提交进度                 |
| `worktree`         | Git / 非 Git 受管目录物化、绑定、恢复与清理                                   | Turn 文件变化记录和 Git 命令解析               |
| `git-turn-changes` | 捕获归属、Turn 文件变化、选择校验、提交记录与进度                             | Git 子进程、目录物化和传输 DTO                 |
| `state`            | 领域存储接口的 SQLite 实现、原子写入与存储格式迁移                            | 提交资格和变化组合规则                         |
| `task-delivery`    | 任务包、来源和目标身份、持久重试、接收与回执                                  | Git 对象编码、Thread 目录管理和 Turn 执行状态  |
| `github`           | GitHub 授权、Issue / PR / checks API                                          | 本地 Git 状态与工作树                          |
| App Server         | 授权、请求调度、协议转换、通知与跨领域装配                                    | ChangeSet 提交资格、依赖结算和 SQLite 业务状态 |
| Renderer           | 展示、文件选择、Diff、提交消息和交互资源                                      | 持久化修改归属与 Git 执行                      |

Git 能力模块拥有实际实现和类型。提交事务具有独立持久化生命周期，放入独立 crate，依赖 Git
对象、引用和工作区的类型化接口。Git 底层不反向依赖事务、`worktree`、`git-turn-changes` 或
App Server。所有 Git 命令仍由同一个执行实现处理，不为拆 crate 暴露任意命令接口。

## 数据与状态

### TurnChangeSet

每个 Turn / repository 一份记录，保存 Session、Thread、Turn、repository 身份、捕获状态、
before / after tree，以及文件变化列表。文件变化由路径、原路径、两侧 blob、两侧 mode 和 kind
定义；身份固定在这份不可变记录内。提交消息与提交结果不能改写已封存的变化证据。

捕获状态继续区分运行中、已封存、捕获不完整与已丢弃。失败或中断的 Turn 可以保留已成功封存的
变化，执行结果和捕获完整性分别显示。运行中的 Turn 可以查看，不能作为稳定提交选择。

### 提交请求与记录

一次请求保存独立身份、所属 Session / Thread、目标仓库 / 分支、按 Turn 顺序排列的文件选择、
各记录的期望 revision、不可变证据身份、提交消息、准备结果和执行状态。选择不能为空，同一
ChangeSet / 文件不得重复；重命名是一个变化，不能拆开两侧。

已发布的记录包含 commit ID 和精确选择。Turn 的提交进度从这些记录计算，允许未提交、部分
提交和全部提交。提交执行状态属于请求：排队、执行、成功、冲突或失败。失败请求可以保留以便
查看原因，但不会把选中的变化标为已提交。

旧数据中的整轮提交结果在存储迁移时转换为覆盖该轮全部文件的提交记录。旧排队工作在迁移时冻结
已持久化的消息与整轮选择，保持原事务身份以恢复 Git 发布结果；不能重新读取当前 draft 来替换已排队内容。

## 提交流程

1. 列出当前 Session / Thread 的 Turn 文件变化与提交进度，已提交项保留可读但不可再次选择。
2. 用户选择文件变化。服务端验证归属、revision、捕获状态、目标仓库与分支，以及已提交或正在
   提交的选择；客户端提供的路径只用于定位已保存记录，不能指定任意磁盘文件。
3. Git 对象能力从每轮 before / after 构建只包含所选文件的 delta，并按真实 Turn 顺序应用到
   目标版本。未选文件不进入结果。先前 Turn 的未提交修改不会因后续文件版本而被整份复制进去。
4. 显示最终 commit Diff、选中的来源和提交消息。准备结果固定目标版本与选择证据；用户确认后
   发布该准备结果。目标在确认期间变化时返回版本冲突，必须重新预览。
5. 在持久化事务中保存请求、冻结消息和 command receipt，再开始后台工作。断线和切换窗口
   不改变已接受的请求，重放返回原始响应。
6. 提交事务获得仓库操作锁，恢复同身份的旧事务或发布准备结果，使用 ref 条件更新并保留目标
   checkout 原有 staged / unstaged / untracked 内容。Thread 执行目录继续保留自己的修改。
7. 原子保存发布结果与精确选择，通知有关 Turn 更新进度。只有结果持久化后才确认并清理事务日志。

实际文本冲突由选中 delta 的重放结果决定。同一路径的多轮变化不等于整个 Turn 必须依赖另一个
Turn。工具读范围可以作为审阅提示；不得据此把所有文件作为不可分的提交单位。无法确认修改
来源的内容继续明确标记，不能自动归到某个 Session。

## 界面与协议

现有 Changes 入口按当前 Session / Thread 显示来源与文件变化，支持键盘多选、打开历史 Diff、
选择预览与提交。切换 Session 清理选择，迟到响应不能修改新 Session 的界面。已提交、运行中、
捕获不完整、冲突与失败状态都给出可读原因。

前端共享 Chat 领域契约承接选择与提交能力；协议 DTO 只进入 adapter。Rust 协议定义生成 request
map、decoder、TypeScript 类型与 schema，生产与测试调用方同批迁移。复用现有 per-renderer
连接，不增加进程、relay 路由或另一份前端业务状态。

所有新增文案进入 NLS，更新简体中文词条。复用现有 Changes 无障碍帮助、Accessible View 与
verbosity 设置，补充选择、预览、部分提交和结果内容；焦点与选择分别表达。

## 实施与验收

| 工作                   | 完成条件                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------- |
| Git 能力与提交事务拆分 | 实现、类型、全部生产调用方和测试同步迁移；无重复执行器、任意命令出口或反向依赖               |
| Turn 选择与提交记录    | 单轮部分选择、多轮选择、重复与已提交选择校验、状态与消息冻结，以及旧数据迁移均有测试         |
| Git 对象选择与发布     | 新增 / 删除 / 重命名 / 二进制 / mode、多轮同文件、冲突和目标移动由真实 Git 仓库验证          |
| 多 Session             | 同仓库不同 Thread 目录同时编辑；分别提交、同文件冲突、无串入修改和共享锁均有流程测试         |
| 持久化与恢复           | command 重放、断线、进程中断、已发布未记账、部分提交后继续提交、清理资格均有测试             |
| 协议与界面             | 生成与 strict check 通过；Browser、Electron UI 和连接真实后端的 Electron Playwright 场景通过 |
| 文档                   | 所属 README、Git 总览、Turn 文档及协议说明与最终代码一致，目标与验证状态准确                 |

先完成拥有实际生产调用方的 Git 对象与事务接口，再完成 Turn 选择 / 存储 / 提交服务，最后接入
协议与界面。每个切片都运行所属包构建、定向行为测试和 warning 检查；依赖变更运行依赖检查。
不运行未经请求的完整 workspace 测试。浏览器验证使用 DOM、状态、日志和 trace，不以截图判定。

落地后的代码位置：

| 能力                              | 当前实现位置                                                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Git 查询、普通修改与对象能力      | `crates/git/src/{working_copy,history,references,remote,objects,worktree}.rs` 及所属子目录                               |
| 目标发布、checkout 保持与事务恢复 | `crates/git-transaction/src/lib.rs`                                                                                      |
| Turn 捕获、选择、预览与提交进度   | `crates/git-turn-changes/src/{ledger,model,commit}.rs`                                                                   |
| SQLite 记录、原子占用与迁移       | `crates/state/src/sqlite/{git_turn_changes,git_turn_commits}.rs`                                                         |
| 协议与领域装配                    | `crates/app-server-protocol/src/protocol/turn_changes.rs`、App Server 的 `git_turn_changes_*` 与 `thread_dir_binding.rs` |
| 文件选择与预览确认                | Sessions Changes、`turnMultiDiffSource` 与共享 MultiDiff toolbar                                                         |

原 `git/src/graph.rs` 和测试已迁至 `git/src/history/graph.rs` 与 `graph_tests.rs`。
原 `tree_commit.rs` 的提交事务迁入新 crate；对象选择仍属于 Git。`worktree` 继续拥有目录归属和
清理，不移入 Turn 领域。`task-delivery` 与 `github` 保持各自职责，未为拆分增加工具集合 crate。

实施记录：

- [x] 完成目标、能力边界与领域职责方案。
- [x] 完成 Git 能力与提交事务拆分。
- [x] 完成文件选择、提交记录与存储迁移。
- [x] 完成多 Session 提交、恢复与清理流程。
- [x] 完成协议生成、界面与三类 Playwright 验证。
- [x] 同步现有文档并记录实际验证结果。

### 实际验证（2026-10-05，macOS）

| 验证入口                                                                                              | 实际结果                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `just verify ash-git`                                                                                 | 正常 check、87 项测试和 warning gate 通过；包含 stash / 内部引用图过滤与真实 Git 文件选择                                                         |
| `just verify ash-git-transaction`                                                                     | 正常 check、10 项测试和 warning gate 通过；覆盖 checkout 各层保持、条件发布与恢复后外部分支推进                                                   |
| `just verify git-turn-changes`                                                                        | 正常 check、9 项测试和 warning gate 通过；覆盖归属、版本、证据、捕获完成与迟到刷新                                                                |
| `just verify ash-state`                                                                               | 正常 check、92 项测试和 warning gate 通过，1 项既有测试忽略；真实 Git / SQLite 覆盖部分提交、多轮、双 Session、冻结消息、请求重放、迁移与中断恢复 |
| `just verify worktree`                                                                                | 正常 check、20 项测试和 warning gate 通过                                                                                                         |
| `just verify ash-app-server-protocol`、`just generate-protocol`                                       | 协议生成完成；正常 check、88 项单测、1 项注册同步测试和 warning gate 通过                                                                         |
| `just verify ash-app-server --filter local_git_turn_changes_seal_and_commit_a_shell_turn_through_rpc` | 正常 check、真实 RPC 流程和 warning gate 通过；部分提交后丢弃剩余文件、删除执行目录并 GC 后仍可读历史、命令重放不重复提交                         |
| `pnpm run typecheck:protocol` / `typecheck:renderer`                                     | strict TypeScript 检查通过                                                                                                                        |
| `pnpm build` / `prepare:backend`                                                         | 正常 Renderer / Electron 构建和后端产品包构建通过                                                                                                 |
| 定向前端单测（6 个文件）                                                                              | 19 项通过；覆盖中英文文案、选择刷新、Session 切换、迟到响应、非默认分支预览操作与入口注册                                                         |
| Browser UI / Electron UI Playwright                                                                   | 各 1 项通过；真实后端场景按目标条件跳过，各 1 项，未计作通过                                                                                      |
| Electron + App Server Playwright                                                                      | 2 项通过；真实后端双 Session 分别预览提交、未选文件保留，使用最新后端产品包                                                                       |
| `just dependencies`                                                                                   | 218 个 workspace members 的依赖检查通过                                                                                                           |
| 文档与格式                                                                                            | 本次文档本地链接、Rust 改动格式与 `git diff --check` 通过                                                                                         |

Rust 验证使用 `ci-test` profile。Windows / Linux 产品运行未在本机验证；未运行整个 workspace 测试。
内部引用自动回收、行块级 Turn 选择、跨 Session 合并提交与跨仓库原子发布不属于本次已完成范围。
