# Chat Session Inspector 与 Turn 变更账本

> 状态：已实现。本文描述 Chat 内 Session Inspector、Thread 目录绑定、Turn ChangeSet 和异步提交的当前契约。
> Session、Thread、Turn 的基础语义见 [`protocol.md`](protocol.md)，接口见
> [`ash-app-server-api.md`](ash-app-server-api.md)，Git 行为见 [`git.md`](git.md)。

## 快速理解

Session Inspector 始终跟随 Chat 当前选中的 `Session + Thread`，正式提供四个区块：

| 区块 | 内容 |
| --- | --- |
| Plan | 当前 Thread 最近一个结构化 Plan |
| Threads | 当前 Session 的父子 Thread 拓扑，可切换 Thread |
| Activity | 当前 Thread 最近的 Turn 状态与工具数量 |
| Changes | 按 Turn、仓库列出的不可变 ChangeSet、提交信息与后台提交状态 |

它与 transcript 共用 `ChatWidgetModel` 已有的 `thread/read + subscribe + cursor`，不会为 Inspector
再开一条 Thread 订阅。旧的 Chat 私有 Agent Sidebar ViewContainer、View 和全局开关已经移除；
Workbench 通用 Agent Sidebar 不受影响。

## Turn 边界

“一条消息”不自动等于一个 Turn，边界以 Core 真正开始和结束一次执行为准：

| 事件 | Turn 语义 |
| --- | --- |
| Thread 空闲时发送用户消息 | 创建新 Turn |
| Turn 运行中补充消息（steering） | 仍属于当前 Turn，并进入该 Turn 的摘要上下文 |
| Goal 自动续跑 | 创建新的 Turn |
| shell Turn | 独立 Turn；读取范围按不透明操作保守处理 |
| failed / interrupted | 仍封存 ChangeSet，界面显示 terminal 警告 |
| 子 Agent spawn | Git 子 Thread 从 provision 时捕获的父 worktree tree 创建；非 Git 子 Thread 复制当时的父目录 |
| Fork | Git Thread 从 `parentSequence` 对应的最后一个封存检查点创建；非 Git Thread 复制当时的父目录 |
| Rewind | Git Thread 从目标 Turn 的 before 检查点创建；非 Git Thread 没有 ChangeSet，因此不提供 Rewind |

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

| 状态轴 | 值 |
| --- | --- |
| `captureState` | `open / sealed / incomplete / discarded` |
| `messageState` | `unconfigured / queued / generating / ready / failed` |
| `commitState` | `idle / queued / committing / committed / conflict / failed` |

`open` 会实时显示当前净变化，但提交按钮始终禁用。只有 `sealed`、有净变化、有提交文本、没有未满足依赖的
ChangeSet 可以排队提交。`incomplete` 表示存在脱离已知工具生命周期的写入或工具写入结果未知，禁止自动提交。

工具调用携带 `session_id/thread_id/turn_id/tool_call_id`。Hook 在对应 Thread 目录执行并记录生命周期。已知
read/write/edit/apply-patch 路径用于归属和依赖；shell、Hook 与未知写范围按当时全部待提交 baseline 保守依赖。
文件监听刷新实时净变化；生命周期外写入会标为归属不明，不会猜成某个 Tool 的修改。

来源目录的初始修改也参与依赖判断：如果 Turn 读取或修改了初始 baseline 中相对目标 HEAD 已变化的路径，
`externalDependencyPaths` 会列出这些路径并拒绝提交。这样不会把用户原有修改静默带进 Turn commit。

## “提交上一轮，当前轮继续运行”

提交只读取已封存 ChangeSet 的 `beforeTree -> afterTree`，不读取 Thread 当前目录。因此：

```text
Turn A: sealed · 10 files ── queue commit ── replay immutable A delta ── target branch
Turn B: open   · 20 files ── continues writing in the isolated Thread dir
```

即使 A、B 修改同一文件，提交 A 也不会读取或改写 B 的内容、状态或执行任务。提交只占用目标仓库操作锁。
目标分支已推进时，A 会三方重放到最新 HEAD；有冲突就整单失败并列出路径。

提交前会冻结 draft、目标分支和期望 revision，并保存事务 journal。目标 checkout 的 HEAD、index、
未暂存与未跟踪状态先被捕获；A 的新提交生成后，原 staged/unstaged 层分别重放。ref 使用 expected HEAD CAS，
文件与 index 安装前再次比较不可变 tree 指纹。进程中断后，App Server 根据 journal 完成 checkout 安装或确认回滚。
提交仍不执行仓库 commit hooks。

首版 RPC 使用 `changeSetIds` 数组，但只接受一个 ID。丢弃操作以 Thread 为单位：没有运行中 Turn 且用户明确确认后，
重建“初始 baseline + 已 committed Turn delta”，再把其余 ChangeSet 标为 discarded；不支持单独丢弃中间 Turn。

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
- `turnChanges/commit`
- `turnChanges/discardThread`
- `turnChanges/changed`

所有修改请求包含 `commandId + expectedRevision`。相同 command/payload 会返回首次持久化的响应；相同 command 配不同
payload 会失败，不会重复执行后台任务。
