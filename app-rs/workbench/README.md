# `ash-workbench`

1. 管完整 Desktop Workbench：进程与窗口生命周期、应用状态、事件效果、窗口场景、Titlebar、Sidebar、Main、Inspector 和浮层顺序；`SidebarHeader` 挂载 Cowork / Code `ModeSwitcher`，content 挂 Sessions 页面。
2. 私有拥有 `SidebarPart` 的模式、Session 分组/展开状态、活动内容、Pane binding 和布局状态，通过 `WorkbenchHost` 保证 Workbench 结构只有一个修改入口。
3. Session、Terminal、Files、SCM、Editor、Settings 自己管内容状态与内部绘制；Workbench 只决定挂载位置和组合顺序。

## Sidebar Session 状态

Sidebar Session item 的运行状态只来自 `Session.manager.status`，状态全集由
[`SessionManagerStatus`](../../ash-rs/protocol/src/session/manager.rs) 定义，并与
[Ash Code Session Manager](../../code/tui/src/sessions/manager.rs) 保持一致。
Workbench 不根据 terminal block、shell 进程退出或摘要文字推断状态，也不保存第二套状态。

| `SessionManagerStatus` | Sidebar icon          | 颜色    |
| ---------------------- | --------------------- | ------- |
| `Idle`                 | `CIRCLE_SMALL`        | muted   |
| `NeedsInput`           | `ENTER`               | warning |
| `Working`              | `SYNC`                | accent  |
| `ReadyForReview`       | `CODE_REVIEW`         | success |
| `Completed`            | `CIRCLE_SMALL_FILLED` | success |
| `Failed`               | `ERROR`               | error   |
| `Stopped`              | `PAUSE`               | warning |

Session catalog 和 active Session snapshot 通过
[`session_tab_input`](sidebarpart/session_input.rs) 把该状态写入 Sidebar item；
目录浮层复用同一个状态和颜色。新增或修改状态时，必须先修改 protocol 的状态全集，再穷举更新
Ash Code 与 Workbench 的 icon、label、颜色和测试，禁止在任一客户端增加本地兜底状态。

验证：`just test ash-workbench`。

## SCM 与 PaneGroup

Changes 按组挂载，`PaneBinding` 保存该视图的 `ScmState`，不再使用窗口级 SCM 状态。
同一仓库可以拆为多个 Changes；每组独立保留滚动、文件折叠、查看范围和提交草稿。
拆分时复制当前视图状态，之后各组独立编辑；关闭组只释放该组的状态与动画。

绘制、焦点、鼠标、滚轮和分隔线均使用 `PanePart` 的同一棵拆分树。
SCM 的 Files 按钮打开或选中同树中的 Files 组。终端临时替换当前组内容后，返回同组先前的输入。
Session 快照与终端挂载不改变既有活动组或活动输入。窗口变窄时只显示活动组，放宽后恢复原拆分。

按 VS Code 的 EditorGroup 与 MultiDiffEditor 边界实现：组管理布局和活动输入，
每个 Changes 视图保存自己的多文件 Diff 状态。当前使用已有的左右、上下分屏快捷键
（macOS 为 `⌘\`、`⌘⇧\`），也支持组间切换与关闭。

覆盖：`just test ash-workbench --lib scm_panes_tests`、`just test ash-workbench --lib presentation_tests`。
