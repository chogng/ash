# Ash Code 布局：fullscreen 与 inline

`fullscreen` 在备用屏幕中组织整页，正文在应用内滚动；`inline` 在主屏保留已定稿正文，把输入与活动回复放在有界视口中，补全、面板和历史浏览暂时进入备用屏幕。两种模式共用消息和功能编辑器，分别维护页面布局、焦点与浏览位置。

实现、配置与主题见 [README](README.md)。本文集中说明两种屏幕模式的布局、交互和终端边界。

| 比较项 | fullscreen | inline |
| --- | --- | --- |
| 平时使用的屏幕 | 备用屏幕，绘制整页 | 主屏，绘制底部活动视口 |
| 已定稿正文 | 留在应用正文中，不写入终端回滚区 | 按单元身份逐块写入终端历史 |
| 流式回复 | 在正文区更新 | 未定稿内容在活动视口更新，定稿后写入历史 |
| 顶部信息 | 固定工作区栏，分支、目录、上下文与 Dashboard | 欢迎信息先写入历史；活动视口没有固定工作区栏 |
| 输入区 | 上下分隔线，模型与非默认任务模式嵌入下线 | 上下分隔线；状态与任务模式可由底部 StatusLine 显示 |
| 命令面板 | 当前页面上方的居中模态框 | 临时备用屏幕中的面板，替换输入区 |
| 补全 | 输入框上方的浮层 | 临时备用屏幕中的候选列表 |
| 鼠标 | 应用处理点击、滚动、选文与复制 | 鼠标交给终端，应用使用键盘交互 |
| 退出 | 恢复 shell 画面 | 写出剩余正文，终端保留输出历史 |

阅读顺序：[屏幕模式配置](#屏幕模式配置) → [Fullscreen](#fullscreen) / [Inline](#inline) → [页面与状态归属](#页面与状态归属) → [终端生命周期](#终端生命周期) → [验证入口与支持范围](#验证入口与支持范围)。

## 屏幕模式配置

```toml
[tui]
screenMode = "fullscreen" # 或 "inline"
```

`screenMode` 只接受 `fullscreen` 和 `inline`，默认 `fullscreen`。Config 的“通用”页保存后立即切换，外部配置重载也即时应用；启动前校验配置，非法值报错。设置使用 App Server 的 profile，本地连接保存在本机，远程连接保存在远端。

## Fullscreen

### 整体布局

下面是普通会话页从上到下的顺序；可选区域只有有内容时才占高度，示意框线用于划分区域，不代表实际界面都有边框。

```text
┌─────────────────────────────────────────────────────────────┐
│ 顶部工作区栏 header：Home 分支 目录 [+] 上下文 Dashboard    │
├─────────────────────────────────────────────────────────────┤
│ 消息区 transcript                                           │
│ 用户消息、助手回复、工具执行记录                            │
│                                  回到底部 Jump to bottom ↓  │
├─────────────────────────────────────────────────────────────┤
│ 目标区 goal                                      [可选]     │
│ 计划区 plan                                      [可选]     │
│ 待发送队列 queue                                 [可选]     │
│ 提问区 request                                   [可选]     │
│ 运行状态行 status_indicator                      [可选]     │
│ 输入框上方提示行 top_tip                                    │
├─────────────────────────────────────────────────────────────┤
│ 输入区域 composer / input                                   │
│   ────────────────────────────────────────────────────      │
│   > 输入正文                                                │
│   ────────────────────────────── 模型 / 非默认任务模式      │
├─────────────────────────────────────────────────────────────┤
│ 底部快捷键区 bottom                                         │
│ 间隔行（存在 Agent 切换栏时）                               │
│ Agent 切换栏 agent_thread_switcher               [可选]     │
└─────────────────────────────────────────────────────────────┘
```

整体矩形由 [fullscreen/layout.rs](tui/src/app/fullscreen/layout.rs) 的 `layout()`、`Layout`、`SessionAreas` 和 `session_areas()` 决定；绘制组合入口是 [fullscreen.rs](tui/src/app/fullscreen.rs) 的 `draw()`。终端变矮时，区域会被压缩或隐藏，不能用固定行号定位。

### 主页面区域对照

`header`、`input` 属于 `Layout`；其余下表字段属于 `Layout.session`（`SessionAreas`）。

| 中文叫法 | 代码名称 | 看到的内容 / 边界 | 定位入口 |
| --- | --- | --- | --- |
| 顶部工作区栏 | `header` | 左边 Home、分支、当前 Project 工作目录和 `[+]`；右边状态摘要、上下文用量与 `[Dashboard]`；正常高度下其后留一空行 | [header.rs](tui/src/app/fullscreen/header.rs) |
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

三个容易混淆的“状态”：顶部右侧是工作区/会话状态摘要；`status_indicator` 是输入框上方的运行状态；`top_tip` 是更靠近输入框的提示行。输入区下分隔线上的模型与任务模式标签由 [fullscreen/composer.rs](tui/src/app/fullscreen/composer.rs) 绘制。

顶部工作区栏的分支、工作目录、`[+]`、上下文和 Dashboard 是彼此独立的交互项。点击分支打开本地分支选择；点击工作目录打开同一 Project、同一 Environment 下的根目录选择并由 CLI host 重建 workspace 连接；`[+]` 先把目录加入 Project，再在目录面板中明确设置当前 Session 的权限，不自动授予能力。上下文静止时显示 `已用 / 容量`，hover 或键盘焦点时复用 StatusLine 的 Context 进度条；Dashboard 打开 Session 管理页。空输入时按 `F6` 聚焦标题栏，左右键移动，`Enter` 激活，`Esc` 返回输入。

标题栏交互项是轻量文字入口：hover 和按下只改变前景色与文字强调，不绘制背景色；键盘焦点额外使用下划线，不能与鼠标 hover 混为同一状态。弹窗、列表和输入控件仍使用各自的共享 hover surface。

审批区使用 `session.composer`，入口是 [interaction/approval.rs](tui/src/thread/interaction/approval.rs)；它与上方的提问区 `session.request` 是两个不同区域。

### 输入区域

两种模式的输入区都使用上下分隔线。fullscreen 使用 `ChatInputChrome::Mode`，模型与推理档位显示在下线右侧，非默认任务模式另有可点击标签；绘制见 [composer.rs](tui/src/app/fullscreen/composer.rs)。换行、光标和历史搜索提示由共享 [输入组件](tui/src/thread/composer/input/view.rs) 与 [surface.rs](tui/src/thread/composer/surface.rs) 处理；横向边界见[鼠标与横向对齐](#鼠标与横向对齐)。

### 补全浮层

`/`、`@`、`$` 的候选覆盖输入区上方的页面，不额外占用 `SessionAreas` 高度。`Layout::completion_area()` 给出消息区顶部至实际输入框顶部的全宽区域，候选高度按条目数和可用空间确定。弹窗打开时不绘制补全。

[completion/view.rs](tui/src/thread/composer/input/completion/view.rs) 同时绘制候选与整行背景，背景包括左右留白，避免露出被覆盖页面的旧文字。前缀含义与提交规则见 [README](README.md#命令与补全)。

### 居中弹窗

模型、设置和帮助等命令面板覆盖当前页面。外框由 [widgets/modal.rs](tui/src/widgets/modal.rs) 的 `ModalLayout` 计算，内容由 [fullscreen/modal.rs](tui/src/app/fullscreen/modal.rs) 组合：

| 区域 | 代码名称 | 边界 |
| --- | --- | --- |
| 整体、标题与关闭入口 | `surface` / `title` / `close` | 右上角 `[✗]` 关闭；悬停只改变样式，关闭也可用 Esc |
| 内容与页签 | `content` / `tabs` | 内容区包含可选页签与正文 |
| 正文 | `body_area()` / `draw_body()` | 页签及间隔行以下，具体内容由功能模块负责 |
| 弹窗提示 | `footer` | 位于弹窗内部，与页面 `session.bottom` 分开 |

### 首页与其他页面

| 页面 | 区域使用 |
| --- | --- |
| 首页 | `transcript` 显示欢迎卡片与操作列表，下方保留输入和提示；收起欢迎内容后仍是首页草稿 |
| 会话管理 | `transcript` 显示管理列表，不显示目标、计划和队列 |
| 会话预览 | `transcript` 显示只读消息，`composer` 显示 Preview 标签，没有实际输入框 |
| Issue 管理 | `transcript` 显示管理内容，底部一行快捷键，没有实际输入框 |

首页由 [home.rs](tui/src/app/fullscreen/home.rs) 维护，其余页面分支见 [conversation.rs](tui/src/app/fullscreen/conversation.rs)。

## Inline

### 主屏历史与活动视口

普通 inline 画面有两个不同的存放位置：上方是终端保留的已定稿输出，下方是应用反复绘制的活动视口。示意线只区分区域。

```text
终端主屏 / 回滚区
  欢迎信息：Ash Code、版本、模型、目录
  已定稿用户消息
  已定稿助手回复与工具单元
  ……继续写入终端历史……
┌─ 活动视口 ───────────────────────────────────────────────┐
│ 活动正文 transcript：当前回复、尚未定稿的工具内容        │
│ 目标 goal / 计划 plan / 待发送队列 queue          [可选] │
│ 提问 request / 运行状态 status_indicator         [可选]  │
│ 输入上方提示 top_tip                                     │
│ ──────────────────────────────────────────────────────   │
│ > 输入正文                                               │
│ ──────────────────────────────────────────────────────   │
│ 底部 bottom：StatusLine 或当前操作提示                   │
│ Agent 切换栏 agent_thread_switcher               [可选]  │
└──────────────────────────────────────────────────────────┘
```

[inline/layout.rs](tui/src/app/inline/layout.rs) 的 `height()` 按控制区所需高度加上 8 行活动正文计算视口高度，最多占终端当前高度；这是高度预算，正文实际可用空间由 `session_areas()` 分配。它不会随着已完成消息数量持续长高。历史浏览时正文最小预算为 4 行；窗口太矮时，提问与输入会挤压该预算，避免历史挡住待回答的问题。

inline 的 `SessionAreas` 使用与 fullscreen 相同的区域名，独立计算位置。差异集中在三个入口：

| 职责 | 实现入口 |
| --- | --- |
| 定稿历史与活动尾部分开输出，记录已写出的单元身份 | [output.rs](tui/src/app/inline/output.rs)、[scrollback.rs](tui/src/terminal/scrollback.rs) |
| 欢迎信息在普通主屏输出时写入一次 | [header.rs](tui/src/app/inline/header.rs) |
| 底部按当前状态显示 StatusLine、面板快捷键、审批、提问或语音提示 | [footer.rs](tui/src/app/inline/footer.rs) |

`Output` 在当前 Thread 内按稳定单元身份去重，普通重绘和重复快照不会再次写出已定稿块；旧分页内容留在正文浏览器中，避免插入较早消息打乱主屏输出顺序。切换 Thread 会重置输出记录，并绘制目标 Thread。

临时备用屏幕关闭时恢复主屏；若打开期间终端变矮，`replay_clipped_history()` 计算受裁切的历史块并补写。这个尺寸恢复步骤和日常重绘不同。退出时 `finish()` 关闭临时屏幕，再按顺序写出尚未提交的定稿块与活动尾部。

稳定视口用于避免刷新时不断追加空行；原有空行增长问题的回归覆盖见 [output_tests.rs](tui/src/app/inline/output_tests.rs) 与 [CLI/PTY 场景](../ash-cli/tests/tui/terminal.rs)。

### 临时面板、补全与历史浏览

[output::expanded()](tui/src/app/inline/output.rs) 统一判断是否需要临时备用屏幕：命令面板、正文详情浮层、补全、会话或 Issue 管理、预览和正文浏览都走这个终端入口。终端切换由 `TerminalSession::set_inline_overlay()` 完成，功能页不直接写屏幕控制序列。

命令面板区域由 `command_panel_areas()` 分配：正文占上方剩余区域，面板占 `session.composer`，提示留在 `session.bottom`，实际输入框隐藏。外框与正文边界由 [widgets/panel.rs](tui/src/widgets/panel.rs) 的 `PanelLayout` 计算：标题一行、标题后空一行，再放页签和正文；内容左右各留两列。[inline/panel.rs](tui/src/app/inline/panel.rs) 只承载同一个 `CommandPanel` 功能编辑器。

面板打开时，按键、粘贴和底部提示归面板；后台到达的审批和提问保留到关闭后处理。关闭不把面板内容写入对话历史。补全使用 `Layout::completion_area()` 和共享候选组件，在临时屏幕里绘制；不会成为新的正文单元。

Ctrl+Home 进入较早正文浏览，Ctrl+End 返回当前回复。浏览位置按单元身份和行偏移保存。会话管理和预览使用自己的 `SessionNavigation`；预览没有实际输入框，不能把浏览键误认为发送。

inline 空输入时按 ← 打开 Dashboard，按 → 或 Esc 返回当前会话。聚焦管理列表的会话条目时，→ 同样返回；聚焦分组标题时，左右键仍用于展开、收起分组。预览、详情和命令面板先处理自己的按键。输入框正在编辑非空草稿时，左右键继续移动输入光标。

## 鼠标与横向对齐

fullscreen 捕获鼠标：点击输入区移动光标，拖拽、双击、三击分别选文字、词、行，松开后复制；草稿选区保留，可删除或用输入、粘贴替换。只读正文和模态框文字也可选文，列表与按钮仍使用自己的点击动作。inline 不捕获鼠标，选文和复制交给终端，应用通过键盘操作。

fullscreen 的 [pointer.rs](tui/src/app/fullscreen/pointer.rs) 聚合各组件按绘制布局提供的命中目标，`PointerInteraction` 保存悬停与按下状态，绘制使用共享 `InteractionState`。悬停、键盘焦点和选中彼此独立；工作区栏用前景色与文字强调反馈鼠标，键盘焦点另加下划线。

行首的消息身份、列表焦点 `>` 和 inline 输入提示使用“状态标识列”；其分隔留白之外才是内容区。无标识时仍保留这一列，组件不能重复预留。fullscreen 的 `> ` 属于输入区本身；两种输入提示均占两列，计入换行与光标宽度。具体约束见 [TUI 布局规范](../.github/instructions/tui.instructions.md#learnings)。

## 页面与状态归属

| 内容 | 保存与维护位置 |
| --- | --- |
| 会话、消息、配置、草稿、队列与功能请求 | 共用功能模块；`SessionsState` 保存目录与 Session/Thread 身份，不保存页面焦点 |
| 页面、焦点、Issues 浏览、子任务选择、正文滚动与展开项 | fullscreen / inline 分别持有；[SessionNavigation](tui/src/sessions/navigation.rs)、[Viewports](tui/src/thread/transcript/viewport.rs) 和 `QueueNavigation` 保存各模式的浏览选择 |
| 区域、容器与输入路由 | 两种模式各自的 `layout.rs`、`navigation.rs`、`modal.rs` / `panel.rs`；[frame.rs](tui/src/app/frame.rs) 只选择绘制入口和资源需求 |
| 功能编辑与业务动作 | `CommandPanel` 共用功能编辑器，功能模块解释请求与结果；共享 `widgets` 提供外框、列表、页签和搜索 |
| 终端输出与恢复 | `TerminalSession`；[terminal/text.rs](tui/src/terminal/text.rs) 提取文字，不保存界面手势 |

两种模式不调用对方的绘制或导航，App 不计算页面坐标。共享数据删除条目后，各模式清理自己的失效选择。面板焦点、搜索与退出规范见 [TUI 模态交互规范](../.github/instructions/tui.instructions.md#命令面板与模态交互规范)。

### 屏幕模式切换

切换 fullscreen / inline 时恢复目标模式自己的页面、焦点和浏览位置。已打开的命令面板转交同一个功能编辑器，由目标模式的容器继续承载；转交不触发关闭，不创建第二份编辑状态。

新任务草稿由 `SessionsState.input` 保存，当前会话草稿由 `ThreadPresentationStore` 按 Thread 保存；只有输入目标相同才共用草稿，切换模式不会把新任务草稿送入当前会话。消息队列仍只有一份。

异步剪贴板读取绑定发起时的草稿身份和代次，返回后写入同一份草稿；切换到其他输入目标不会改变它的去向，已经提交的草稿不会接收迟到的图片。

页面焦点、会话预览和详情不随功能编辑器迁移。全屏鼠标按下、悬停和屏幕选区属于当前画面，切换时清除；草稿中的编辑选区跟随草稿，切换时结束尚未完成的拖拽。同一模式的设置重载不改变当前焦点。

### 任务模式选择与显示

任务模式和 fullscreen / inline 是两项独立选择：前者决定下一条任务的工作方式，后者决定终端怎样显示页面。五种任务模式使用 `/mode` 选择，也支持 `/mode agent|plan|debug|multitask|ask`。参数直接按协议中的稳定 ID 解析，不随界面语言或显示名称变化；命令输入不区分 ASCII 大小写。请求、队列和历史继续使用 `CollaborationMode` 强类型保存。共享行为见[五种任务模式](../ash-rs/collaboration-mode-templates/collaboration-modes.md)。

输入框聚焦时，Shift+Tab 按 Agent、Plan、Debug、Multitask、Ask 的顺序循环。切换只影响下一条消息；运行中选择其他模式后，Ctrl+Enter 也会排队。弹层继续使用所属组件自己的按键处理。

| 呈现 | 当前显示方式 |
| --- | --- |
| fullscreen | 模型与推理强度后显示非默认模式的可点击名称；输入框上下边线和输入符号使用模式色 |
| inline | `/statusline` 可开启 `Mode`，对应 `[tui].statusLine` 的 `mode` 项，默认关闭 |
| 默认 Agent | 两种呈现均隐藏模式名称与对应分隔符；模式身份仍为 `agent`，fullscreen 使用普通前景色 |

模式颜色与默认值由 [palette.rs](tui/src/render/palette.rs) 维护，用户主题可覆盖 `modePlan`、`modeDebug`、`modeMultitask` 和 `modeAsk`。推理强度、权限及输入历史按键见 [README](README.md#命令与补全)。

## 终端生命周期

[TerminalSession](tui/src/terminal/session.rs) 是终端输出的唯一入口。fullscreen 按原始输入 → 备用屏幕（保存并关闭滚轮转方向键）→ 粘贴事件 → 焦点上报 → 鼠标捕获的顺序获取终端模式；inline 保留原始输入、粘贴与焦点事件，按需要进入临时备用屏幕。退出备用屏幕前恢复原有滚轮模式。

`TerminalModeGuard` 记录成功步骤，失败和退出都逆序释放；显式恢复与 Drop 清理可重复调用。退出或挂起还要重置光标颜色并显示光标。Unix 的 Ctrl+Z 先恢复终端再发送 SIGTSTP，`fg` 后重新获取并绘制；SIGINT/SIGTERM 走事件循环的正常退出路径。

历史输出使用有界分块和普通终端滚动，不使用局部滚动区域。最终写出时才附加 OSC 8 链接并处理宽字符续列，输出缓冲区不参与后续布局、复制和导出。尺寸变化时清除全屏选区并结束输入拖拽，迟到的释放事件不能触发复制。

## 验证入口与支持范围

两种模式的测试与文本快照分别放在 `fullscreen/` 和 `inline/`：

| 验证内容 | 定向入口 |
| --- | --- |
| fullscreen 页面、布局与交互 | `just test ash-tui --lib app::fullscreen` |
| inline 视口、面板和历史输出 | `just test ash-tui --lib app::inline` |
| 模式隔离与同一面板转交 | `just test ash-tui --lib app::mode_tests` |
| 共用应用流程 | `just test ash-tui --lib app::` |

App 与组件验证按 [test-tui](../.agents/skills/test-tui/SKILL.md) 执行；实际进程、PTY 或终端边界按 [test-tui-pty](../.agents/skills/test-tui-pty/SKILL.md) 执行。正常构建与完整测试入口见 [README](README.md#测试与支持边界)。

真实终端验证从 [terminal.rs](../ash-cli/tests/tui/terminal.rs) 进入：

| 行为 | PTY 场景 |
| --- | --- |
| fullscreen 多轮历史与固定输入位置 | `just test-tui actual_tui_multiple_commands_preserve_internal_history_and_fixed_input` |
| inline 面板、缩放与退出保留历史 | `just test-tui actual_tui_inline_preserves_history_across_panels_resize_and_exit` |
| 即时切换并保存模式 | `just test-tui actual_tui_screen_mode_switches_live_and_persists` |

鼠标交接还可在至少 40×12 的真实 PTY 中运行 `just test ash-tui --lib real_terminal_mouse_handoff -- --ignored --nocapture --test-threads=1`。终端协议与部分失败恢复见 [session_tests.rs](tui/src/terminal/session_tests.rs)，输入编辑选区见 [editor_tests.rs](tui/src/thread/composer/input/editor_tests.rs)。

上述命令是验证入口，不代表本次已运行。既有 Windows ConPTY 场景覆盖输入、回复、滚动和退出恢复；新版首页与弹窗，以及其他终端和 tmux/Zellij 组合仍需在对应环境重新验证。fullscreen 历史完整性应检查应用正文，inline 才检查终端历史。
