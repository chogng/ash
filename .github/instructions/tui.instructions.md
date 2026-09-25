---
description: Ash CLI and Ratatui product ownership, architecture, interaction, and validation boundaries.
applyTo: "code/**,ash-cli/**"
---

# Ash Code CLI/TUI Guidelines

Do not add feature overviews, UI behavior specifications, design notes, change records, plans, or verification reports under `code/docs`; keep implementation guidance and targeted test commands with the owning crate, and keep cross-client methods, parameters, results, notifications, errors, and machine-output contracts in their owning API documents. See [`code/README.md`](../../code/README.md) for the product entry point. A specification or existing test file is not evidence that behavior passed acceptance.

`ash-cli/` owns the user-facing `ash` command and dispatches terminal presentation to `code/`. `code/` owns `ash-tui`, raw-mode lifecycle, Ratatui interaction, and terminal-only capabilities. Do not move this product presentation or lifecycle into `ash-rs`; shared backend semantics belong in backend-neutral contracts consumed by all three clients.

Keep one writer for each product state, render from explicit state, isolate side effects, reject stale asynchronous results by request/revision identity, and keep host adapters narrow. Feature behavior belongs in vertical feature owners rather than a global application switch.

Prefer command-line-observable tests for state, events, terminal output, timing, and lifecycle. Do not use screenshots or terminal pixel baselines as the primary pass/fail signal.

## 命令面板与模态交互规范

Ash Code 的命令面板在 fullscreen 中显示为模态框，在 inline 中显示为临时面板；两种呈现共用同一个功能编辑器。统一的是面板机制和同类操作的含义，功能数据、业务动作及子页面仍由对应功能负责。批准、提问和正文详情各有自己的交互容器，不因外观相似而塞进 `CommandPanel`。实现入口见 [ash-tui README](../../code/tui/README.md)。本节是新建和整改面板的要求，不能据此认定现有面板已经全部符合。

| 职责 | 唯一 owner | 约束 |
| --- | --- | --- |
| 打开、关闭、模式交接、背景输入拦截、焦点恢复和迟到结果隔离 | `app` 的模式容器 | 同一个编辑器只持有一份；全屏模态打开时不能把未处理按键传给背景页面。 |
| 外框、标题、关闭入口、内容区域和底部提示位置 | fullscreen 的 `widgets::modal`、inline 的 `widgets::panel` 与各自模式布局 | 功能面板只提供内容和状态，不另画同类外框。 |
| 页签、列表、搜索、展开、焦点顺序与命中测试 | `widgets::tab_list`、`widgets::list_selection`、`widgets::search_box` | 同类面板复用同一状态与输入路径；绘制和鼠标命中使用同一布局。 |
| 功能页、数据、验证、动作、请求及返回后的状态 | 对应功能模块 | 向容器返回明确结果；不复制外框、通用导航或另一种模式的状态。 |
| 通用按键及提示文字 | `keymap::bindings` 与当前组件状态 | 提示必须对应当前焦点和可执行动作；功能快捷键由功能 owner 声明。 |

同类面板遵循以下输入顺序：

1. 当前正在编辑的输入、按键录入或确认页先处理输入；其返回动作回到所属功能页。
2. 页签、搜索框和列表交给共用组件处理。`Tab` / `Shift+Tab` 切页并聚焦页签栏，即使只有一个页签也要移动焦点；页签栏的左右键切页，上下键按页签栏、独立动作（若有）、搜索框（若有）、列表的视觉顺序移动焦点；列表内的上下键先逐项移动，到边界才离开列表。
3. `/` 只表示搜索：支持搜索的列表在非文字编辑状态下用它聚焦搜索框；路径、密钥等普通输入不占用这个键。共用输入控件的外观不能代替搜索能力声明。没有搜索能力的页面不显示搜索提示；文字编辑中的 `/` 仍作为字符输入。搜索时 `Esc` 先退出搜索，再返回功能子页或关闭面板。
4. `Enter` 激活当前焦点的项目；需要提交远程搜索、确认危险动作或录入按键时，由相应功能页明确处理并显示对应提示。左右键展开或收起详情时复用列表机制。
5. 功能动作只在适用的焦点和状态下生效；通用导航键在同类面板保持相同含义，功能专用键按对象声明。可刷新的列表用 `r` 刷新；重置等其他动作使用不同入口，不与刷新混用。安装、卸载等动作由功能模块处理，并在当前页显示按键及结果。
6. `Esc` 逐级退出当前输入或子页，最后关闭面板；有未保存内容、待确认操作或进行中的请求时，由功能页明确决定能否退出。关闭和遮罩点击共用退出判定；模式切换转交同一个编辑器，不触发关闭。

`CommandPanel` 只适配功能页的正文、输入、提示和结果；不要在它的分支里检查某功能选中项并解释功能快捷键。功能页需要特殊按键时，在自己的模块中先判断适用状态，再把通用输入交给共用组件。新增面板优先复用已有列表、页签、搜索和输入组件；不同内容形态只替换正文，不复制整套面板行为。

固定高度面板需要页签时，直接复用 `TabList` 的状态、绘制、命中和页签焦点按键；功能模块只提供标签与业务身份，并根据返回的切页或进入正文结果执行业务动作。嵌入内容不保留未绘制的内部页签，只向父面板报告焦点到达边界；父面板不检查子组件内部索引来猜边界。

同一列表需要展示两个及以上稳定类别时，使用 `ListSelectionItem::as_section_divider` 标记分组标题，不为类别再加一层菜单。标题从内容区起始位置对齐项目文字，文字右侧用一条横线延伸到列表右边界；首组前不留空行，后续每组标题前恰好空一行，标题与首个项目之间不留空行。标题和间隔行只是呈现内容，不参与键盘选择、激活或鼠标命中。搜索跨组匹配项目；输入搜索词时隐藏分组标题和间隔行，仅显示匹配项目。分组的绘制、滚动行数和命中测试由 `widgets::list_selection` 统一实现，功能页只提供分组名称与项目。

验收时按功能 owner 测试按键、焦点、搜索、返回和业务结果；fullscreen 与 inline 分别验证面板呈现与关闭后的焦点。涉及鼠标时验证命中与键盘激活走同一动作，尺寸变化取消未完成的点击；涉及异步请求时验证关闭、替换或切换模式后的迟到结果不会重开旧面板。App 与渲染测试按 [test-tui](../../.agents/skills/test-tui/SKILL.md) 执行；只有行为依赖真实 CLI 进程、PTY 或宿主终端时，才按 [test-tui-pty](../../.agents/skills/test-tui-pty/SKILL.md) 增加进程边界验证。

## Learnings

* 行首用于列表选择、消息身份和 inline 输入提示的 `>`、状态圆点等符号的区域统一称为“状态标识列”，简称“标识列”；标识列及其分隔留白之外才是内容区。标签、正文和 fullscreen 输入框边框都从内容区开始，不能占用标识列；没有符号时标识列仍保留，不能让内容随状态左右移动。组件必须复用所在面板已有的标识列，不能在内容区内重复预留状态标识；fullscreen 的 `Box` 输入提示 `> ` 属于输入框本身，放在边框内并计入换行与光标宽度，inline 的 `Rules` 输入提示仍放在标识列。布局、命中测试和渲染测试必须使用同一边界；涉及此边界的变更，必须通过两种模式各自的完整 snapshot 和 buffer 列位置断言验证，不能只测试组件内部的相对对齐。

* 修改 TUI 布局、可见文案、焦点标识、交互或临时状态时，必须使用 [test-tui](../../.agents/skills/test-tui/SKILL.md)，在行为 owner 所属测试层更新操作断言和终端文本 snapshot；只有行为依赖真实 CLI 进程、PTY 或宿主终端时，才用 [test-tui-pty](../../.agents/skills/test-tui-pty/SKILL.md) 补边界验证。替换界面时同步替换对应覆盖，不能只删除旧基线。行为断言验证操作，文本 snapshot 验证完整可见内容和布局，二者不能相互替代。颜色、修饰符和动画等文本快照无法表达的反馈，必须另用实际渲染 buffer 的属性断言；动画注入固定时刻，不能靠 sleep 等待取样。

* 设计 StatusLine 数据需求时，先确认同一数据是否服务其他能力。Git 状态必须持续跟随 ChangeTurn；关闭 StatusLine 的 Git branch 或 Git changes 只能停止对应显示与 StatusLine 专属的额外计算，不能停止基础 Git 状态跟随。
* Status 只展示状态和证据，不拥有功能启停；需要跨启动保留的 TUI 诊断开关由 Config 写入 `[tui]`，运行层按配置管理诊断会话，不能把会话身份或采样结果写回配置。
* TUI 内置调色板统一使用 `ThemeRgb::from_hex("#RRGGBB")` 声明六位十六进制颜色，例如 `ThemeRgb::from_hex("#58a6ff")`；不要用 `ThemeRgb::new(0x58, 0xa6, 0xff)` 分散书写三个分量。`ThemeRgb` 只保存解析后的 RGB，内置值与用户主题共用格式校验，`RenderTheme` 不保存或解释颜色字符串。
* 新增可交互 item 时，能力 owner 必须用绘制所用的同一布局提供 typed hit-test，并把 `selected`、`hovered`、`pressed` 分别交给共享 `InteractionState`；页面组合层只聚合目标，不能按坐标猜业务身份，也不能靠 hover 改写键盘选择。点击必须复用该 item 的键盘激活路径；不可操作的只读行不暴露指针目标，并用 owner 测试断言整行命中、主题状态和键盘选择互不干扰。
