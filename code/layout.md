# Fullscreen 区域定位

本文按当前代码标出 Ash Code 全屏 TUI 每个区域的中文叫法、代码名称和入口。反馈布局问题时，可以直接说“输入框上方提示行”“弹窗页签栏”等名称，再附上对应代码名。

## 整体布局

下面是普通会话页从上到下的顺序；可选区域只有有内容时才占高度，示意框线用于划分区域，不代表实际界面都有边框。

```text
┌────────────────────────────────────────────────────────────┐
│ 顶部工作区栏 header：分支 工作目录 [+]    上下文 Dashboard │
├────────────────────────────────────────────────────────────┤
│ 消息区 transcript                                          │
│ 用户消息、助手回复、工具执行记录                            │
│                                  回到底部 Jump to bottom ↓ │
├────────────────────────────────────────────────────────────┤
│ 目标区 goal                                      [可选]    │
│ 计划区 plan                                      [可选]    │
│ 待发送队列 queue                                 [可选]    │
│ 提问区 request                                   [可选]    │
│ 运行状态行 status_indicator                      [可选]    │
│ 输入框上方提示行 top_tip                                   │
├────────────────────────────────────────────────────────────┤
│ 输入区域 composer / input                                  │
│   ╭────────────────────────────────────────────────────╮   │
│   │ > 输入正文                                         │   │
│   ╰────────────────────────────────────── 模型名称 ────╯   │
├────────────────────────────────────────────────────────────┤
│ 底部快捷键区 bottom                                        │
│ 间隔行（存在 Agent 切换栏时）                               │
│ Agent 切换栏 agent_thread_switcher               [可选]    │
└────────────────────────────────────────────────────────────┘
```

整体矩形由 [fullscreen/layout.rs](tui/src/app/fullscreen/layout.rs) 的 `layout()`、`Layout`、`SessionAreas` 和 `session_areas()` 决定；绘制组合入口是 [fullscreen.rs](tui/src/app/fullscreen.rs) 的 `draw()`。终端变矮时，区域会被压缩或隐藏，不能用固定行号定位。

## 主页面区域对照

`header`、`input` 属于 `Layout`；其余下表字段属于 `Layout.session`（`SessionAreas`）。

| 中文叫法 | 代码名称 | 看到的内容 / 边界 | 定位入口 |
| --- | --- | --- | --- |
| 顶部工作区栏 | `header` | 左边分支、当前 Project 工作目录和 `[+]`；右边状态摘要、上下文用量与 `[Dashboard]`；正常高度下其后留一空行 | [header.rs](tui/src/app/fullscreen/header.rs) |
| 消息区 | `transcript` | 会话内容与滚动视口，占据上方剩余空间 | [conversation.rs](tui/src/app/fullscreen/conversation.rs)、[transcript/view.rs](tui/src/thread/transcript/view.rs) |
| 目标区 | `goal` | 当前目标信息 | [goal.rs](tui/src/thread/goal.rs) |
| 计划区 | `plan` | 当前计划及步骤 | [plan.rs](tui/src/thread/plan.rs) |
| 待发送队列 | `queue` | 排队等待发送的输入 | [queue.rs](tui/src/thread/queue.rs) |
| 提问区 | `request` | Agent 向用户提出的问题和答案选项 | [interaction/query.rs](tui/src/thread/interaction/query.rs) |
| 运行状态行 | `status_indicator` | 当前运行阶段、计时等状态反馈 | [status_indicator/view.rs](tui/src/thread/status_indicator/view.rs) |
| 输入框上方提示行 | `top_tip` | 临时提示、导航提示、权限策略等；正常布局预留一行 | [footer.rs](tui/src/app/fullscreen/footer.rs) 的 `draw_tip()`、[top_tip.rs](tui/src/app/top_tip.rs) |
| 输入区域 | `composer` | 容纳输入框；需要审批时改为显示审批选项 | [fullscreen/composer.rs](tui/src/app/fullscreen/composer.rs) |
| 实际输入框 | `input` | 普通情况下位于 `composer` 内；审批时高度为零 | [composer/surface.rs](tui/src/thread/composer/surface.rs) |
| 底部快捷键区 | `bottom` | `Enter send` 等当前操作提示；普通布局预留两行，提示画在最后一行 | [footer.rs](tui/src/app/fullscreen/footer.rs) 的 `draw()`、`bottom_row()` |
| Agent 切换栏 | `agent_thread_switcher` | Main / Subagent 会话切换，位于快捷键区下方 | [thread.rs](tui/src/thread.rs) 的 `draw_agent_thread_switcher` 入口 |

三个容易混淆的“状态”：顶部右侧是工作区/会话状态摘要；`status_indicator` 是输入框上方的运行状态；`top_tip` 是更靠近输入框的提示行。输入框右下边框上的模型名称由 [fullscreen/composer.rs](tui/src/app/fullscreen/composer.rs) 绘制。

顶部工作区栏的分支、工作目录、`[+]`、上下文和 Dashboard 是彼此独立的交互项。点击分支打开本地分支选择；点击工作目录打开同一 Project、同一 Environment 下的根目录选择并由 CLI host 重建 workspace 连接；`[+]` 先把目录加入 Project，再在目录面板中明确设置当前 Session 的权限，不自动授予能力。上下文静止时显示 `已用 / 容量`，hover 或键盘焦点时复用 StatusLine 的 Context 进度条；Dashboard 打开 Session 管理页。空输入时按 `F6` 聚焦标题栏，左右键移动，`Enter` 激活，`Esc` 返回输入。

标题栏交互项是轻量文字入口：hover 和按下只改变前景色与文字强调，不绘制背景色；键盘焦点额外使用下划线，不能与鼠标 hover 混为同一状态。弹窗、列表和输入控件仍使用各自的共享 hover surface。

审批区使用 `session.composer`，入口是 [interaction/approval.rs](tui/src/thread/interaction/approval.rs)；它与上方的提问区 `session.request` 是两个不同区域。

## 输入框内部与横向对齐

| 中文叫法 | 代码定位 | 含义 |
| --- | --- | --- |
| 输入框边框 | `ChatInputChrome::Box.border_area()` | Fullscreen 的方框范围 |
| 输入提示符 | `> ` / input prompt | 位于框内，是输入框的一部分 |
| 输入正文与光标 | `draw_chat_input` / input view | 换行后的文字与光标位置 |
| 历史搜索提示 | `history_status()` | 搜索输入历史时的提示，绘制在输入区域顶部 |
| 模型标签 | `model_label()` | 输入框下边框右侧的模型名称 |
| 状态标识列，简称标识列 | 各组件的行首标识布局 | 消息身份、列表选中符号等所在列；后面的留白之外才是内容区 |

输入框边框、内边距与正文绘制见 [input/view.rs](tui/src/thread/composer/input/view.rs)，输入历史提示见 [surface.rs](tui/src/thread/composer/surface.rs)。描述偏移时，请区分“整个输入框”“边框内正文”和“行首标识列”；fullscreen 输入框里的 `> ` 不属于框外标识列。

## 补全浮层

输入 `/`、`@` 或 `$` 时出现的候选列表，叫“补全浮层”。它覆盖输入框上方的页面，不是 `SessionAreas` 中额外插入的一块。

| 中文叫法 | 代码名称 / 入口 | 边界 |
| --- | --- | --- |
| 补全可用区域 | `Layout::completion_area()` | 从消息区顶部到实际输入框顶部，使用消息区全宽 |
| 补全候选列表 | `draw_completion_layer()` | 实际高度按候选数和可用空间决定 |
| 命令补全 | slash command completion | `/` 命令及说明 |
| 引用补全 | mention completion | `@` 引用候选 |
| 技能补全 | skill completion | `$` 技能候选 |
| 补全行的背景覆盖 | `surface_area` | 对候选所在行做全宽背景覆盖，包含左右留白 |

候选项和背景绘制见 [completion/view.rs](tui/src/thread/composer/input/completion/view.rs)。弹窗打开时优先绘制弹窗，不绘制补全浮层。

## 居中弹窗

模型选择、设置、帮助、详情等使用弹窗。整个弹窗覆盖在当前页面上方。

```text
┌─ 标题 title ─────────────────────── 关闭 close ─┐
│ 内容区 content                                  │
│   页签栏 tabs（可选）                           │
│   正文 body：搜索框 / 列表 / 编辑器 / 详情       │
│                                                 │
│ 弹窗快捷键 footer                               │
└─────────────────────────────────────────────────┘
                    整体：surface
```

| 中文叫法 | 代码名称 | 定位入口 |
| --- | --- | --- |
| 弹窗整体与边框 | `ModalLayout.surface` | [widgets/modal.rs](tui/src/widgets/modal.rs) |
| 弹窗标题 | `ModalLayout.title` | 同上 |
| 关闭按钮 | `ModalLayout.close` | 右上角 `[✗]`（U+2717 BALLOT X）；悬停时显示悬停表面反馈 |
| 弹窗内容区 | `ModalLayout.content` | 包含页签栏与正文 |
| 弹窗页签栏 | `tabs` / `draw_tabs()` | [fullscreen/modal.rs](tui/src/app/fullscreen/modal.rs) |
| 弹窗正文 | `body_area()` / `draw_body()` | 页签和间隔行以下；具体内容归各功能负责 |
| 弹窗快捷键 | `ModalLayout.footer` | 位于弹窗内部，与页面的 `session.bottom` 不同 |

关闭按钮 `[✗]` 的明暗变化统一叫**悬停表面反馈**（`hover surface feedback`），从交互原则上属于**悬停显现**（`reveal on hover`）：静止时保持安静，指针进入命中区域后，通过前景、边框或背景的明暗与对比变化显露可交互性。该反馈复用输入框等控件的悬停视觉，不改变字符、尺寸或位置，也不等同于键盘焦点、选中态和按下态。代码中的通用状态名是 `InteractionState.hovered`，主题颜色入口是 `hoverForeground` 和 `hoverBackground`。

Fullscreen 的 pointer 状态统一由 `PointerInteraction<PointerTarget>` 保存：组件按自己的绘制布局提供 typed hit-test，`pointer::target_at()` 只聚合为一个当前目标，绘制时再转换为共享的 `InteractionState`。新增 hover 目标沿用这条链路，不在组件中另存 hover 状态；hover 只补充鼠标反馈，关闭弹窗仍可使用 `Esc`。

## 首页与其他页面

首页复用 `session.transcript` 的空间显示欢迎卡片，下方仍使用同一套输入框和提示区。开始输入、欢迎内容收起后，上方可以留空，仍是首页草稿状态。

| 中文叫法 | 代码名称 | 内容 |
| --- | --- | --- |
| 欢迎卡片 | `HomeLayout.card` | 首页卡片整体边框 |
| 产品介绍区 | `HomeLayout.identity` | Ash Code、版本和说明 |
| 宠物图案区 | `HomeLayout.pet` | 空间足够时显示的图案 |
| 首页操作列表 | `HomeLayout.actions` | 恢复会话、管理会话、设置、帮助、退出 |

首页入口：[home.rs](tui/src/app/fullscreen/home.rs)。

| 页面 | 主体区域如何使用 |
| --- | --- |
| 会话管理页 | 管理列表使用 `transcript`；目标、计划、队列不显示 |
| 会话预览页 | `transcript` 显示只读消息，`composer` 显示 Preview 标签，没有实际输入框 |
| Issue 管理页 | `transcript` 显示管理内容，底部一行快捷键，没有实际输入框 |

这些页面的分支见 [conversation.rs](tui/src/app/fullscreen/conversation.rs)，高度分配见 [layout.rs](tui/src/app/fullscreen/layout.rs)。

## 定位问题时怎么说

- “`top_tip` 提示行与输入框太近”：查看 `layout.rs` 和 `footer.rs`。
- “`/` 补全浮层左右还有旧文字”：查看 `completion/view.rs` 的背景覆盖。
- “输入框右下角模型标签偏了”：查看 `fullscreen/composer.rs`。
- “弹窗页签栏和搜索框间距不对”：先查看 `fullscreen/modal.rs` 的 `body_area()`，再查看功能自己的正文布局。
- “某个区域看着能点，但点不中”：查看 [pointer.rs](tui/src/app/fullscreen/pointer.rs) 与该组件的命中区域。
- “选中文字的高亮范围不对”：查看 [selection.rs](tui/src/app/fullscreen/selection.rs)。

完整页面的文本快照位于 [fullscreen/snapshots](tui/src/app/fullscreen/snapshots)，对应测试入口有 [frame_tests.rs](tui/src/app/fullscreen/frame_tests.rs)、[layout_tests.rs](tui/src/app/fullscreen/layout_tests.rs)、[composer_tests.rs](tui/src/app/fullscreen/composer_tests.rs)、[home_tests.rs](tui/src/app/fullscreen/home_tests.rs) 和 [modal_tests.rs](tui/src/app/fullscreen/modal_tests.rs)。快照用于对照已有布局，本文件不代表重新执行了这些测试。
