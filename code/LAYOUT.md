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
| 推理强度选择 | 底部横向档位与 Multitask 开关，正文保留在上方 | 从 inline 打开时使用选项列表；从 fullscreen 转交时保留横向编辑器 |
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

两种模式共用聊天内容、输入组件、听写反馈和底部提示的组合规则。fullscreen 将 inline 底部 statusline 的环境信息移到顶部，保留底部 statusline 显示统计信息；模型靠近输入框，权限由同一配置控制，两种模式都显示在 footer 第二行，其他操作提示需要时覆盖该行。共同区域的内容、顺序和高度分配规则只维护一份，两种模式各自负责整页或活动视口的空间、滚动与终端输出。

### StatusLine 配置与显示位置

**StatusLine 配置决定显示什么，屏幕模式决定放在哪里。** 两种模式都使用 `/statusline` 和 `[tui].statusLine` 的同一组显示开关。移到顶部 statusline 或输入框边线的状态项仍受原来的开关控制，不新增一套 fullscreen 显示配置。

| 内容 | 配置项 | inline 位置 | fullscreen 位置 |
| --- | --- | --- | --- |
| 模型与推理档位 | `model` | 输入框下方的 statusline | 输入框下分隔线 |
| 非默认任务模式 | `mode` | 输入框下方的 statusline | 输入框下分隔线，跟在模型后面 |
| 权限模式 | `permissions` | footer 第二行；其他操作提示显示时暂时隐藏 | footer 第二行；其他操作提示显示时暂时隐藏 |
| Git 分支与变更 | `git-branch`、`git-changes` | 底部 statusline | 顶部 statusline |
| 上下文用量 | `context` | 底部 statusline | 顶部 statusline |
| 缓存命中率与参考费用 | `cache-hit-rate`、`reference-cost` | 底部 statusline | 底部 statusline |
| 内存与 CPU | `memory`、`cpu` | 底部 statusline | 底部 statusline |

模型、任务模式和权限的内容由共用状态组件负责；fullscreen 顶部上下文摘要点击或按 Enter 后打开独立的 `/context` 面板。状态项在每种模式中只显示一次；关闭后同时从两种模式隐藏，对应标签、分隔符和标签占用的宽度一起消失。任务模式仍保留默认 Agent 不显示名称的约定。

工作目录和 Dashboard 属于页面导航入口，不是 StatusLine 状态项，不纳入上述开关。关闭 Git 状态的显示只影响展示及其专属额外计算，不停止基础 Git 状态跟随。

### 区域名称与实际占行

**statusline、hintline、tipline 按内容命名，不代表每个名称都要独占一行。** 普通聊天页的输入框下方，两种模式都只预留两行；可选的 Agent 切换栏另算。

| 名称 | 内容 | fullscreen | inline |
| --- | --- | --- | --- |
| statusline | 模型、环境与统计等状态信息 | 顶部 `top_statusline` 显示环境信息；底部一行显示统计；模型靠近输入框 | 底部第一行显示模型、环境与统计信息 |
| hintline | 权限、当前操作快捷键、等待结果或待完成快捷键提示 | footer 第二行，组合权限与适用的 Dashboard 提示；其他交互覆盖该行 | footer 第二行，组合权限与适用的 Dashboard 提示；其他交互覆盖该行 |
| progress | 本轮运行状态、耗时、中断键与长任务技巧 | 输入控制区，位于 tipline 上方；运行时占一至两行 | 活动视口的输入控制区，位于 tipline 上方；运行时占一至两行 |
| tipline | 听写、临时反馈与首页引导 | 输入框上方一行 | 输入框上方一行 |

两种模式空输入时在第二行左侧依次显示权限与 Dashboard 入口；其他交互在权限与 hintline 之间切换，第一行的模型、统计等聊天状态信息保持原位。命令面板、正文详情和管理页使用自己的容器，背景聊天 statusline 隐藏，操作提示由页面 hintline 统一显示，功能容器提供当前可用动作。

两种模式的 hintline 都从内容区左侧开始，与底部 statusline 对齐。两种模式将权限与适用的 Dashboard 提示组成同一行；权限关闭时，Dashboard 从该行起点显示。窄窗口先为 Dashboard 留出宽度，再缩短权限文字。

普通输入状态下，两种模式共用一份快捷键提示，只在入口可用时显示 `← Dashboard`。发送、任务模式切换和推理档位调整的按键仍然共用同一套绑定，完整列表可在 `/help` 查看。聚焦菜单、面板、审批等交互时，提示由当前功能和焦点决定。

权限只显示一项：任务运行时显示当前生效的权限，空闲时显示已选择的权限。运行期间调整的选择用于下一次提交，不另外显示 `current:` 或 `next:`。

### Footer 第二行的覆盖与恢复

**普通聊天时 footer 占两行；空输入的 Dashboard 入口与权限共用第二行，需要处理其他交互时，该行显示对应操作提示。** 覆盖只改变显示内容，不改变当前权限策略或 StatusLine 配置。

| 当前状态 | 两种模式的第二行显示什么 |
| --- | --- |
| 普通输入、聊天运行、听写，或显示 tipline 临时反馈 | 权限模式；`permissions` 关闭时留空 |
| 输入框聚焦且没有文字、附件，也未进入输入历史搜索 | 左侧显示 `权限 · ← Dashboard`；`permissions` 关闭时仍显示入口 |
| 仅显示 `/`、`@`、`$` 补全候选 | 保持权限显示；候选列表放在自己的补全区域 |
| 待回答问题或待审批请求 | 对应 hintline，例如 `Enter to answer`、`Enter to confirm` |
| 答案或审批结果正在提交 | hintline 显示 `Waiting for the request result` |
| 聚焦队列、选择正文、聚焦 Agent 切换栏，或等待组合键的后续按键 | 对应操作的 hintline |
| 查看已结束的子任务 | hintline 提示选择 Main 或其他 Subagent |
| 打开命令面板、正文详情、管理页或预览 | 当前容器的操作提示，聊天权限暂时隐藏 |

返回普通聊天输入状态后，第二行恢复权限和适用的 Dashboard 入口；若 `permissions` 已关闭，则只显示适用的入口。关闭面板后若仍有后台到达的提问或审批，先显示该请求的 hintline，处理完请求并返回普通输入后再恢复。权限显示开关只控制权限文字，不控制操作提示是否出现；关闭状态项也不缩减预留的底部行数。

下面四个状态中的第一、第二行，始终对应同两个屏幕位置：

```text
普通聊天
  statusline 第一行：模型 · 分支 · 统计
  hintline 第二行：⏸ Manual

等待回答
  statusline 第一行：模型 · 分支 · 统计
  hintline 第二行：Enter to answer

提交答案
  statusline 第一行：模型 · 分支 · 统计
  hintline 第二行：Waiting for the request result

请求处理完毕，回到普通聊天
  statusline 第一行：模型 · 分支 · 统计
  hintline 第二行：⏸ Manual
```

两种模式第二行的权限或操作提示都不挤占第一行的模型与统计。

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
│ progress：Working... · 12s · esc to interrupt               │
│ tipline：正在听写 · 停止听写快捷键                             │
│ ──────────────────────────────────────────────────────────     │
│ > 输入正文                                                     │
│ ──────────────────────────── 模型 · 推理档位 · Plan ───────    │
│ 底部 statusline：缓存命中率 · 参考费用 · 内存 · CPU            │
│ hintline：权限与适用的 Dashboard，或当前操作提示              │
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
│ progress：Working... · 12s · esc to interrupt            │
│ tipline：正在听写 · 停止听写快捷键                          │
│ ──────────────────────────────────────────────────────────  │
│ > 输入正文                                                  │
│ ──────────────────────────────────────────────────────────  │
│ statusline 第一行：模型 · 推理档位 · Plan · 分支 · 统计     │
│ hintline 第二行：权限与适用的 Dashboard，或当前操作提示   │
│ Agent 切换栏                                       [可选]   │
└─────────────────────────────────────────────────────────────┘
```

inline 的 footer 第一行按配置顺序与可用宽度绘制模型、任务模式、环境与统计信息，第二行组合权限与适用的 Dashboard 提示，其他交互显示对应操作提示。fullscreen 将环境项移到顶部 statusline、模型与模式放到输入框下分隔线，底部 statusline 保留缓存命中率、参考费用和资源统计，第二行使用相同的权限与提示组合。两种模式的底部 statusline 也显示已有的计划与子任务运行摘要。两种模式的听写状态和停止快捷键统一放在 `tipline`；普通聊天页的共享 footer 为 statusline 和 hintline 各分配一行。没有启用的信息时对应状态行留空。

终端历史、鼠标捕获、正文滚动和模态框 / 临时面板的容器仍由各模式负责。两种模式不调用对方的绘制或导航；共享组件不拥有页面焦点或终端生命周期。

### 组合规则与验证

[chat_view.rs](tui/src/app/chat_view.rs) 统一分配消息、目标、计划、队列、提问、progress、tipline、输入、底部 footer 和 Agent 切换栏；[footer.rs](tui/src/app/footer.rs) 在底部空间内分配 statusline 与 hintline，统一组合和绘制状态、权限与快捷键，并处理弹窗提示换行、对齐和宽度预算。统计采样需求使用同一份行与宽度预算。模式布局提供可用空间和页面容器，功能模块提供状态内容与动作；导航行为仍由各功能和模式维护。

正常高度的普通聊天页中，两种模式的 `session.footer.statusline` 与 `session.footer.hintline` 都是相邻的两个一行矩形，由共享 footer 分配。两种模式的权限在 hintline 中显示，需要处理其他交互时，该行显示对应操作提示；无需再用重叠的区域表示权限与提示。命令面板和模态容器给 footer 提供仅用于提示的空间。

测试分别验证两种模式的完整文本与区域位置：状态项开关、状态项不重复、听写与权限同时可见、运行时显示当前权限、空闲时显示所选权限、窄宽度裁剪，第二行被操作提示覆盖及恢复，以及模式切换后配置与草稿保持不变。页面焦点、历史输出与终端恢复仍由各模式的测试覆盖。

### 上下文与会话状态面板

`/context` 和 `/status` 分别由 [context.rs](tui/src/context.rs) 与 [status/panel.rs](tui/src/status/panel.rs) 保存功能状态。命令职责和统计范围见 [README](README.md#命令与补全)。fullscreen 将它们放在按内容高度分配的居中模态框中；inline 在临时备用屏幕里显示面板，隐藏实际输入框。两种模式承载同一个功能面板，外框、页面位置与操作提示由各自容器负责。

“上下文”面板没有页签，先显示最近请求的用量摘要和进度条，再显示可展开的“容量说明”。Enter 切换展开状态，左右键也可展开或收起；fullscreen 点击该行走相同动作，摘要文字是只读内容。短窗口保留顶部摘要，↑/↓、PageUp/PageDown、Home/End 滚动下方容量说明。进度条的分母是可用输入预算；用量达到预算的 90% 时使用警示色，超过预算时条形填满并保留真实百分比。尚未请求、等待统计或缺少可用容量时不绘制进度条。

“会话状态”面板使用“会话 / 诊断”两个页签，Tab / Shift+Tab、左右键和 fullscreen 页签点击使用共享页签操作。“会话”页先展示身份信息，再以“本线程累计消耗”标题展示统计；两个页签分别保留滚动位置，↑/↓、PageUp/PageDown、Home/End 滚动当前页正文。可见的“诊断”页请求详细进程采样；查看上下文或会话信息不增加这项采样需求，StatusLine 的独立采样需求仍按配置计算。

切换屏幕模式时保留同一个面板的展开状态、页签和滚动位置。Esc 关闭后恢复原草稿与输入焦点；已关闭或被其他面板替换的查询，其迟到结果不会重新打开旧面板。inline 不接管鼠标，使用相同的键盘动作。

## 聊天进度与听写状态

本轮运行状态行（turn status / activity indicator）固定在输入控制区，位于 tipline 上方。它回答当前是否仍在运行、处于什么阶段以及怎样停止；正文流式输出和历史滚动都不改变它的位置。转圈符号叫 spinner；状态行不显示完成百分比。

| 内容 | fullscreen | inline |
| --- | --- | --- |
| 本轮状态、耗时、中断键和长任务技巧 | 固定的 `progress` 区域，位于 tipline 上方，不参与正文滚动 | 活动视口中固定的 `progress` 区域，位于 tipline 上方，不写入终端历史 |
| 听写阶段与下载字节数 | 输入框上方的 `tipline` | 输入框上方的 `tipline` |
| 停止听写快捷键 | 与听写状态一起显示在 `tipline` | 与听写状态一起显示在 `tipline` |
| 输入框下方的固定区域 | statusline 一行，第二行组合权限与操作提示 | statusline 一行，第二行组合权限与操作提示 |

[progress.rs](tui/src/thread/progress.rs) 拥有状态行的内容，[chat_view.rs](tui/src/app/chat_view.rs) 分配区域并绘制；[transcript/view.rs](tui/src/thread/transcript/view.rs) 只负责正文及其滚动。两种模式的听写阶段与停止快捷键由共享 tipline 绘制，不替换统计、权限或操作提示。

启动、运行和取消中的状态以 `...` 结尾，例如 `Starting...`、`Working...`、`Cancelling...`。运行时的 spinner verb 每轮选择一次，本轮内保持不变；英文、日文、中文和法文都带相同的三点后缀。等待批准、等待输入和等待功能就绪使用静止圆圈和明确的阶段文字，不转圈。标记保留状态色，阶段、耗时和快捷键使用弱化文字色，让正文保持主要阅读位置。

耗时按 `0s`、`59s`、`1m 00s`、`1h 00m 00s` 显示，从本轮开始累计，包含等待用户批准或回答的时间；隐藏状态行不会重置时钟。窄宽度优先保留中断快捷键，再裁剪阶段或省略耗时。运行八秒后可在状态行下显示一行技巧，使用 ` └─ ` 四列前缀：连接符左侧留一列空白，文字从第 4 列（从零计数）开始；等待用户操作时收起技巧。短终端先保留提问和输入，再分配状态行及可选提示。

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
│ 底部 statusline：缓存命中率、费用、资源统计                 │
│ hintline：权限与适用的 Dashboard，或当前操作提示           │
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
| 底部 statusline | `footer.statusline` | 输入框下方、hintline 上方的一行；显示缓存命中率、费用、资源和运行摘要 | [footer.rs](tui/src/app/footer.rs) |
| 本轮运行状态行 | `progress` | 固定在 tipline 上方；显示阶段、耗时、中断键和可选技巧 | [chat_view.rs](tui/src/app/chat_view.rs)、[progress.rs](tui/src/thread/progress.rs) |
| 输入框上方提示行 | `tipline` | 听写、临时提示和首页引导；正常布局预留一行 | [footer.rs](tui/src/app/fullscreen/footer.rs) 的 `draw_tip()`、[top_tip.rs](tui/src/app/top_tip.rs) |
| 输入区域 | `composer` | 容纳输入框；需要审批时改为显示审批选项 | [fullscreen/composer.rs](tui/src/app/fullscreen/composer.rs) |
| 实际输入框 | `input` | 普通情况下位于 `composer` 内；审批时高度为零 | [composer/surface.rs](tui/src/thread/composer/surface.rs) |
| hintline | `footer.hintline` | 权限与适用的 Dashboard 提示，或当前操作提示；普通布局预留一行 | [footer.rs](tui/src/app/footer.rs) |
| Agent 切换栏 | `agent_thread_switcher` | Main / Subagent 会话切换，位于快捷键区下方 | [thread.rs](tui/src/thread.rs) 的 `draw_agent_thread_switcher` 入口 |

顶部右侧显示工作区/会话状态摘要；聊天进度与听写状态的位置见[聊天进度与听写状态](#聊天进度与听写状态)。`tipline` 优先显示听写，其余时间显示临时提示或首页引导；权限与适用的 Dashboard 入口提示共用底部 hintline，其他交互显示对应操作提示。输入区下分隔线上的模型与任务模式标签由 [fullscreen/composer.rs](tui/src/app/fullscreen/composer.rs) 绘制。

顶部 statusline 的分支、工作目录、上下文和 Dashboard 是彼此独立的交互项。点击分支打开本地分支选择；点击工作目录打开同一 Project、同一 Environment 下的根目录选择并由 CLI host 重建 workspace 连接；上下文静止时显示 `已用 / 容量`，hover 或键盘焦点时复用 StatusLine 的 Context 进度条，缺少百分比时显示本地化的“上下文”文字入口，激活后打开 `/context`；Dashboard 打开 Session 管理页。空输入时按 `F6` 聚焦标题栏，左右键移动，`Enter` 激活，`Esc` 返回输入。

标题栏交互项是轻量文字入口：hover 和按下只改变前景色与文字强调，不绘制背景色；键盘焦点额外使用下划线，不能与鼠标 hover 混为同一状态。弹窗、列表和输入控件仍使用各自的共享 hover surface。

审批区使用 `session.composer`，入口是 [interaction/approval.rs](tui/src/thread/interaction/approval.rs)；它与上方的提问区 `session.request` 是两个不同区域。

### 输入区域

两种模式的输入区都使用上下分隔线。fullscreen 使用 `ChatInputChrome::Mode`，模型与推理档位显示在下线右侧，非默认任务模式另有可点击标签；绘制见 [composer.rs](tui/src/app/fullscreen/composer.rs)。换行、光标和历史搜索提示由共享 [输入组件](tui/src/thread/composer/input/view.rs) 与 [surface.rs](tui/src/thread/composer/surface.rs) 处理；横向边界见[鼠标与横向对齐](#鼠标与横向对齐)。

### 补全浮层

`/`、`@`、`$` 的候选覆盖输入区上方的页面，不额外占用 `SessionAreas` 高度。`Layout::completion_area()` 给出消息区顶部至实际输入框顶部的全宽区域，候选高度按条目数和可用空间确定。弹窗打开时不绘制补全。

[completion/view.rs](tui/src/thread/composer/input/completion/view.rs) 同时绘制候选与整行背景，背景包括左右留白，避免露出被覆盖页面的旧文字。前缀含义与提交规则见 [README](README.md#命令与补全)。

### 居中弹窗

`/effort` 的 fullscreen 编辑器位于底部，不使用居中外框；[fullscreen/modal.rs](tui/src/app/fullscreen/modal.rs) 分配底部区域，头部复用 [widgets/panel.rs](tui/src/widgets/panel.rs) 的布局和绘制：标题嵌入顶部横线，下一行留空，再放正文；操作提示由页面底部 hintline 绘制。[effort_selector.rs](tui/src/models/effort_selector.rs) 负责档位、Multitask 暂选、说明和文字动画。档位数量、顺序和默认值直接来自当前模型目录。相邻档位中心的标准间距为 12 列，轴长按档位数量和标签宽度计算；标签围绕对应刻度居中，单档位居中显示。空间不足时先等距压缩，标签仍放不下时只显示一段档位，左右选择自动移动可见范围。宽屏将轴线和右侧 Multitask 开关作为一组居中；窄屏将开关单独居中放到轴线下方。轴线两端显示 `Faster` / `Smarter`，不另加当前档位或执行方说明。说明文本限制为 84 列，文本区及换行后的每一行文字都居中。选中档位不铺背景，以加粗文字和同色箭头标识；各档位的固定主题色见 [命令与补全](README.md#命令与补全)。未选档位和说明使用灰色，鼠标悬停和按下仍保留交互反馈。开关为 `on` / `off` 预留相同宽度，切换时不改变轴线位置；开启 Multitask 播放文字颜色波纹，指向 `max` 时文字播放彩虹变化，箭头跟随首字母颜色，两者独立停止；其他档位使用固定颜色。绘制、鼠标命中和内容高度使用同一布局。背景草稿保留但不接收输入；确认或取消后恢复原页面焦点。选择器接管输入框及以下的底部聊天区域，`tipline` 移到选择器上方，复制等临时反馈仍在右侧显示；底部操作提示使用 `hintline`。正文区域止于 `tipline` 上沿，不被选择器遮挡。具体按键和提交约定见 [命令与补全](README.md#命令与补全)。

模型、设置和帮助等命令面板覆盖当前页面。外框由 [widgets/modal.rs](tui/src/widgets/modal.rs) 的 `ModalLayout` 计算，内容由 [fullscreen/modal.rs](tui/src/app/fullscreen/modal.rs) 组合：

| 区域 | 代码名称 | 边界 |
| --- | --- | --- |
| 整体、标题与关闭入口 | `surface` / `title` / `close` | 右上角 `[✗]` 关闭；悬停只改变样式，关闭也可用 Esc |
| 内容与页签 | `content` / `tabs` | 内容区包含可选页签与正文 |
| 正文 | `body_area()` / `draw_body()` | 页签及间隔行以下，具体内容由功能模块负责 |
| 页面操作提示 | `session.footer.hintline` | 固定在页面底部，按当前焦点与编辑状态显示；窄窗口换行，弹窗不占用此区域 |

弹窗外框和正文不预留快捷键提示行。fullscreen 页面根据当前弹窗提示的本地化宽度预留底部 hintline，再分配弹窗区域；高度不足以显示完整换行提示时，按提示优先级保留退出操作。提示不被弹窗覆盖，点击提示区不关闭弹窗。按键仍由当前功能和模态容器处理，关闭后恢复页面对应的提示。

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
│ hintline 第二行：权限与适用的 Dashboard，或当前操作提示 │
│ Agent 切换栏 agent_thread_switcher               [可选]   │
└───────────────────────────────────────────────────────────┘
```

[inline/layout.rs](tui/src/app/inline/layout.rs) 的 `height()` 按控制区所需高度加上 8 行活动正文计算视口高度，最多占终端当前高度；这是高度预算，正文实际可用空间由 `session_areas()` 分配。它不会随着已完成消息数量持续长高。历史浏览时正文最小预算为 4 行；窗口太矮时，提问与输入会挤压该预算，再让出 tipline 的空间，保留待回答的问题、输入框和 statusline。

inline 与 fullscreen 共用 `SessionAreas`、控制区位置计算和底部 footer，由 inline 的页面入口提供活动视口范围。相关入口如下：

| 职责 | 实现入口 |
| --- | --- |
| 定稿历史与活动尾部分开输出，记录已写出的单元身份 | [output.rs](tui/src/app/inline/output.rs)、[scrollback.rs](tui/src/terminal/scrollback.rs) |
| 欢迎信息在普通主屏输出时写入一次 | [header.rs](tui/src/app/inline/header.rs) |
| 底部第一行显示模型等配置信息，第二行组合权限与适用的 Dashboard 提示，其他操作提示覆盖该行；听写使用输入框上方的 tipline，本轮运行状态固定在 tipline 上方，由 chat_view 绘制 | [footer.rs](tui/src/app/footer.rs) |

`Output` 在当前 Thread 内按稳定单元身份去重，普通重绘和重复快照不会再次写出已定稿块；旧分页内容留在正文浏览器中，避免插入较早消息打乱主屏输出顺序。切换 Thread 会重置输出记录，并绘制目标 Thread。

临时备用屏幕关闭时恢复主屏；若打开期间终端变矮，`replay_clipped_history()` 计算受裁切的历史块并补写。这个尺寸恢复步骤和日常重绘不同。退出时 `finish()` 关闭临时屏幕，再按顺序写出尚未提交的定稿块与活动尾部。

稳定视口用于避免刷新时不断追加空行；原有空行增长问题的回归覆盖见 [output_tests.rs](tui/src/app/inline/output_tests.rs) 与 [CLI/PTY 场景](../ash-cli/tests/tui/terminal.rs)。

### 临时面板、补全与历史浏览

[output::expanded()](tui/src/app/inline/output.rs) 统一判断是否需要临时备用屏幕：命令面板、正文详情浮层、补全、会话或 Issue 管理、预览和正文浏览都走这个终端入口。终端切换由 `TerminalSession::set_inline_overlay()` 完成，功能页不直接写屏幕控制序列。

命令面板区域由 `command_panel_areas()` 分配：正文占上方剩余区域，面板占 `session.composer`，提示留在 `session.footer.hintline`，实际输入框隐藏。外框与正文边界由 [widgets/panel.rs](tui/src/widgets/panel.rs) 的 `PanelLayout` 计算：标题一行、标题后空一行，再放页签和正文；内容左右各留两列。[inline/panel.rs](tui/src/app/inline/panel.rs) 只承载同一个 `CommandPanel` 功能编辑器。

面板打开时，按键、粘贴和底部提示归面板；后台到达的审批和提问保留到关闭后处理。关闭不把面板内容写入对话历史。补全使用 `Layout::completion_area()` 和共享候选组件，在临时屏幕里绘制；不会成为新的正文单元。

Ctrl+Home 进入较早正文浏览，Ctrl+End 返回当前回复。浏览位置按单元身份和行偏移保存。会话管理和预览使用自己的 `SessionNavigation`；预览没有实际输入框，不能把浏览键误认为发送。

Dashboard 使用独立页面：顶部保留状态信息，页面标题与分组方式嵌入 `widgets::panel` 的共享横线标题，正文前复用基座的一行留白；分组方式和 `g` 位于横线右侧，宽度不足以同时显示时保留页面标题。底部复用 hintline，中间在至少 96 列且正文至少三行时分成左侧会话列表、右侧所选会话概要。右侧从目录读取当前进展、项目和主线程模型，不随光标移动请求完整历史；完整线程详情和对话仍通过 `i`、Space 打开。窄终端使用单列列表。`/home` 仍进入新任务草稿页，两种模式都与 Dashboard 分开；已有对话草稿和新任务草稿继续分别保存。页面不显示欢迎信息或聊天输入框，打开即聚焦列表，背景草稿保持原样。fullscreen 单击会话行选中并更新右侧概要，双击或 Enter 打开会话；分组标题单击展开或收起。

Dashboard 分组之间空一行，组内保持连续；标题加粗、数量淡化，数量后的 `+` / `-` 表示收起 / 展开，空分组不显示展开标识。`sessions::manager` 管理分组、选择和展开，提供只含分组标题、会话的逻辑条目；键盘导航始终使用这份条目。`sessions::manager::view` 根据页面尺寸生成可见行及其矩形，统一插入组间空行和滚动提示，绘制和鼠标命中共用这一计算入口。间隔行计入滚动，但不接受点击或键盘选择。fullscreen、inline 只分配页面区域并协调功能返回的动作。

会话身份颜色由 `sessions::color` 负责，只接受 `SessionId` 和 `RenderContext` 并返回颜色；主题层按固定顺序提供已经过终端色深转换的 accent、keyword、string、function、variable 颜色，配色模块用完整 ID 的固定 FNV-1a 哈希选择其中一个。改名、排序、切换分组和重启不改变分配，切换主题会更新具体颜色，不同会话可以同色。列表和右侧概要使用相同身份颜色；列表的 view 再叠加共享 `render::interaction_style`，处理选中、悬停、按下与无色模式反馈。

fullscreen 和 inline 在首页或会话页的输入框聚焦且没有文字、附件时，按 ← 打开 Dashboard；两种模式都在底部 hintline 显示 `← Dashboard`，输入或焦点离开输入框后隐藏，提示不随临时消息到期消失。Esc 返回进入前的首页或会话并恢复输入焦点。inline 聚焦管理列表的会话条目时，→ 也可返回；聚焦分组标题时，左右键仍用于展开、收起分组。预览、详情、命令面板和输入历史搜索先处理自己的按键。输入框正在编辑非空草稿时，即使光标已在最左端，左右键仍只移动输入光标。

## 鼠标与横向对齐

fullscreen 捕获鼠标：点击输入区移动光标，拖拽、双击、三击分别选文字、词、行，松开后复制；草稿选区保留，可删除或用输入、粘贴替换。只读正文和模态框文字也可选文，列表与按钮仍使用自己的点击动作。inline 不捕获鼠标，选文和复制交给终端，应用通过键盘操作。

fullscreen 的 [pointer.rs](tui/src/app/fullscreen/pointer.rs) 聚合各组件按绘制布局提供的命中目标，`PointerInteraction` 保存悬停与按下状态，绘制使用共享 `InteractionState`。悬停、键盘焦点和选中彼此独立；工作区栏用前景色与文字强调反馈鼠标，键盘焦点另加下划线。

行首的消息身份、列表焦点 `>` 和 inline 输入提示使用“状态标识列”；其分隔留白之外才是内容区。无标识时仍保留这一列，组件不能重复预留。fullscreen 的 `> ` 属于输入区本身；两种输入提示均占两列，计入换行与光标宽度。具体约束见 [TUI 布局规范](../.github/instructions/tui.instructions.md#learnings)。

### 正文结果与详情组件

工具记录默认显示实际操作对象：读取显示文件名、路径与请求范围；搜索显示搜索词、范围与一条实际结果；命令显示实际 argv、退出码和一条输出。探索分组逐项保留对象与失败状态，不能只显示操作数量。对象由工具 owner 的 `ToolActivity` 提供，界面不按工具名猜行为；退出码非零显示命令失败，即使工具正常返回结果，也不据此推断任务或测试成功。原始工具名、参数字段、工作目录与完整输出留在详情；默认文字每行最多 240 字节。默认提供“查看完整详情”入口；用 Ctrl+↑ / Ctrl+↓ 选中记录后，Space 展开预览，Enter 打开完整详情，Esc 关闭并恢复选择。思考记录默认显示公开摘要的前 240 个字符、最多三行，较长摘要同样提供完整详情；没有文本的思考记录保留来源身份，后续可更新，但不显示、不参与键盘导航。显示语言只翻译界面标签，路径、命令、搜索词和模型内容保持原文。

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
| 结果与详情的容器、ANSI / 普通文字样式、完整详情动作的文字行和区域 | `MessageResponse`；一次布局调用使用同一宽度和主题，返回最终屏幕行与组件内的相对动作区域；接受已着色的失败提示 |
| 首行连接符、续行留白和可用正文宽度 | 同一个文件内私有的 `PrefixedBlock`，按正文宽度调用共享换行，再添加前缀；不会重复连接符 |
| 文字换行、跨颜色片段的词与组合字符、来源列位置 | [render/text.rs](tui/src/render/text.rs)；按整行文字确定断行，带链接的文字共用算法，链接目标不参与测宽 |
| 展开选择、正文滚动和动作执行 | 正文视图及各屏幕模式的浏览状态；视图用组件给出的动作区域处理命中及悬停，包括换行后的每一行 |
| 记录组合、行数、输入背景范围和动作位置 | `CellLines`；全部使用最终屏幕行，追加组件时只偏移动作位置一次，不再按换行高度反复换算 |
| 排版结果与屏幕 buffer 缓存、视口裁剪 | `ChatHistoryRenderCache`；测量得到的行在原有缓存预算内保存，可见时直接复用并生成 buffer；外层只裁剪和绘制，不再次换行，未显示的记录不提前生成 buffer |
| 摘要的消息标识和普通前缀操作 | `history_cell/text.rs` 与 `render::prefix_lines`；摘要同样返回已换好的屏幕行，不负责结果与详情的布局 |

`MessageResponse` 是正文内部的无状态组件，不移入通用 `widgets`，也不持有独立焦点或输入生命周期。它结合了结果容器的语义与前缀排版的职责划分：对调用方只暴露结果、详情及动作入口，`PrefixedBlock` 留在实现文件内，避免业务层自行拼缩进和猜命中宽度。连接符表示内容归属；可否展开由记录能力决定，不能根据 `└─` 判断。输入区的 progress 技巧也使用相同的四列前缀缩进，内容与绘制仍由 `progress` 负责。

文字按空白分隔的词换行；过宽的词按完整 Unicode 组合字符分行，路径和 URL 内的标点不额外提供断行机会。ANSI 颜色或 Markdown 样式切换不会改变断行位置。一个组合字符跨多个颜色片段时采用起始字符的样式，终端不能为同一个字形分别着色。软换行处的分隔空白由断行取代，排版不改写记录中的原始消息数据。


### 渲染链路与缓存归属

页面组合、功能内容、文字排版与终端写出各有自己的负责方。绘制、测量、滚动和鼠标命中使用同一份排版结果；排版读取显式输入，不写预览文件，也不判断文件是否存在。

| 内容 | 负责方与约定 |
| --- | --- |
| 整页、活动视口、焦点与浮层组合 | `app/fullscreen`、`app/inline`；共用 `app/chat_view.rs` 的聊天控制区，两种模式分别维护输出生命周期 |
| 字形宽度、正文换行与前缀预算 | [render/text.rs](tui/src/render/text.rs)；输入框共用完整 Unicode 字形及宽度，保留自己的字节范围、光标与选区；消息标识、Markdown 引用和列表的前缀共同占用宽度，窄窗口缩短前缀并留下正文空间 |
| 主题颜色与显示输入 | [render/palette.rs](tui/src/render/palette.rs) 保存调色板与终端颜色转换；[render/context.rs](tui/src/render/context.rs) 提供主题版本、语言、已准备的预览地址及当前帧链接输出 |
| 链接文字、来源列与当前帧范围 | [render/links.rs](tui/src/render/links.rs)；链接范围跟随排版与裁剪，链接目标不进入文字或复制 buffer；[terminal/hyperlinks.rs](tui/src/terminal/hyperlinks.rs) 只在写出时编码 OSC 8 |
| Mermaid 预览文件 | [host/mermaid_preview.rs](tui/src/host/mermaid_preview.rs) 在消息更新后准备文件，成功后发布地址；排版只查询内存中的地址，地址变化推进版本并使相关缓存失效 |
| 记录行、测量信息与屏幕 buffer 缓存 | [transcript/cache.rs](tui/src/thread/transcript/cache.rs)；按记录身份、内容版本、流式可见边界、宽度、主题、语言、预览地址版本及展开/选中状态复用，测量行与 buffer 共用有界预算 |
| Markdown 块复用与代码块高亮状态 | [transcript/markdown_cache.rs](tui/src/thread/transcript/markdown_cache.rs)；文字或显示输入变化时重排受影响块，代码高亮状态单独判断语言、主题和完整源码前缀；具体记录只接收这类内容缓存，不接收屏幕 buffer 缓存 |
| 正文视口与动作几何 | [transcript/view/layout.rs](tui/src/thread/transcript/view/layout.rs)；一次测量产生行高、动作区域、可见区、滚动偏移和跳转按钮位置，绘制与命中消费同一结果 |

流式消息的显示节奏仍由 `transcript/streaming.rs` 负责：它决定显示到哪段源码、何时提交，不保存 Markdown 排版缓存，也不在绘制期间推进源码边界。`MessageResponse` 及其私有前缀组件继续留在正文模块。


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
| 上下文与会话状态面板、窄窗口、模式转交及迟到结果隔离 | `just test-tui-unit app::status_tests` |
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
