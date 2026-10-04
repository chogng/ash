# Ash Code 布局：fullscreen 与 inline

`fullscreen` 在备用屏幕中组织整页，正文在应用内滚动；`inline` 在主屏保留已定稿正文，把输入与活动回复放在有界视口中，补全、面板和历史浏览暂时进入备用屏幕。两种模式共用消息、功能编辑器和聊天控制区的布局规则，分别维护页面容器、焦点与浏览位置。

实现、配置与主题见 [README](README.md)。本文集中说明两种屏幕模式的布局、交互和终端边界。下表及后续章节描述当前实现。

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

阅读顺序：[屏幕模式配置](#屏幕模式配置) → [统一布局设计](#统一布局设计) → [聊天进度与听写状态](#聊天进度与听写状态) → [Fullscreen](#fullscreen) / [Inline](#inline) → [页面与状态归属](#页面与状态归属) → [终端生命周期](#终端生命周期) → [验证入口与支持范围](#验证入口与支持范围)。

## 屏幕模式配置

```toml
[tui]
screenMode = "fullscreen" # 或 "inline"
```

`screenMode` 只接受 `fullscreen` 和 `inline`，默认 `fullscreen`。Config 的“通用”页保存后立即切换，外部配置重载也即时应用；启动前校验配置，非法值报错。设置使用 App Server 的 profile，本地连接保存在本机，远程连接保存在远端。

## 统一布局设计

两种模式共用聊天内容、输入组件、听写反馈和底部提示的组合规则。fullscreen 将 inline 底部 statusline 的环境信息移到顶部，保留底部 statusline 显示统计信息；模型靠近输入框，权限由同一配置控制：fullscreen 显示在底部 statusline，inline 平时显示在第二行，操作提示需要时由 hintline 覆盖。共同区域的内容、顺序和高度分配规则只维护一份，两种模式各自负责整页或活动视口的空间、滚动与终端输出。

### StatusLine 配置与显示位置

**StatusLine 配置决定显示什么，屏幕模式决定放在哪里。** 两种模式都使用 `/statusline` 和 `[tui].statusLine` 的同一组显示开关。移到顶部 statusline 或输入框边线的状态项仍受原来的开关控制，不新增一套 fullscreen 显示配置。

| 内容 | 配置项 | inline 位置 | fullscreen 位置 |
| --- | --- | --- | --- |
| 模型与推理档位 | `model` | 输入框下方的 statusline | 输入框下分隔线 |
| 非默认任务模式 | `mode` | 输入框下方的 statusline | 输入框下分隔线，跟在模型后面 |
| 权限模式 | `permissions` | statusline 第二行；hintline 显示时暂时隐藏 | 底部 statusline 左侧 |
| Git 分支与变更 | `git-branch`、`git-changes` | 底部 statusline | 顶部 statusline |
| 上下文用量 | `context` | 底部 statusline | 顶部 statusline |
| 缓存命中率与参考费用 | `cache-hit-rate`、`reference-cost` | 底部 statusline | 底部 statusline |
| 内存与 CPU | `memory`、`cpu` | 底部 statusline | 底部 statusline |

模型、任务模式和权限的内容由共用状态组件负责；可点击的顶部上下文摘要保留原有显示与交互。状态项在每种模式中只显示一次；关闭后同时从两种模式隐藏，对应标签、分隔符和标签占用的宽度一起消失。任务模式仍保留默认 Agent 不显示名称的约定。

工作目录和 Dashboard 属于页面导航入口，不是 StatusLine 状态项，不纳入上述开关。关闭 Git 状态的显示只影响展示及其专属额外计算，不停止基础 Git 状态跟随。

### 区域名称与实际占行

**statusline、hintline、tipline 按内容命名，不代表每个名称都要独占一行。** 普通聊天页的输入框下方，两种模式都只预留两行；可选的 Agent 切换栏另算。

| 名称 | 内容 | fullscreen | inline |
| --- | --- | --- | --- |
| statusline | 模型、权限、环境与统计等状态信息 | 顶部 `top_statusline` 显示环境信息；底部一行显示权限与统计；模型靠近输入框 | 底部第一行显示模型等信息，第二行平时显示权限 |
| hintline | 当前操作快捷键、等待结果或待完成快捷键提示 | 输入框下方独立一行，位于底部 statusline 之后 | 按需覆盖 statusline 第二行，与权限互斥显示，不增加第三行 |
| progress | 本轮运行状态、耗时、中断键与长任务技巧 | 输入控制区，位于 tipline 上方；运行时占一至两行 | 活动视口的输入控制区，位于 tipline 上方；运行时占一至两行 |
| tipline | 听写、临时反馈与导航提示 | 输入框上方一行 | 输入框上方一行 |

fullscreen 的权限和 hintline 可以同时显示。inline 第二行在权限与 hintline 之间切换，第一行的模型、统计等聊天状态信息保持原位。命令面板、正文详情和管理页使用自己的容器，背景聊天 statusline 隐藏，底部由该容器显示操作提示。

fullscreen 的 hintline 从内容区左侧开始，与底部 statusline 对齐；inline 的聊天 hintline 保持右对齐。

### Inline 第二行的覆盖与恢复

**普通聊天时显示两行 statusline；需要操作提示时，hintline 替换第二行的整行内容。** 权限与操作提示不在这一行拼接，也不同时显示。覆盖只改变显示内容，不改变当前权限策略或 StatusLine 配置。

| 当前状态 | inline 第二行显示什么 |
| --- | --- |
| 普通输入、聊天运行、听写，或显示 tipline 临时反馈 | 权限模式；`permissions` 关闭时留空 |
| 仅显示 `/`、`@`、`$` 补全候选 | 保持权限显示；候选列表放在自己的补全区域 |
| 待回答问题或待审批请求 | 对应 hintline，例如 `Enter to answer`、`Enter to confirm` |
| 答案或审批结果正在提交 | hintline 显示 `Waiting for the request result` |
| 聚焦队列、选择正文、聚焦 Agent 切换栏，或等待组合键的后续按键 | 对应操作的 hintline |
| 查看已结束的子任务 | hintline 提示选择 Main 或其他 Subagent |
| 打开命令面板、正文详情、管理页或预览 | 当前容器的操作提示，聊天权限暂时隐藏 |

返回普通聊天输入状态后，第二行恢复权限；若 `permissions` 已关闭，则恢复为空行。关闭面板后若仍有后台到达的提问或审批，先显示该请求的 hintline，处理完请求并返回普通输入后再恢复权限。权限显示开关只控制权限文字，不控制操作提示是否出现；关闭状态项也不缩减预留的底部行数。

下面四个状态中的第一、第二行，始终对应同两个屏幕位置：

```text
普通聊天
  statusline 第一行：模型 · 分支 · 统计
  statusline 第二行：⏸ Manual

等待回答
  statusline 第一行：模型 · 分支 · 统计
  hintline 覆盖第二行：Enter to answer

提交答案
  statusline 第一行：模型 · 分支 · 统计
  hintline 覆盖第二行：Waiting for the request result

请求处理完毕，回到普通聊天
  statusline 第一行：模型 · 分支 · 统计
  statusline 第二行：⏸ Manual
```

fullscreen 窄窗口优先保留底部权限，再裁剪同一行的统计信息；inline 第二行的权限或操作提示不挤占第一行的模型与统计。

### 两种模式的布局示意

下面展示普通聊天页的布局。示例假定相关 StatusLine 项已开启、任务模式为 Plan、正在听写；可选业务区域仅在有内容时出现。外框用于说明范围，不代表实际界面绘制边框；示例显示内容，不规定固定列宽。

fullscreen：

```text
┌─ fullscreen：整页 ─────────────────────────────────────────────┐
│ 顶部 statusline：目录 · 分支 · Git 变更 · 上下文    Dashboard  │
│                                                                │
│ 消息正文                                                       │
│ 当前回复、工具记录                                             │
│                                                                │
│ 目标 / 计划 / 待发送队列 / 提问                     [可选]     │
│ progress：Working... · 12s · ctrl+c to interrupt               │
│ tipline：正在听写 · 停止听写快捷键                             │
│ ──────────────────────────────────────────────────────────     │
│ > 输入正文                                                     │
│ ──────────────────────────── 模型 · 推理档位 · Plan ───────    │
│ 底部 statusline：权限 · 缓存命中率 · 参考费用 · 内存 · CPU     │
│ hintline：当前操作快捷键                                       │
│ Agent 切换栏                                       [可选]      │
└────────────────────────────────────────────────────────────────┘
```

inline：

```text
终端主屏 / 回滚区
  欢迎信息：版本、目录等
  已定稿用户消息、助手回复与工具记录
  ……继续写入终端历史……
┌─ inline：活动视口 ──────────────────────────────────────────┐
│ 当前回复、工具记录                                          │
│ 目标 / 计划 / 待发送队列 / 提问                     [可选]  │
│ progress：Working... · 12s · ctrl+c to interrupt            │
│ tipline：正在听写 · 停止听写快捷键                          │
│ ──────────────────────────────────────────────────────────  │
│ > 输入正文                                                  │
│ ──────────────────────────────────────────────────────────  │
│ statusline 第一行：模型 · 推理档位 · Plan · 分支 · 统计     │
│ statusline 第二行：权限；操作时由 hintline 覆盖             │
│ Agent 切换栏                                       [可选]   │
└─────────────────────────────────────────────────────────────┘
```

inline 的 statusline 第一行按配置顺序与可用宽度绘制模型、任务模式、环境与统计信息，第二行平时显示权限，交互时由 hintline 覆盖。fullscreen 将环境项移到顶部 statusline、模型与模式放到输入框下分隔线，底部 statusline 显示权限，并保留缓存命中率、参考费用和资源统计。两种模式的底部 statusline 也显示已有的计划与子任务运行摘要。两种模式的听写状态和停止快捷键统一放在 `tipline`，普通聊天页中，fullscreen 为 statusline 和 hintline 各预留一行；inline 仅为 statusline 预留两行，hintline 与第二行共用位置。没有启用的信息时对应状态行留空。

终端历史、鼠标捕获、正文滚动和模态框 / 临时面板的容器仍由各模式负责。两种模式不调用对方的绘制或导航；共享组件不拥有页面焦点或终端生命周期。

### 组合规则与验证

[chat_view.rs](tui/src/app/chat_view.rs) 统一分配消息、目标、计划、队列、提问、progress、tipline、输入、statusline、hintline 和 Agent 切换栏；[footer.rs](tui/src/app/footer.rs) 统一选择快捷键与听写提示。fullscreen 和 inline 各自提供空间预算、输入外观和页面容器。

正常高度的普通聊天页中，inline 的 `session.statusline` 是两行矩形，`session.hintline` 是其中第二行的一行矩形；两个字段描述重叠区域。fullscreen 的底部 `session.statusline` 与 `session.hintline` 则是相邻的两个一行矩形。维护布局时按实际占行计算高度，不能将 inline 的两个矩形高度相加。

测试分别验证两种模式的完整文本与区域位置：状态项开关、状态项不重复、听写与权限同时可见、当前任务与下一条任务权限文案、窄宽度裁剪，inline 第二行被 hintline 覆盖及恢复，以及模式切换后配置与草稿保持不变。页面焦点、历史输出与终端恢复仍由各模式的测试覆盖。

## 聊天进度与听写状态

本轮运行状态行（turn status / activity indicator）固定在输入控制区，位于 tipline 上方。它回答当前是否仍在运行、处于什么阶段以及怎样停止；正文流式输出和历史滚动都不改变它的位置。转圈符号叫 spinner；状态行不显示完成百分比。

| 内容 | fullscreen | inline |
| --- | --- | --- |
| 本轮状态、耗时、中断键和长任务技巧 | 固定的 `progress` 区域，位于 tipline 上方，不参与正文滚动 | 活动视口中固定的 `progress` 区域，位于 tipline 上方，不写入终端历史 |
| 听写阶段与下载字节数 | 输入框上方的 `tipline` | 输入框上方的 `tipline` |
| 停止听写快捷键 | 与听写状态一起显示在 `tipline` | 与听写状态一起显示在 `tipline` |
| 输入框下方的固定区域 | statusline 一行，hintline 一行 | statusline 两行，hintline 按需覆盖第二行 |

[progress.rs](tui/src/thread/progress.rs) 拥有状态行的内容，[chat_view.rs](tui/src/app/chat_view.rs) 分配区域并绘制；[transcript/view.rs](tui/src/thread/transcript/view.rs) 只负责正文及其滚动。两种模式的听写阶段与停止快捷键由共享 tipline 绘制，不替换统计、权限或操作提示。

启动、运行和取消中的状态以 `...` 结尾，例如 `Starting...`、`Working...`、`Cancelling...`。运行时的 spinner verb 每轮选择一次，本轮内保持不变；英文、日文、中文和法文都带相同的三点后缀。等待批准、等待输入和等待功能就绪使用静止圆圈和明确的阶段文字，不转圈。标记保留状态色，阶段、耗时和快捷键使用弱化文字色，让正文保持主要阅读位置。

耗时按 `0s`、`59s`、`1m 00s`、`1h 00m 00s` 显示，从本轮开始累计，包含等待用户批准或回答的时间；隐藏状态行不会重置时钟。窄宽度优先保留中断快捷键，再裁剪阶段或省略耗时。运行八秒后可在状态行下显示一行技巧；等待用户操作时收起技巧。短终端先保留提问和输入，再分配状态行及可选提示。

状态行随当前任务结束而收起，不成为持久化消息，也不写入 inline 的终端历史。模型检查和加载期间显示实际准备阶段，收到模型 `Ready` 通知后才显示“正在听写”。聊天与听写同时进行时，各自在上述位置显示；中断键先停止听写，运行状态行暂时隐藏“中断任务”提示，停止听写完成后恢复。

## Fullscreen

### 整体布局

下面是普通会话页从上到下的顺序；可选区域只有有内容时才占高度，示意框线用于划分区域，不代表实际界面都有边框。

```text
┌─────────────────────────────────────────────────────────────┐
│ 顶部 statusline：分支 目录 Git 变更 上下文 Dashboard        │
├─────────────────────────────────────────────────────────────┤
│ 消息区 transcript                                           │
│ 用户消息、助手回复和工具执行记录                            │
│                                  回到底部 Jump to bottom ↓  │
├─────────────────────────────────────────────────────────────┤
│ 目标区 goal                                      [可选]     │
│ 计划区 plan                                      [可选]     │
│ 待发送队列 queue                                 [可选]     │
│ 提问区 request                                   [可选]     │
│ 本轮运行状态行 progress                         [运行时]    │
│ 输入框上方提示行 tipline                                    │
├─────────────────────────────────────────────────────────────┤
│ 输入区域 composer / input                                   │
│   ────────────────────────────────────────────────────      │
│   > 输入正文                                                │
│   ────────────────────────────── 模型 / 非默认任务模式      │
├─────────────────────────────────────────────────────────────┤
│ 底部 statusline：权限、缓存命中率、费用、资源统计           │
│ hintline：当前操作快捷键                                    │
│ 间隔行（存在 Agent 切换栏时）                               │
│ Agent 切换栏 agent_thread_switcher               [可选]     │
└─────────────────────────────────────────────────────────────┘
```

整页范围由 [fullscreen/layout.rs](tui/src/app/fullscreen/layout.rs) 的 `Layout` 决定；聊天控制区由 [chat_view.rs](tui/src/app/chat_view.rs) 的 `SessionAreas` 和 `session_areas()` 分配；绘制组合入口是 [fullscreen.rs](tui/src/app/fullscreen.rs) 的 `draw()`。终端变矮时，区域会被压缩或隐藏，不能用固定行号定位。

### 主页面区域对照

`top_statusline`、`input` 属于 `Layout`；其余下表字段属于 `Layout.session`（`SessionAreas`）。

| 中文叫法 | 代码名称 | 看到的内容 / 边界 | 定位入口 |
| --- | --- | --- | --- |
| 顶部 statusline | `top_statusline` | 左边分支、当前 Project 工作目录；右边 Git 变更、上下文用量与 `[Dashboard]`；正常高度下其后留一空行 | [header.rs](tui/src/app/fullscreen/header.rs) |
| 消息区 | `transcript` | 会话内容与滚动视口，占据控制区上方剩余空间 | [conversation.rs](tui/src/app/fullscreen/conversation.rs)、[transcript/view.rs](tui/src/thread/transcript/view.rs) |
| 目标区 | `goal` | 当前目标信息 | [goal.rs](tui/src/thread/goal.rs) |
| 计划区 | `plan` | 当前计划及步骤 | [plan.rs](tui/src/thread/plan.rs) |
| 待发送队列 | `queue` | 排队等待发送的输入 | [queue.rs](tui/src/thread/queue.rs) |
| 提问区 | `request` | Agent 向用户提出的问题和答案选项 | [interaction/query.rs](tui/src/thread/interaction/query.rs) |
| 底部 statusline | `statusline` | 输入框下方、hintline 上方的一行；显示权限、缓存命中率、费用、资源和运行摘要 | [footer.rs](tui/src/app/fullscreen/footer.rs) |
| 本轮运行状态行 | `progress` | 固定在 tipline 上方；显示阶段、耗时、中断键和可选技巧 | [chat_view.rs](tui/src/app/chat_view.rs)、[progress.rs](tui/src/thread/progress.rs) |
| 输入框上方提示行 | `tipline` | 听写、临时提示和导航提示；正常布局预留一行 | [footer.rs](tui/src/app/fullscreen/footer.rs) 的 `draw_tip()`、[top_tip.rs](tui/src/app/top_tip.rs) |
| 输入区域 | `composer` | 容纳输入框；需要审批时改为显示审批选项 | [fullscreen/composer.rs](tui/src/app/fullscreen/composer.rs) |
| 实际输入框 | `input` | 普通情况下位于 `composer` 内；审批时高度为零 | [composer/surface.rs](tui/src/thread/composer/surface.rs) |
| hintline | `hintline` | `Enter send` 等当前操作提示；普通布局预留一行 | [footer.rs](tui/src/app/footer.rs) |
| Agent 切换栏 | `agent_thread_switcher` | Main / Subagent 会话切换，位于快捷键区下方 | [thread.rs](tui/src/thread.rs) 的 `draw_agent_thread_switcher` 入口 |

顶部右侧显示工作区/会话状态摘要；聊天进度与听写状态的位置见[聊天进度与听写状态](#聊天进度与听写状态)。`tipline` 优先显示听写，其余时间显示临时提示或导航提示；权限在 statusline 持续显示。输入区下分隔线上的模型与任务模式标签由 [fullscreen/composer.rs](tui/src/app/fullscreen/composer.rs) 绘制。

顶部 statusline 的分支、工作目录、上下文和 Dashboard 是彼此独立的交互项。点击分支打开本地分支选择；点击工作目录打开同一 Project、同一 Environment 下的根目录选择并由 CLI host 重建 workspace 连接；上下文静止时显示 `已用 / 容量`，hover 或键盘焦点时复用 StatusLine 的 Context 进度条；Dashboard 打开 Session 管理页。空输入时按 `F6` 聚焦标题栏，左右键移动，`Enter` 激活，`Esc` 返回输入。

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
| 弹窗提示 | `footer` | 位于弹窗内部，与页面 `session.hintline` 分开 |

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
┌─ 活动视口 ────────────────────────────────────────────────┐
│ 活动正文 transcript：当前回复、工具内容                   │
│ 目标 goal / 计划 plan / 待发送队列 queue          [可选]  │
│ 提问 request                                   [可选]     │
│ 本轮运行状态行 progress                         [运行时]  │
│ 输入上方提示 tipline：听写状态和临时提示                  │
│ ──────────────────────────────────────────────────────    │
│ > 输入正文                                                │
│ ──────────────────────────────────────────────────────    │
│ statusline 第一行：模型、任务模式、环境与统计信息         │
│ statusline 第二行：权限；操作时由 hintline 覆盖           │
│ Agent 切换栏 agent_thread_switcher               [可选]   │
└───────────────────────────────────────────────────────────┘
```

[inline/layout.rs](tui/src/app/inline/layout.rs) 的 `height()` 按控制区所需高度加上 8 行活动正文计算视口高度，最多占终端当前高度；这是高度预算，正文实际可用空间由 `session_areas()` 分配。它不会随着已完成消息数量持续长高。历史浏览时正文最小预算为 4 行；窗口太矮时，提问与输入会挤压该预算，再让出 tipline 的空间，保留待回答的问题、输入框和 statusline。

inline 与 fullscreen 共用 `SessionAreas` 和控制区位置计算，由 inline 的页面入口提供活动视口范围。差异集中在三个入口：

| 职责 | 实现入口 |
| --- | --- |
| 定稿历史与活动尾部分开输出，记录已写出的单元身份 | [output.rs](tui/src/app/inline/output.rs)、[scrollback.rs](tui/src/terminal/scrollback.rs) |
| 欢迎信息在普通主屏输出时写入一次 | [header.rs](tui/src/app/inline/header.rs) |
| 底部 statusline 第一行显示模型等配置信息，第二行平时显示权限，操作提示由 hintline 覆盖该行；听写使用输入框上方的 tipline，本轮运行状态固定在 tipline 上方，由 chat_view 绘制 | [footer.rs](tui/src/app/inline/footer.rs) |

`Output` 在当前 Thread 内按稳定单元身份去重，普通重绘和重复快照不会再次写出已定稿块；旧分页内容留在正文浏览器中，避免插入较早消息打乱主屏输出顺序。切换 Thread 会重置输出记录，并绘制目标 Thread。

临时备用屏幕关闭时恢复主屏；若打开期间终端变矮，`replay_clipped_history()` 计算受裁切的历史块并补写。这个尺寸恢复步骤和日常重绘不同。退出时 `finish()` 关闭临时屏幕，再按顺序写出尚未提交的定稿块与活动尾部。

稳定视口用于避免刷新时不断追加空行；原有空行增长问题的回归覆盖见 [output_tests.rs](tui/src/app/inline/output_tests.rs) 与 [CLI/PTY 场景](../ash-cli/tests/tui/terminal.rs)。

### 临时面板、补全与历史浏览

[output::expanded()](tui/src/app/inline/output.rs) 统一判断是否需要临时备用屏幕：命令面板、正文详情浮层、补全、会话或 Issue 管理、预览和正文浏览都走这个终端入口。终端切换由 `TerminalSession::set_inline_overlay()` 完成，功能页不直接写屏幕控制序列。

命令面板区域由 `command_panel_areas()` 分配：正文占上方剩余区域，面板占 `session.composer`，提示留在 `session.hintline`，实际输入框隐藏。外框与正文边界由 [widgets/panel.rs](tui/src/widgets/panel.rs) 的 `PanelLayout` 计算：标题一行、标题后空一行，再放页签和正文；内容左右各留两列。[inline/panel.rs](tui/src/app/inline/panel.rs) 只承载同一个 `CommandPanel` 功能编辑器。

面板打开时，按键、粘贴和底部提示归面板；后台到达的审批和提问保留到关闭后处理。关闭不把面板内容写入对话历史。补全使用 `Layout::completion_area()` 和共享候选组件，在临时屏幕里绘制；不会成为新的正文单元。

Ctrl+Home 进入较早正文浏览，Ctrl+End 返回当前回复。浏览位置按单元身份和行偏移保存。会话管理和预览使用自己的 `SessionNavigation`；预览没有实际输入框，不能把浏览键误认为发送。

inline 空输入时按 ← 打开 Dashboard，按 → 或 Esc 返回当前会话。聚焦管理列表的会话条目时，→ 同样返回；聚焦分组标题时，左右键仍用于展开、收起分组。预览、详情和命令面板先处理自己的按键。输入框正在编辑非空草稿时，左右键继续移动输入光标。

## 鼠标与横向对齐

fullscreen 捕获鼠标：点击输入区移动光标，拖拽、双击、三击分别选文字、词、行，松开后复制；草稿选区保留，可删除或用输入、粘贴替换。只读正文和模态框文字也可选文，列表与按钮仍使用自己的点击动作。inline 不捕获鼠标，选文和复制交给终端，应用通过键盘操作。

fullscreen 的 [pointer.rs](tui/src/app/fullscreen/pointer.rs) 聚合各组件按绘制布局提供的命中目标，`PointerInteraction` 保存悬停与按下状态，绘制使用共享 `InteractionState`。悬停、键盘焦点和选中彼此独立；工作区栏用前景色与文字强调反馈鼠标，键盘焦点另加下划线。

行首的消息身份、列表焦点 `>` 和 inline 输入提示使用“状态标识列”；其分隔留白之外才是内容区。无标识时仍保留这一列，组件不能重复预留。fullscreen 的 `> ` 属于输入区本身；两种输入提示均占两列，计入换行与光标宽度。具体约束见 [TUI 布局规范](../.github/instructions/tui.instructions.md#learnings)。

### 正文结果与详情组件

命令回执、工具输出和展开的消息详情由 [MessageResponse](tui/src/thread/transcript/message_response.rs) 统一排版，用 `└─` 表示它们属于上一条记录。以本条记录的起始位置为第 0 列，连接符左侧留一列空白，详情文字从第 4 列开始；原始续行、自动换行和 `view full` 入口也从这一列开始。状态标识留在第 0 列，详情不会另占一套状态标识列。fullscreen、inline 活动正文和写入终端历史的正文共用这一规则。终端不足五列时缩短连接符区域，保留一列显示内容。

```text
> /command
 └─ command result
    next output line

● tool summary
 └─ tool output
    next output line
```

| 职责 | 所属位置 |
| --- | --- |
| 工具状态、结果、分组、预览长度和失败原因；本地命令及消息详情内容 | 对应 `HistoryCell`：`ExecCell`、`LocalCommandCell` 和 `ContentCell`；记录决定是否提供完整详情动作 |
| 结果与详情的容器、ANSI / 普通文字样式、完整详情动作的文字行和区域 | `MessageResponse`；接受已着色的失败提示，保留调用方给出的语义颜色 |
| 首行连接符、续行留白、可用正文宽度和换行 | 同一个文件内私有的 `PrefixedBlock`，先按正文宽度换行，再添加前缀；不会重复连接符 |
| 展开选择、正文滚动和动作执行 | 正文视图及各屏幕模式的浏览状态；视图用组件给出的动作区域处理命中及悬停，包括换行后的每一行 |
| 记录行数、缓存和视口裁剪 | `CellLines` 与 `ChatHistoryRenderCache`；将组件的行位置换算为整条记录的位置，绘制与命中共用测量结果 |
| 摘要的消息标识和普通前缀操作 | `history_cell/text.rs` 与 `render::prefix_lines`；不负责结果与详情的布局 |

`MessageResponse` 是正文内部的无状态组件，不移入通用 `widgets`，也不持有独立焦点或输入生命周期。它结合了结果容器的语义与前缀排版的职责划分：对调用方只暴露结果、详情及动作入口，`PrefixedBlock` 留在实现文件内，避免业务层自行拼缩进和猜命中宽度。连接符表示内容归属；可否展开由记录能力决定，不能根据 `└─` 判断。输入区的 progress 技巧属于独立区域，不套用正文详情布局。

## 页面与状态归属

| 内容 | 保存与维护位置 |
| --- | --- |
| 会话、消息、配置、草稿、队列与功能请求 | 共用功能模块；`SessionsState` 保存目录与 Session/Thread 身份，不保存页面焦点 |
| 页面、焦点、Issues 浏览、子任务选择、正文滚动与展开项 | fullscreen / inline 分别持有；[SessionNavigation](tui/src/sessions/navigation.rs)、[Viewports](tui/src/thread/transcript/viewport.rs) 和 `QueueNavigation` 保存各模式的浏览选择 |
| 区域、容器与输入路由 | 共享 `chat_view.rs` 组合聊天区域；两种模式各自的 `layout.rs`、`navigation.rs`、`modal.rs` / `panel.rs`；[frame.rs](tui/src/app/frame.rs) 只选择绘制入口和资源需求 |
| 功能编辑与业务动作 | `CommandPanel` 共用功能编辑器，功能模块解释请求与结果；共享 `widgets` 提供外框、列表、页签和搜索 |
| 终端输出与恢复 | `TerminalSession`；[terminal/text.rs](tui/src/terminal/text.rs) 提取文字，不保存界面手势 |

两种模式不调用对方的绘制或导航，App 不计算页面坐标。共享数据删除条目后，各模式清理自己的失效选择。面板焦点、搜索与退出规范见 [TUI 模态交互规范](../.github/instructions/tui.instructions.md#命令面板与模态交互规范)。

### 屏幕模式切换

切换 fullscreen / inline 时恢复目标模式自己的页面、焦点和浏览位置。已打开的命令面板转交同一个功能编辑器，由目标模式的容器继续承载；转交不触发关闭，不创建第二份编辑状态。

新任务草稿由 `SessionsState.input` 保存，当前会话草稿由 `ThreadPresentationStore` 按 Thread 保存；只有输入目标相同才共用草稿，切换模式不会把新任务草稿送入当前会话。消息队列仍只有一份。

异步剪贴板读取绑定发起时的草稿身份和代次，返回后写入同一份草稿；切换到其他输入目标不会改变它的去向，已经提交的草稿不会接收迟到的图片。

页面焦点、会话预览和详情不随功能编辑器迁移。全屏鼠标按下、悬停和屏幕选区属于当前画面，切换时清除；草稿中的编辑选区跟随草稿，切换时结束尚未完成的拖拽。同一模式的设置重载保留当前焦点；若关闭了正在聚焦的顶部状态项，则焦点返回输入框。

### 任务模式选择与显示

任务模式和 fullscreen / inline 是两项独立选择：前者决定下一条任务的工作方式，后者决定终端怎样显示页面。五种任务模式使用 `/mode` 选择，也支持 `/mode agent|plan|debug|multitask|ask`。参数直接按协议中的稳定 ID 解析，不随界面语言或显示名称变化；命令输入不区分 ASCII 大小写。请求、队列和历史继续使用 `CollaborationMode` 强类型保存。共享行为见[五种任务模式](../ash-rs/collaboration-mode-templates/collaboration-modes.md)。

输入框聚焦时，Shift+Tab 按 Agent、Plan、Debug、Multitask、Ask 的顺序循环。切换只影响下一条消息；运行中选择其他模式后，Ctrl+Enter 也会排队。弹层继续使用所属组件自己的按键处理。

| 呈现 | 当前显示方式 |
| --- | --- |
| fullscreen | `model` 控制模型与推理档位标签，`mode` 控制非默认模式的可点击名称；输入框上下边线和输入符号使用模式色 |
| inline | 底部 statusline 显示模型与非默认任务模式，同样受 `model`、`mode` 控制；`mode` 两种模式均默认关闭 |
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
| 共用聊天组合与状态项布局 | `just test ash-tui --lib app::chat_view` |
| 共用应用流程 | `just test ash-tui --lib app::` |
| 本轮状态固定、正文滚动、中断及提示位置 | `just test ash-tui --lib chat_progress` |
| 听写准备、下载、录音状态与中断优先级 | `just test ash-tui --lib dictation` |
| inline 定稿历史与活动聊天进度分离 | `just test ash-tui --lib inline_history_commits` |

App 与组件验证按 [test-tui](../.agents/skills/test-tui/SKILL.md) 执行；实际进程、PTY 或终端边界按 [test-tui-pty](../.agents/skills/test-tui-pty/SKILL.md) 执行。正常构建与完整测试入口见 [README](README.md#测试与支持边界)。

真实终端验证从 [terminal.rs](../ash-cli/tests/tui/terminal.rs) 进入：

| 行为 | PTY 场景 |
| --- | --- |
| fullscreen 多轮历史与固定输入位置 | `just test-tui actual_tui_multiple_commands_preserve_internal_history_and_fixed_input` |
| inline 面板、缩放与退出保留历史 | `just test-tui actual_tui_inline_preserves_history_across_panels_resize_and_exit` |
| 即时切换并保存模式 | `just test-tui actual_tui_screen_mode_switches_live_and_persists` |

鼠标交接还可在至少 40×12 的真实 PTY 中运行 `just test ash-tui --lib real_terminal_mouse_handoff -- --ignored --nocapture --test-threads=1`。终端协议与部分失败恢复见 [session_tests.rs](tui/src/terminal/session_tests.rs)，输入编辑选区见 [editor_tests.rs](tui/src/thread/composer/input/editor_tests.rs)。

上述命令是验证入口，不代表本次已运行。既有 Windows ConPTY 场景覆盖输入、回复、滚动和退出恢复；新版首页与弹窗，以及其他终端和 tmux/Zellij 组合仍需在对应环境重新验证。fullscreen 历史完整性应检查应用正文，inline 才检查终端历史。
