# `ash-workbench`

1. 管完整 Desktop Workbench：进程与窗口生命周期、应用状态、事件效果、窗口场景、Titlebar、Sidebar、Main、Inspector 和浮层顺序；`SidebarHeader` 挂载 Cowork / Code `ModeSwitcher`，content 挂 Sessions 页面。
2. 私有拥有 `SidebarPart` 的模式、Session 分组/展开状态、活动内容、Pane binding 和布局状态，通过 `WorkbenchHost` 保证 Workbench 结构只有一个修改入口。
3. Session、Terminal、Files、SCM、Editor、Settings 自己管内容状态与内部绘制；Workbench 只决定挂载位置和组合顺序。

## Sidebar Session 状态

Sidebar Session item 的运行状态只来自 `Session.manager.status`，状态全集由
[`SessionManagerStatus`](../../ash-rs/protocol/src/session/manager.rs) 定义，并与
[Ash Code Session Manager](../../code/tui/src/sessions/manager.rs) 保持一致。
Workbench 不根据 terminal block、shell 进程退出或摘要文字推断状态，也不保存第二套状态。

| `SessionManagerStatus` | Sidebar icon | 颜色 |
| --- | --- | --- |
| `Idle` | `CIRCLE_SMALL` | muted |
| `NeedsInput` | `ENTER` | warning |
| `Working` | `SYNC` | accent |
| `ReadyForReview` | `CODE_REVIEW` | success |
| `Completed` | `CIRCLE_SMALL_FILLED` | success |
| `Failed` | `ERROR` | error |
| `Stopped` | `PAUSE` | warning |

Session catalog 和 active Session snapshot 通过
[`session_tab_input`](sidebarpart/session_input.rs) 把该状态写入 Sidebar item；
目录浮层复用同一个状态和颜色。新增或修改状态时，必须先修改 protocol 的状态全集，再穷举更新
Ash Code 与 Workbench 的 icon、label、颜色和测试，禁止在任一客户端增加本地兜底状态。

验证：`just test ash-workbench`。
