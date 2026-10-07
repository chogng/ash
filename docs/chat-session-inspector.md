# Chat Session Inspector 与 Turn 变更账本

> 状态：已实现。本文描述 Chat 内 Session Inspector、Thread 目录绑定、Turn ChangeSet 和异步提交的当前契约。
> Session、Thread、Turn 的基础语义见 [`protocol.md`](protocol.md)，接口见
> [`ash-app-server-api.md`](ash-app-server-api.md)，Git 行为见 [`git.md`](git.md)。

## 快速理解

Session Inspector 始终跟随 Chat 当前选中的 `Session + Thread`，正式提供四个区块：

| 区块     | 内容                                                        |
| -------- | ----------------------------------------------------------- |
| Plan     | 当前 Thread 最近一个结构化 Plan                             |
| Threads  | 当前 Session 的父子 Thread 拓扑，可切换 Thread              |
| Activity | 当前 Thread 最近的 Turn 状态与工具数量                      |
| Changes  | 按 Turn、仓库列出的不可变 ChangeSet、提交信息与后台提交状态 |

它与 transcript 共用 `ChatWidgetModel` 已有的 `thread/read + subscribe + cursor`，不会为 Inspector
再开一条 Thread 订阅。旧的 Chat 私有 Agent Sidebar ViewContainer、View 和全局开关已经移除；
Workbench 通用 Agent Sidebar 不受影响。

## 执行 Trace

执行 Trace 编辑器、命令和无障碍支持由 `workbench/contrib/trace` 共享提供。普通 Workbench 的
“开发人员：打开执行 Trace”（`ash.agentTrace.open`）打开可导入的页面；命令传入 Session ID 时读取
该会话。Sessions 的“查看执行 Trace”（`sessions.trace.open`）取得当前 Session ID，切换 Code 布局，
再调用同一个 Workbench 命令；没有当前会话时仍可导入 Trace。

编辑器打开 Session 的持久历史，按 Thread、Turn 展示事件；子 Thread 嵌套在父 Thread 下。每个 Thread 保留
自己的 sequence，不建立全局 Session 顺序。模型调用、用量、工具参数及结果、压缩、失败和取消
可以从事件详情查看。

界面通过 Chat 领域服务调用 `session/trace/read`，增量读取历史，再按现有 Thread 订阅跟随新事件。
订阅 snapshot 补齐读取与订阅之间的空窗；共享 Chat 服务传递当前 Session 的 `session/changed`，
触发读取以发现新子 Thread，编辑器不依赖 Sessions 目录服务。隐藏或关闭
编辑器释放其订阅，重开读取后续历史；迟到的请求结果不会写回已关闭或切换的编辑器。

筛选和“仅显示错误”只影响显示，导出保留全部已加载事实。导入支持评测保存的版本 3 rollout Trace，
原始 envelope、共享历史前缀和未知字段保留；正文与执行关系也随导出保存。导入／导出限制为 64 MiB。
评测命令和用例来源见 [任务评测](../test/agent-eval/README.md)。

需要模型请求证据时，在启动 App Server 前设置 `ASH_ROLLOUT_TRACE_ROOT=/absolute/local/directory`。
运行时启动时读取该开关；修改后需重启拥有 Thread 的 App Server。记录只写本地目录，不上传，
失败不会改变 Turn 的执行结果。启用后记录 Agent、上下文压缩与工具内辅助模型的每次 attempt，
包括失败重试、取消，以及终止前收到的部分输出；进程退出时仍未结束的 attempt 保留为未完成事实。

“查看请求／响应”按需读取所选正文，并区分 Core 请求与附件转换后的 ModelService 请求。
这些是 provider-neutral 语义输入，尚不包含 provider adapter 生成的 HTTP/WebSocket 字节，也不保存
逐个 stream chunk。未启用、正文省略、存储不可用和不完整捕获都会明确显示；不能用当前上下文
推测缺失的历史请求。正文可以包含用户和工具内容，分享导出前按实际数据审阅。

“查看执行关系”按需读取从已保存事实归纳的关系，连接模型 attempt、工具及结果、Code Mode cell、
运行时调用、终端操作、委派和消息投递；选择关联可以跳到源事件。关系不会改写业务历史，也不被用于
恢复执行。诊断使用捕获内独立序号，与 Thread sequence 分开。启用诊断时，显示中的编辑器每秒读一次
新增观察；隐藏或关闭会停止轮询并释放订阅。

Tab 在控件、所选事件和可选择的 JSON 详情之间移动；方向键、Home 和 End 选择可见事件。
界面提供无障碍帮助、Accessible View、verbosity 设置、主题色和中文词条。

## Turn 边界

“一条消息”不自动等于一个 Turn，边界以 Core 真正开始和结束一次执行为准：

| 事件                            | Turn 语义                                                                                    |
| ------------------------------- | -------------------------------------------------------------------------------------------- |
| Thread 空闲时发送用户消息       | 创建新 Turn                                                                                  |
| Turn 运行中补充消息（steering） | 仍属于当前 Turn，并进入该 Turn 的摘要上下文                                                  |
| Goal 自动续跑                   | 创建新的 Turn                                                                                |
| shell Turn                      | 独立 Turn；读取范围按不透明操作保守处理                                                      |
| failed / interrupted            | 仍封存 ChangeSet，界面显示 terminal 警告                                                     |
| 子 Agent spawn                  | Git 子 Thread 从 provision 时捕获的父 worktree tree 创建；非 Git 子 Thread 复制当时的父目录  |
| Fork                            | Git Thread 从 `parentSequence` 对应的最后一个封存检查点创建；非 Git Thread 复制当时的父目录  |
| Rewind                          | Git Thread 从目标 Turn 的 before 检查点创建；非 Git Thread 没有 ChangeSet，因此不提供 Rewind |

Git Turn 开始前必须成功捕获 baseline。失败时该 Turn 不获得写工具；Turn terminal event、Hook 和执行任务
结束后才封存 after 检查点。封存失败时现场保留，提交不可用。

## Thread 目录绑定

每个 Thread 在允许执行前必须先获得持久化的独立目录绑定：

- Git 目录使用受管 linked worktree，Thread checkout 与提交目标分支分离；创建时绑定的目标分支不会随主界面切换而变化。
- 非 Git 目录使用一次性隔离目录副本，不初始化 Git，也不创建 ChangeSet；Turn Changes 只对 Git repository 可用。
- 来源目录创建 Thread 时的已有内容成为不可变初始 baseline，不属于任何 Turn。
- Session 结束后，Git Thread 只有在 ChangeSet 全部 committed 或 discarded 后才具备清理资格；非 Git Thread 没有 ChangeSet。

界面和协议只暴露 `managedWorktreeId`、`sourceDirId`、仓库/分支和 baseline 摘要，不暴露受管目录内部路径。

普通 Thread 目录绑定围绕一个来源根建立，可以包含该根中的多个嵌套 Git 仓库；Session 另外获得的独立目录不会自动进入该 Thread 的 Turn ChangeSet。每个子 Agent Thread 使用自己的受管目录绑定和 ChangeSet，不建立额外的工作尝试身份。

## ChangeSet 状态

每个 Turn、每个捕获目标形成一个 ChangeSet。三个状态轴互不折叠：

| 状态轴         | 值                                                                                |
| -------------- | --------------------------------------------------------------------------------- |
| `captureState` | `open / sealed / incomplete / discarded`                                          |
| `messageState` | `unconfigured / queued / generating / ready / failed`                             |
| `commitState`  | `idle / partiallyCommitted / queued / committing / committed / conflict / failed` |

`open` 实时显示变化；只有归属完整的 `sealed` 文件可进入提交选择。`incomplete` 表示工具生命周期
之外的写入或未知写入结果，禁止提交。执行 failed/interrupted 与捕获完整性独立，已完整封存的变化仍可选择。

工具调用携带 Session / Thread / Turn 身份。Hook 和写工具记录执行窗口；文件监听只刷新观察结果。
归属不明明确标记，不根据文件名或共享目录差异猜测 Session。read 范围、早先 Turn 和来源 baseline
依赖是审阅提示；实际应用由选中 delta 决定，不因同一文件被多轮编辑就强制整轮提交。

`TurnChangeSet` 是捕获证据；提交是独立的 `TurnCommitRecord`。成功记录保存精确选择，
`committedPaths` 和 Turn 提交进度由回执计算。一轮可以部分提交，已提交项仍可读取但不可重复选择。

## 选择文件、预览和提交

1. 在 Changes 中键盘或鼠标多选一轮或多轮的文件，固定当前 Session / Thread；每次仅选择一个仓库。
2. 输入消息并准备预览。后端校验归属、revision、封存证据与选择占用，按实际捕获顺序重放所选文件变化。
3. 查看最终目标分支 Diff。预览固定消息、选择和目标版本；确认按钮只发布该 prepared commit。
4. 请求持久排队后可以继续执行 Turn。目标在预览期间移动时返回冲突，重新预览后才能再次提交。
5. 成功回执原子标记选中的文件；未选文件保留，下一次可继续选择。切换 Session 清空界面选择。

文件变化整体选择，包括重命名两侧、删除、mode 与二进制；本次不提供行/块级 Turn 提交，也不提供
跨 Session / Thread 合并或跨仓库原子提交。二进制和超限正文不会伪装成完整文本 Diff。

## “提交上一轮，当前轮继续运行”

提交只读取已保留的不可变对象，当前 Turn 可以继续在独立 Thread checkout 写入。提交历史 A 不会
读取 B 的正文或改写 B 的目录。准备时将选中 delta 应用到目标 HEAD；确认期间目标移动要求重新预览。
同文件互不重叠的文本变化可以合并，实际重叠明确返回冲突。

目标 checkout 原有 index、未暂存和未跟踪内容分别保持；ref 条件更新和安装前的 tree 比较检测外部修改。
事务 journal 与对象保留引用支持中断恢复。先保存 Git 发布结果和精确选择回执，再确认事务；数据库结果
未知时保持 Publishing，重启恢复同一 commit。进行中的提交阻止 Session 删除，避免丢失恢复记录。

封存记录保存对象库位置，Thread checkout 清理后仍能查看历史文件和提交预览。丢弃按 Thread 为单位，
无运行中 Turn、用户明确确认后，重建“初始 baseline + 精确已提交文件 delta”，再丢弃剩余记录。
部分提交不能使尚有未提交文件的 Thread 自动具备清理资格。内部快照引用的空间回收限制见
[能力方案](git-capabilities.md)。

## 提交信息

自动生成使用 `agent.commitMessageModel` 指定的 exact provider/model，不借用当前 Agent 模型。未配置或未对当前目录
授权 exact provider/model/endpoint 时，状态为 `unconfigured`；用户仍可填写 draft。

输入严格截止目标 Turn terminal 边界，只含可见用户/Agent 消息、该 Turn steering、Goal、Plan、受限工具结果摘要和
不可变 diff。Reasoning 与后续 Turn 被排除；疑似凭据所在行会在发送前替换，二进制正文不进入请求。生成结果默认要求
Conventional Commit subject，可按需带 body。

模型候选与用户 draft 分开保存。生成完成或重试不会覆盖已经编辑的 draft。最终提交只硬性校验非空、NUL 与大小；
非 Conventional 文本只由界面提示，不阻断用户提交。

## UI 与无障碍

- 大于等于 720px 时 Inspector 与 transcript 并排；更窄时为右侧可关闭抽屉。
- 抽屉支持关闭按钮和 `Escape`，关闭后焦点返回触发控件。
- Thread tree 使用 tree/treeitem 语义，异步生成与提交结果使用 status/alert 语义。
- Changes 卡片明确显示 running/sealed/incomplete、failed/interrupted、依赖、归属不明、摘要失败和提交冲突。
- 提交点击后立即进入后台状态，用户可继续发送消息和运行 Agent。

## 主要接口

- `turnChanges/list`
- `turnChanges/read`
- `turnChanges/readFile`
- `turnChanges/generateMessage`
- `turnChanges/updateDraft`
- `turnChanges/prepareCommit`
- `turnChanges/readCommit`
- `turnChanges/readCommitFile`
- `turnChanges/commit`
- `turnChanges/discardThread`
- `turnChanges/changed`

所有修改请求包含 `commandId`。准备选择包含每份 ChangeSet 的 `expectedRevision`；确认使用固定的 `commitId`。相同 command/payload 会返回首次持久化的响应；相同 command 配不同
payload 会失败，不会重复执行后台任务。
