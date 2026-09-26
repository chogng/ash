# `ash-tui`

终端启动失败会保留原始 I/O 错误，并附上 Ash Code 自有的 [`ash-terminal-detection`](../terminal-detection/README.md) 检测的终端、版本、复用器、TERM 和颜色能力；模式获取失败仍执行已有的终端状态恢复。

`ash-tui` 是 Ash 的终端界面，主要负责：

- 接收文字、图片和命令，处理会话、设置与批准面板。
- 通过 App Server 客户端发送请求，把后端状态和流式正文显示到终端。
- 管理终端输入模式、绘制、滚动、鼠标捕获和退出清理。

从仓库根目录运行：

```sh
just ash
```

跨客户端契约见 [App Server API](../../docs/ash-app-server-api.md)，连接与请求见 [App Server Client](../../docs/app-server-client.md)；下面用于定位实现和运行验证。

## 文件与职责

| 要修改什么 | 从哪里开始 |
| --- | --- |
| 启动、事件循环和请求调度 | [start.rs](src/app/start.rs)、[event_loop.rs](src/app/event_loop.rs)、[driver.rs](src/app/driver.rs) |
| 输入历史、搜索和草稿回查 | [input/state.rs](src/thread/composer/input/state.rs)、[共享输入历史](../../ash-rs/message-history/README.md) |
| 输入、附件、补全和排队发送 | [composer](src/thread/composer)、[submission.rs](src/thread/composer/submission.rs) |
| 批准或回答问题 | [interaction](src/thread/interaction) |
| 正文、执行输出、缓存与滚动 | [transcript](src/thread/transcript) |
| Issue 分组、搜索、分页与工作详情 | [issues.rs](src/issues.rs) |
| Markdown 排版与表格 | [markdown.rs](src/render/markdown.rs)、[table.rs](src/render/markdown/table.rs) |
| Mermaid 流程图、状态图和时序图 | [独立排版 crate](../mermaid/README.md)；完整围栏后绘图，未支持或宽度不足时保留源码 |
| 流式显示进度与提交队列 | [streaming.rs](src/thread/transcript/streaming.rs) |
| 流式块复用与节奏策略 | [render.rs](src/thread/transcript/streaming/render.rs)、[chunking.rs](src/thread/transcript/streaming/chunking.rs) |
| 链接范围、换行与 OSC 8 输出 | [hyperlinks.rs](src/terminal/hyperlinks.rs) |
| 会话列表、预览、切换和详情 | [sessions](src/sessions) |
| 设置、主题、快捷键 | [config](src/config)、[theme](src/theme)、[keymap](src/keymap) |
| 持续内存诊断 | [memory.rs](src/memory.rs)；Config 提供开关，Status 只读展示 |
| 界面语言与类型化文案 | [nls.rs](src/nls.rs)；持久化由 [config/settings.rs](src/config/settings.rs) 负责 |
| 状态信息和本机资源 | [status](src/status)、[process_resources.rs](../../ash-rs/memory-diagnostics/src/process_resources.rs) |
| ChatGPT / xAI 订阅额度、余额与重置时间（`/usage`） | [usage.rs](src/usage.rs)，每次打开通过 App Server 查询；多订阅用 Tab 切换，Esc 关闭，再次运行刷新 |
| 终端恢复、鼠标捕获协议和历史输出 | [session.rs](src/terminal/session.rs)、[scrollback.rs](src/terminal/scrollback.rs)、[terminal.rs](src/terminal.rs) |
| 屏幕模式与页面组合 | [frame.rs](src/app/frame.rs)、[fullscreen.rs](src/app/fullscreen.rs)、[inline.rs](src/app/inline.rs) |
| 全屏布局、鼠标和选区 | [layout.rs](src/app/fullscreen/layout.rs)、[pointer.rs](src/app/fullscreen/pointer.rs)、[selection.rs](src/app/fullscreen/selection.rs) |
| 行内布局与历史追加 | [layout.rs](src/app/inline/layout.rs)、[output.rs](src/app/inline/output.rs) |
| 首页与对话页 | [home.rs](src/app/fullscreen/home.rs)、[conversation.rs](src/app/fullscreen/conversation.rs) |
| Modal 外框、标题、正文与底部区域 | [modal.rs](src/widgets/modal.rs) |
| 全屏输入区组合 | [composer.rs](src/app/fullscreen/composer.rs) |
| 模式内的按键路由与面板容器 | [全屏导航](src/app/fullscreen/navigation.rs)、[行内导航](src/app/inline/navigation.rs)、[全屏弹窗](src/app/fullscreen/modal.rs)、[行内面板](src/app/inline/panel.rs) |
| 欢迎信息、状态栏与提示位置 | 两种模式各自的 [全屏页眉](src/app/fullscreen/header.rs)、[行内页眉](src/app/inline/header.rs)、[全屏底栏](src/app/fullscreen/footer.rs)、[行内底栏](src/app/inline/footer.rs) |
| 命令面板共用控件和文字绘制 | [widgets](src/widgets)、[render](src/render) |

Skills、Models、Connectors 和 MCP 各自拥有同名模块；目录授权在 [dirs.rs](src/dirs.rs)。新增功能从对应模块进入，不在 App 里再建一套状态和请求流程。

“配置 → 提供商”按订阅和 API 分组；名称、稳定供应商 ID、凭据与套餐权限的区别见[订阅入口与 API 入口](../../docs/login.md#订阅入口与-api-入口)。列表文案由 [config](src/config) 与 [nls.rs](src/nls.rs) 维护。

一级模块按能力归属组织，模块内部按实际职责拆文件；小组件直接在同名文件中保留状态、交互和绘制。只有需要能力和依赖隔离时才另拆 crate。共享 `widgets` 提供列表、输入和提示绘制，`TopTip`、`ChatPanel`、`CommandPanel` 等应用交互组件归 `app`。

全屏界面的维护入口是 `app/fullscreen.rs` 与 `app/fullscreen/`：

- 全屏入口分别组合首页和对话页，持有页面、鼠标、选区、弹窗和正文浏览状态；会话管理与 Issues 的内容和操作由对应功能模块维护。
- 每种模式的 `layout.rs` 独立定义整页区域，绘制与命中共用本模式的区域计算；公共 App 不计算输入、正文或浮层坐标。`composer.rs` 组合全屏输入、批准、提问和队列。
- `navigation.rs` 负责区域间的按键路由、焦点顺序、正文导航与面板打开关闭，功能组件继续处理自身的编辑和操作。全屏 `pointer.rs` 处理鼠标路由，`selection.rs` 处理屏幕文字选区和复制结果；输入框的光标与编辑选区由 `thread/composer/input` 持有。
- `fullscreen/modal.rs` 负责弹窗层的绘制和输入路由；`widgets/modal.rs` 计算外框、标题、关闭按钮、正文与提示区域。`CommandPanel` 共用功能编辑器和操作结果，inline 由自己的 `panel.rs` 承载。
- `home.rs` 维护欢迎卡片与开始入口；欢迎卡片不进入对话历史。`header.rs` 左侧显示菜单入口、分支和目录，右侧显示其余已配置状态；`footer.rs` 用一行 hintbar 显示有效快捷键与权限状态。输入框保留标识列和左右内边距，模型名称嵌在右下边框，长标签按终端列宽省略。
- `frame.rs` 只选择屏幕绘制入口和可见资源需求。两种模式彼此不调用，共用正文、输入编辑、通用控件和终端能力。
- 终端模块负责捕获协议、输出与恢复，`terminal/text.rs` 负责缓冲区文字范围和提取，不保存界面手势状态。
- 命令面板的职责边界、焦点、搜索、返回和鼠标交互见 [TUI 模态交互规范](../../.github/instructions/tui.instructions.md#命令面板与模态交互规范)。

`app/inline.rs` 与全屏入口平级，组合主屏上的正文、输入区和临时面板；`inline/layout.rs` 决定局部绘制高度与区域，`inline/output.rs` 管理已输出记录、定稿正文追加和退出前提交。会话、消息、草稿、队列、模型与设置继续共用现有功能模块的数据和操作。

共享模型保存会话目录、活动 Session/Thread、消息、配置和按输入目标保存的草稿。`SessionsState` 不保存页面、焦点或浏览选择；[SessionNavigation](src/sessions/navigation.rs) 由 fullscreen 和 inline 分别持有，负责各自的会话管理、分组、选择、预览与详情。

两个模式分别持有 Issues 查询与浏览状态、子任务列表焦点，以及 [viewport.rs](src/thread/transcript/viewport.rs) 中按 Thread 保存的滚动、消息选中、展开项和队列焦点。`Queue` 只保存消息、排序、编辑和发送状态，`QueueNavigation` 保存各模式的选择。共享数据删除条目时，各视图清理自己失效的选择；另一种模式的导航动作不会修改本模式的页面或焦点。

切换模式恢复目标模式自己的页面、焦点和浏览位置。新任务草稿由 `SessionsState.input` 保存，当前会话草稿由 `ThreadPresentationStore` 按 Thread 保存；只有输入目标相同才共用草稿，切换模式不会把新任务草稿送入当前会话。消息队列仍只有一份。

异步剪贴板读取绑定发起时的草稿身份和代次，返回后写入同一份草稿；切换到其他输入目标不会改变它的去向，已经提交的草稿不会接收迟到的图片。

页面焦点、会话预览和详情不随功能编辑器迁移。鼠标按下、悬停和屏幕选区属于终端当前画面，切换时清除；草稿中的编辑选区跟随草稿，切换时结束尚未完成的拖拽。即使草稿已有文字，Esc 仍可退出正文选中并返回输入框；同一模式的设置重载不改变当前焦点。

两种模式的测试与文本快照分别放在 `fullscreen/` 和 `inline/`。定向运行 `just test ash-tui --lib app::fullscreen` 或 `just test ash-tui --lib app::inline`；模式隔离与面板转交运行 `just test ash-tui --lib app::mode_tests`，共用应用流程运行 `just test ash-tui --lib app::`。

跨功能命令由 [dispatch.rs](src/app/dispatch.rs) 分发，通过各功能接口执行，不在 `app` 中为功能类型追加方法。功能模块解释后端返回值：例如 `dirs::add` 统一校验添加结果，并返回 `AddedDir`，供行内命令和目录面板共用。测试执行助手只放在测试模块中。

会话管理器的导航和按键由 [SessionNavigation](src/sessions/navigation.rs) 处理，借用共享 [SessionsState](src/sessions/state.rs) 查询目录与会话身份，并返回同一套功能命令。`App` 只分发到选中的模式，不能直接写 fullscreen 的私有首页状态。两种模式不调用对方的导航或绘制入口。

## 启动与事件循环

CLI 将已初始化的 `AppServerSession` 和 `TuiOptions` 交给 `run`：

1. 校验初始化结果中的命令目录，拒绝非法名称、空描述和内置命令冲突；连接事件流只取一次。
2. 读取配置、主题和启动信息。普通 fullscreen 启动进入首页，只加载会话目录；inline 启动创建会话，指定恢复身份则直接打开该会话。
3. 创建或恢复会话时沿用已有 Thread 事件监听，安装快照与历史分页；首页没有活动会话时不建立 Thread 监听。
4. 终端输入、后端事件和后台完成事件分别唤醒主循环；主循环更新状态并按需绘制。
5. 退出时清理客户端工作并恢复终端；连接丢失时返回原因，以及存在时的持久化会话身份。

首页输入通过 Sessions 创建会话并发送首条消息，创建期间锁定完整草稿；创建失败或首条消息被拒绝时恢复文字、图片与长粘贴绑定。`/home` 或顶部 Home 返回首页，Esc 返回已有对话；返回首页不停止正在运行的任务。

首页“新建工作树”打开项目工作树选择器，可创建 detached 工作树，或选择已有工作树打开。选中其他工作树后按 `d` 可确认删除；Git 只删除干净、未绑定任务的关联工作树。创建后停留在列表并选中新目录；打开前会重新验证目录可用性。打开工作树不会新建会话，随后从该目录提交任务才开始新会话。直接在首页输入任务仍走默认 detached 受管工作树。顶部“项目分支”面板可切换未被占用的本地分支，用 `b` 在 HEAD 新建分支，或选中非当前分支后按 `d` 确认删除；未合并或仍被检出的分支不会被删除。

命令入队时记录来源模式和编辑器身份，后台请求沿用这个来源。预览、详情和 Issues 结果只回到发起它的模式，即使两个模式的请求代次相同也不会互相覆盖。配置、模型和主题的保存结果仍更新共享模型。

输入、请求完成和后端控制事件不能相互长期阻塞。同一资源的写请求保序，不同资源可以并发；中断、批准和回答使用独立控制请求。具体功能解释自己的响应，事件循环只负责转交和调度。

### 公共接口

公开类型和参数以 [lib.rs](src/lib.rs) 为准，模块默认私有。

| 接口 | 用途 |
| --- | --- |
| `client_capabilities` | 向后端声明通知、批准、提问、目录授权和工作协调能力 |
| `TuiOptions` | 指定标题、目录、profile、本地进程身份和恢复信息 |
| `run` | 在已初始化连接上运行一次交互会话 |
| `TuiRecoveryState` | 保存持久化 Session/Thread 身份，不携带连接或待执行请求 |
| `TuiExit` | 区分用户退出、系统终止和连接丢失；`ConnectionLost.recovery` 在尚无会话时为 `None` |
| `TuiError` | 报告客户端、事件流、关闭和终端错误 |

`with_remote_dir` 只设置远程展示目录，并关闭本地文件补全，避免把远程路径当成本机路径扫描。正文导出仍受先前配置的本机目录约束。`with_profile_root` 启用该 profile 的 TUI 主题目录，其他设置从后端配置读取。

## 输入如何提交

`ChatInput` 管理文字与原子元素，`ChatComposer` 根据任务状态产生 Submit、Queue 或 Steer。补全打开时，Enter/Tab 先处理候选，不能同时发送消息。

| 后端任务状态 | 发送行为 |
| --- | --- |
| 空闲 | Enter 提交新的 Turn |
| 已创建、尚未运行 | Enter 保存到本地 Queue |
| 运行中 | Enter 排队；Ctrl+Enter 单次补充当前任务 |
| 等待批准或回答 | 对应面板处理输入；仍可明确中断 |
| 取消中 | 抑制重复中断 |

运行中 Steer 不能改变 Skill；遇到这种草稿应保留输入，让用户排队或下一轮提交。权限模式的选择用于下一次 Turn，不直接改变当前任务或 Session 权限。

Queue 保存完整草稿，包括图片、长粘贴和绑定的 Skill。恢复编辑保留条目身份，重新排队时替换原条目；不能覆盖非空输入，也不能把编辑后的条目重复追加。发送成功后才移除，失败时保留可恢复内容。当前任务结束后，才将本地队列提交到后端。

任务完成、失败和中断由快照决定。正文增量不能决定终态；其他客户端创建了后续任务时，继续选择最早的未结束 Turn。本地设置或导出错误不改变这一判断。

### 长文本与图片

粘贴先统一换行符。超过 1000 个 Unicode 字符时，以绑定原文的原子占位符显示，提交前展开；重复内容仍有独立身份，删除占位符同时移除绑定。输入区最多显示六行；↑ / ↓ 在多行草稿内移动，到达首尾后从最近 100 条纯文本提交中召回上一条或下一条。

本地 PNG、JPEG、GIF、WEBP 路径和 Ctrl+V 剪贴板图片使用同一附件流程。单图最多 16 MiB；文件列表优先选择可解码图片，否则读取 RGBA 位图并编码为 PNG。草稿显示 `[Image #N]`，删除后重新编号，文字和图片顺序保持不变。

提交前，图片通过后端按 192 KiB 分块上传，或使用共享的远程 URL 安全导入接口，最后发送 `ImageAttachmentRef`。草稿中的本地路径和 data URL 不进入持久化正文、快照或命令收据。

### 命令与补全

| 前缀 | 数据来源与提交方式 |
| --- | --- |
| `/` | 合并本地和后端命令目录；已实现的产品命令进入对应请求流程 |
| `@` | 本地文件搜索与已生效 Plugin 目录；选择结果作为普通文字提交 |
| `$` | 已启用、兼容且无歧义的 Skill 元数据；提交文字及固定版本的 `SkillRef` |

命令补全只替换光标所在的首行命令名，保留参数、图片和粘贴绑定。例如 `/mod provider/model` 补全为 `/model provider/model`。移除命令后的空格后可以重新编辑名称。未知命令或不接受参数却带参数的命令按普通消息处理；已注册产品命令没有实现路径时不能冒充成功。

`/resume`、`/rewind`、`/add-dir`、`/branch`、`/fork`、`/model`、`/theme` 和 `/new` 支持行内参数；产品命令拒绝图片参数。命令后输入空格且参数尚为空时，光标后方以置灰样式（`context.muted()`）显示行内虚提示（如 `<path>`、`<model>`、`<theme>` 等），提示用户后续参数含义；用户输入非空白参数字符或光标移开时虚提示自动消失。命令回显和结果始终更新同一正文单元。

`/model` 无参数时只列出用户已配置提供商的目录模型，收藏页也只显示这些模型；没有候选时提示在 `/config` 配置提供商。模型出现在目录中不保证凭据或远端权限有效，实际调用仍由运行时校验。

文件补全只识别空白分隔的 `@token`，不处理邮箱中的 `@`。扫描遵守 Git 忽略规则、不跟随符号链接，并跳过 `.git`、`.ash`、`node_modules` 和 `target`；结果按匹配分数与路径稳定排序，最多 50 项。请求同时校验查询文本和版本，关闭补全后释放搜索句柄。

TUI 不扫描 Skill 正文；完整 `SKILL.md` 由后端在接受任务后按需加载。`skills/changed` 刷新目录与候选；Plugin 安装或变更也刷新相关 Skill 与打开的 Connector 面板。

## 面板怎样接入后端

下面只列会影响请求实现的导航、搜索和返回差异。

| 功能 | 接入要求 |
| --- | --- |
| 会话管理 | `/agents` 与 `/sessions` 打开同一管理器；`/subagents` 进入当前会话的 Thread 切换区 |
| 回退 | `/rewind` 或空输入下 500 ms 内连续 Esc 创建子 Thread，继承目标之前已结束的任务，原 Thread 不变 |
| 归档 | 归档当前会话成功后才创建新会话；归档列表的恢复不重跑已结束任务 |
| Skills | 目录只展示元数据；Manage 使用带来源的 Skill 身份与配置版本修改启用状态，随后重读 |
| Connectors | 支持设备码授权和断开；API key 与浏览器回调 OAuth 连接仍通过 Desktop 设置完成 |
| 目录 | 添加目录和授予访问权限分别处理；使用 Session RPC 与权限版本，不写入 profile 设置 |
| 设置和模型 | 带预期配置版本保存；各功能只接收自己需要的字段 |
| 批准和提问 | 只有后端选中且订阅该 Thread 的连接可以回答；禁止重复提交，超时由后端处理 |

Connector 操作见 [request.rs](src/connectors/request.rs)：设备码复制到剪贴板后打开验证网址，按服务端间隔轮询；失败时取消授权流程。目录版本和连接代次用于拒绝过期操作。

配置保存替换完整 `[tui]` 表，因此必须保留其他 TUI 设置。API key 只通过专用凭据接口保存，不进入普通配置或展示状态。快捷键候选先完成全量校验，保存失败时保留上一份有效规则。

`/config` 中的 Git 自动获取模式与间隔写入共享的 `[git]` 表。App Server 对有仓库修改授权的目录执行定时 fetch；Desktop、Rust GUI 和 TUI 读取同一份配置。

`/config` 的 Providers 页提供独立的 `ChatGPT subscription` 入口，可查看 Ash 账户和方案、启动设备码登录、取消登录或退出。验证地址与一次性代码显示在账户页；Esc 返回 Providers，待完成登录仍可重新进入查看和取消。TUI 使用共享账户接口，后端有 Codex 时只读复用，无 Codex 时负责续期和重新登录；缺失时生成兼容的 auth.json。复用模式断开不会退出 Codex；自管模式登出清除认证。重新连接仍有效的已有凭据无需浏览器。[认证存储与验收](../../ash-rs/docs/changes/chatgpt-auth/verification.md)。

资源采样由可见状态行项目和 Processes 页共同决定；没有需求时停止采样。关闭 Git 显示只停止状态行专属工作，不能停止 ChangeTurn 的目录跟随。

## Issue 工作流接入

`issues::Manager` 管理页面、搜索和请求代次，`board` 合并 GitHub 页面与后端工作记录并维护分组、折叠和稳定选择；`assignment` 承载分配预览、仓库设置和工作详情。Sessions 与 Issues 共用 `widgets::grouped_list` 的可见范围与排版。

列表刷新、工作概览与停止控制使用独立请求通道。关闭页面停止界面轮询，后端工作继续；迟到结果不能重开页面。缓存、领取、执行阶段、工作区、验收及 GitHub 同步由后端拥有，协议见 [Issue API](../../docs/ash-app-server-api.md#issue-任务与-pr)。

定向验证使用 `just test ash-tui issues`、`just test ash-tui session_manager` 和 `just test-tui issues:: -- --test-threads=1`。真实场景使用临时 Git 仓库与离线 GitHub fixture，覆盖分页、搜索、缓存、分配、暂停、组合验收和 PR 交付；不表示真实 GitHub 写入已联调。

## 正文更新与容量

正文保持协议中的原始输出，ANSI 颜色转换与制表符展开只在绘制时处理；每个 tab 显示为四个空格。代码块使用共享语法高亮；流式高亮只追加已换行的完整代码行，未知语言、解析失败或超限时保留原文。

| 对象 | 当前限制 |
| --- | --- |
| 一批流式更新 | 最多 256 个身份、1024 次更新、1 MiB 正文 |
| 临时正文 | 单条 256 KiB，最多 1024 个身份 |
| 跨 Thread 状态 | 共用草稿与队列保留最近 32 条 Thread；每种模式分别保留最近 32 份浏览状态，切换 Thread 时释放重型绘制缓存 |
| 进程资源历史 | 最多 301 个本机内存合计读数 |
| 连续更新重绘 | 首次请求后 16 ms 内；新请求不延后期限，输入可立即绘制 |
| 流式显示提交 | 正常每 40 ms 提交一个源码行范围；积压 8 行或最旧内容等待 120 ms 时追赶 |
| 显示队列 | 达到 1024 行立即显示积压；范围使用源码偏移，独立于终端宽度 |

Markdown 按完整消息解析，以顶层块复用排版结果；新增表格行和代码行会更新所属块，引用定义变化会重新排版整篇。宽度、主题和消息替换参与缓存校验，删除消息同步移除缓存。链接范围与文字分别保存，终端写出时才附加控制序列，复制与导出保持干净文字。

Thread 保存真实消息和独立的显示进度。流式队列保留源码范围与到达时间，末尾未换行内容更新时替换原范围，不延后提交期限。事件循环同时等待提交和重绘截止时间，持续输入也推进显示；没有积压就停止提交唤醒。追赶退出需持续低压力 250 ms，退出后冷却 250 ms，严重积压可立即再次追赶。完成、失败和中断立即显示已保留正文；快照、历史加载和切换对话直接展示已有内容。缩放按已显示源码重新排版，手动滚动继续保持单元锚点。复制和导出读取完整消息，不受显示进度限制。

只有同一会话、对话、持久化序号和流身份，且游标、正文版本连续的完整更新可以合并。提交、删除、清空、输入和控制事件结束当前批次。重复更新忽略；缺口或流切换则丢弃不可信的临时正文并重读快照。

执行输出按调用身份归组，稳定标识取组内第一个 `ToolCallId`。预览、展开和详情共用有界数据；“完整详情”指 TUI 获得的完整保留内容，必须保留上游省略标记。不能从文字猜测协议未提供的最终时长或退出码。

初始快照从最近 50 个 Turn 开始，订阅随后自动读完历史分页。全屏模式始终从同一正文模型绘制历史与当前回复。主屏模式把当前活动 Turn 之前的定稿前缀追加到终端历史，Turn 结束后再提交其正文；可变尾部继续局部重绘。后续加载的更早分页通过 Ctrl+Home 打开的正文浏览区查看，不能追加到较新的终端输出之后。滚动位置用单元身份和行偏移保存，不能依赖屏幕行号。

## 产品支持边界

Agent 回复与计划支持 Markdown 标题、列表、引用、强调、代码块、表格和链接；窄屏表格按字段逐项展示。HTTP(S) 链接通过 OSC 8 交给终端打开，本地路径保留可复制目标。用户输入和命令保持字面显示，HTML 标签作为文字显示。全屏模式提供点击、悬停、滚动和文字选择；拖选、双击选词或三击选行后自动复制，并显示复制结果。主屏模式的滚轮、选文和复制由终端处理。补全处理自己的事件，Vim 只改变输入框编辑。

`/export [relative-path]` 导出当前已加载正文，路径限制在本机工作目录内，不能覆盖已有文件。Ctrl+O 复制最后一条 Agent 回复。

断线后，TUI 丢弃旧连接的待执行请求和操作；存在活动会话时返回其持久化身份，首页尚无会话时返回 `None`，重连后重新进入首页。本地和远程 CLI 在 30 秒窗口内重连；失败时分别给出 `ash resume SESSION_ID THREAD_ID` 或 `ash remote connect ... --resume SESSION_ID THREAD_ID`。正常服务端关闭和协议错误不进入传输重试。

## TUI 主题文件

本节只拥有用户主题文件格式。

TUI 设置保存在 `<profile>/config.toml` 的根级 `[tui]` 表：

```toml
[tui]
screenMode = "fullscreen"
theme = "graphite"
inputMode = "standard"
keyHintStyle = "contrast"
glyphSet = "powerline"
memoryDiagnostics = false
autoUpdate = "latest"
showGitChangesAsDiff = false
statusLineStyle = "compact"
language = "en"
```

`screenMode` 只接受 `fullscreen` 和 `inline`，缺省为 `fullscreen`。已有主屏配置需要将该值更新为 `inline`；其他值按配置错误报告。在 Config 的“通用”页通过 Enter、Space 或左右键切换，保存成功后立即应用；外部配置重载也使用同一路径。设置沿用现有 Config 读写通路；本地运行保存在本机 profile，远程连接目前读取和写入远端 App Server 的 profile。本机独立 UX 配置通路尚未接入。启动时先验证设置，再获取终端模式；非法值会报告配置错误。

`keyHintStyle` 只接受 `contrast` 和 `muted`，缺省为 `contrast`。`contrast` 使用当前主题的前景色与粗体显示按键，说明文字使用弱化色；`muted` 保留整条弱化斜体效果。该设置由 Config 的“通用”页写入，fullscreen、inline 和两者的功能面板共用同一渲染通路并即时应用。

`glyphSet` 只接受 `powerline` 和 `plain`，缺省为 `powerline`。`powerline` 用 U+E0A0 显示 Git 分支标识，需要终端选用包含 Powerline 字形的字体；`plain` 显示文字 `git`，不依赖特殊字体。Config 的“通用”页可以切换该设置，保存和外部配置重载后立即更新顶部栏与丰富样式状态栏。终端名称不能可靠说明用户选用的字体，因此不会据此自动切换。

鼠标交互和选中复制由 `screenMode` 决定，不再提供独立开关。旧 `mouseInteractions`、`copyOnSelect` 字段不参与解析和运行决策，在 Config 的“通用”页保存设置时删除；它们不会改变已选择的屏幕模式。

`autoUpdate` 在“通用”页签中以单行选项切换：`latest` 跟随每次发布，`stable` 只跟随显式晋升的版本，`never` 不自动检查；缺省为 `latest`。CLI 在本地 TUI 启动时和运行期间读取这个 profile 设置，源码构建和其他安装方式不会被改写。下载、签名校验、诊断和版本切换契约见 [Ash Code README](../README.md)。

`language` 只接受 `en`、`ja`、`zh-CN`、`fr`，缺省为 `en`。当前实现会立即切换 Config 根页面；供应商名、语言服务器标识、模型回复、代码和用户内容保持原文。编辑任一设置时都会保留未知的 `[tui]` 同级字段，无效语言值会报告配置错误。

目录权限不属于 TUI profile 设置，只保存在对应 Session。用户主题内容保存为 `<profile>/code/themes/*.json`。每个文件最多 1 MiB；目录最多读取 128 个常规 JSON 文件；`id` 必须是小写 kebab-case，`label` 为 1–80 个已去除首尾空格的字符，`appearance` 只能是 `dark` 或 `light`，`colors` 最多覆盖 64 项且颜色必须是 `#RRGGBB`。未知字段、未知颜色名、重复/保留 ID 和不支持的版本都会使该主题文件单独失效。

```json
{
  "schemaVersion": 2,
  "id": "graphite",
  "label": "Graphite",
  "appearance": "dark",
  "colors": {
    "background": "#101010",
    "quickViewBackground": "#303030",
    "transcriptJumpBackground": "#414141",
    "userMessageBackground": "#252525",
    "actionForeground": "#58a6ff",
    "focus": "#8b80f9",
    "hoverBackground": "#25233a",
    "hoverForeground": "#f0edff"
  }
}
```

可覆盖字段为 `accent`、`accentSurfaceBackground`、`accentSurfaceForeground`、`actionForeground`、`background`、`border`、`chatInputChrome`、`danger`、`disabledForeground`、`focus`、`foreground`、`function`、`hoverBackground`、`hoverForeground`、`insertedBackground`、`insertedMarker`、`keyword`、`modalBorder`、`muted`、`pressedBackground`、`pressedForeground`、`quickViewBackground`、`removedBackground`、`removedMarker`、`selectionBackground`、`selectionForeground`、`screenSelectionBackground`、`screenSelectionForeground`、`string`、`success`、`transcriptJumpBackground`、`type`、`userMessageBackground`、`variable` 与 `warning`。未写字段继承所选 `appearance` 的内置调色板；该格式不接受图形界面 token、别名、透明色或颜色变换。

## 终端生命周期

`TerminalSession` 是终端输出的唯一入口。页面层决定绘制区域和提交哪些消息，消息模型决定定稿边界，组件共用输入、审批、设置和正文排版。

| 模式 | 终端控制 | 历史与退出 |
| --- | --- | --- |
| `fullscreen` | 备用屏幕、整屏绘制、应用处理鼠标滚动、屏幕选文和输入框编辑选区 | 正文内部滚动；退出恢复 shell 画面 |
| `inline` | 主屏局部绘制；保留原始输入、粘贴和焦点事件；不捕获鼠标 | 定稿内容按顺序追加；退出移除交互区域并保留已显示正文 |

全屏按以下顺序获取模式：原始输入 → 备用屏幕并保存、关闭滚轮转方向键 → 粘贴事件 → 焦点上报 → 鼠标捕获。全屏固定启用鼠标捕获和选中复制。点击输入框会移动草稿光标；拖拽选择草稿文字，松开后复制到剪贴板，并保留可供输入、粘贴或删除替换的编辑选区。输入框之外仍按屏幕文字选取处理。退出备用屏幕前恢复进入时的滚轮模式。

主屏沿用终端滚轮、选文和复制，不启用应用鼠标捕获。切入主屏时立即清除应用悬停、按下和选区状态，进行中的拖选不会触发复制。面板、补全和正文浏览可扩展当前交互区域；关闭后缩回输入与当前回复所需的高度。Ctrl+Home/End 打开历史浏览或返回当前回复。切换 Thread 会追加新的会话标题和该 Thread 当前已加载的历史；已写入的终端历史不重写。缩放与重复快照不会重复追加已输出的消息。

历史输出使用有界分块和普通终端滚动，不依赖局部滚动区域。临时输出缓冲区在最后写出时附加 OSC 8 链接并处理宽字符续列；它不参与后续布局、差分、复制或导出。

`TerminalModeGuard` 记录每一步是否成功。任一步失败或退出时，逆序关闭鼠标、焦点上报、粘贴事件，结束当前屏幕并关闭原始输入模式。显式恢复可重复调用，Drop 再次清理不会重复操作；退出或挂起时还要重置光标颜色并显示光标。

鼠标交互回归见 [pointer_tests.rs](src/app/fullscreen/pointer_tests.rs)，屏幕选区手势与样式见 [selection_tests.rs](src/app/fullscreen/selection_tests.rs)，输入框编辑选区见 [editor_tests.rs](src/thread/composer/input/editor_tests.rs) 和 [view_tests.rs](src/thread/composer/input/view_tests.rs)。尺寸变化时清除全屏悬停、按下和屏幕选区，并结束输入框拖拽；迟到的释放事件不能触发复制。在窗口至少 40×12 的真实 PTY 中运行 `just test ash-tui --lib real_terminal_mouse_handoff -- --ignored --nocapture --test-threads=1`，由 [event_loop_tests.rs](src/app/event_loop_tests.rs) 验证整屏捕获、补全点击、切换到主屏和退出恢复。该场景不替代各终端自身的选文与复制兼容性验证。

Ctrl+Z 在 Unix 上先恢复终端，再发送 SIGTSTP；`fg` 后重新获取模式并重绘。SIGINT/SIGTERM 进入正常事件循环退出路径。新增模式时同时修改获取标记、逆序清理和 [session_tests.rs](src/terminal/session_tests.rs) 中的部分失败测试。

## 修改 Welcome 宠物

只编辑 [pet.sprite](assets/welcome/pet.sprite) 中的终端格、帧和动作；[build.rs](build.rs) 在构建时校验并嵌入数据。

```sh
just pet
just pet frames
just pet click
```

这些命令分别预览静止帧、全部帧和点击动作。动作资源与独立预览已具备，Welcome 点击播放尚未接入。

## 测试与支持边界

在仓库根目录执行受影响的检查：

```sh
just check ash-tui
just test ash-tui
just test-tui
```

功能模块的测试检查状态、请求和完成结果；App 测试检查跨功能路由、优先级和退出；真实 PTY 场景检查完整 CLI/TUI 操作。`just test-tui` 先构建配套 daemon，Windows 与 Unix 使用同一宿主；可追加场景过滤器。上述命令是执行入口，不是本次通过记录。

真实场景入口为 `ash-cli/tests/tui_real_scenarios.rs`，只加载共享支持代码和以下四个模块；仍只生成一个集成测试程序。原测试函数名过滤器继续可用，也可用 `just test-tui config::` 按组运行。

| 模块 | 场景归属 |
| --- | --- |
| [terminal.rs](../../ash-cli/tests/tui/terminal.rs) | PTY、终端历史、滚动、尺寸、输入区域及进程退出恢复 |
| [conversation.rs](../../ash-cli/tests/tui/conversation.rs) | 对话、队列、审批、会话及对话中的 Git 状态 |
| [config.rs](../../ash-cli/tests/tui/config.rs) | 设置、供应商、账户、语言与配置面板导航 |
| [issues.rs](../../ash-cli/tests/tui/issues.rs) | Issue 选择、会话创建与 PR；目前仅 Unix 场景 |


渲染测试使用 Ratatui 字符缓冲区与 `insta`；状态、协议和副作用仍需独立断言。固定尺寸，规范化动态路径和身份，逐项审查 `.snap.new` 后再接受，具体操作见 [TUI 测试](../../.agents/skills/test-tui/SKILL.md)。

共享完整配置快照使用 `test_support::empty_config_snapshot`，测试只修改自己关心的字段。直接构造 `ThreadItem` 时显式填写各字段，避免测试助手隐藏实际业务要求。

## 全屏终端兼容性验证

全屏模式不向终端回滚区写入对话。验证重点是备用屏幕进入与恢复、固定交互区、Transcript 内部滚动、Resize、鼠标捕获和字符选择。

| 环境 | 当前证据 |
| --- | --- |
| VS Code / Windows ConPTY | 已有终端协议场景覆盖输入、回复、滚动和退出恢复；新首页与 Modal 布局仍需在该平台重新运行 |
| 其他环境 | Windows Terminal、WezTerm、macOS、Linux 终端及 tmux/Zellij 组合尚未重新验证 |

最小真实场景使用 `just test-tui actual_tui_input_keeps_hint_bar_without_blank_line_growth -- --nocapture`。多轮历史使用 `just test-tui actual_tui_multiple_commands_preserve_internal_history_and_fixed_input -- --nocapture`，它执行本地命令与 12 轮消息，核对本地命令和最后回复均可从同一 Transcript 到达，目录始终位于固定顶部栏。首页首次创建与跨进程恢复使用 `just test-tui actual_tui_home_creates_only_the_submitted_session_and_resumes_it -- --nocapture`。

终端模式协议由 [session_tests.rs](src/terminal/session_tests.rs) 检查，正文分页、稳定锚点和长内容由 [正文绘制测试](src/thread/transcript/view/render_tests.rs) 检查。历史完整性不能再用终端回滚行数判断。

主屏模式的真实边界检查使用 `just test-tui actual_tui_inline_preserves_history_across_panels_resize_and_exit -- --nocapture`；两种模式的即时切换和设置保存使用 `just test-tui actual_tui_screen_mode_switches_live_and_persists -- --nocapture`。组件状态与文本基线位于 [frame_tests.rs](src/app/inline/frame_tests.rs)，定稿边界与去重位于 [output_tests.rs](src/app/inline/output_tests.rs)，历史顺序与样式位于 [scrollback_tests.rs](src/terminal/scrollback_tests.rs)。命令列出验证入口，不代表所有终端组合均已验证。

输入历史验证：`just test ash-tui history`；跨进程重启验证：`just test-tui actual_tui_recalls_input_history_after_process_restart`。

## Marketplace 与语言服务器

- `/marketplace [query]` 按全部、技能、插件、MCP、连接器、可执行程序、编程语言、主题、语言包和资源页签浏览；安装前审阅整个包的版本、能力和权限。
- `/plugins` 直接打开 Marketplace 的“已安装”页签，按精确版本更新或卸载；使用中的包等待消费方释放后删除。
- `/lsp [language-id]` 查看当前目录可用服务器，修改启用状态、程序路径或恢复配置默认值。
- `/skills`、`/mcp`、`/connectors`、`/lsp` 的获取入口连接同一个包管理服务；Config 不重复提供语言服务器页签。
- 分类页签共用已配置的 Marketplace 来源；发行配置已提供 `ash`，增加独立来源才需要配置新的 metadata/targets 地址与信任根。
- `marketplace.rs` 和 `lsp.rs` 拥有终端状态与交互，后端继续拥有安装、解析和配置。共享契约见 [Slash Commands](../../docs/slash-commands.md#marketplace-与领域管理入口)。
- 定向验证：`just test ash-tui marketplace`；真实终端流程：`just test-tui actual_tui_marketplace_and_lsp_commands`。

## Memories

- Config 的通用页提供记忆总开关，默认关闭；关闭后保留已有记忆与范围授权，停止模型召回、读取和保存。
- `/memories` 按个人、项目展示记忆。
- `/` 搜索当前范围的全部记忆，Enter 提交；滚轮或键盘浏览到末尾时自动加载下一页，保留搜索条件。点击顶部 `+ New Memory` 或按 n 新增，a 打开操作菜单，s 选择具体范围，p 调整范围授权，c 前往 Config。
- Enter 查看完整正文，e 编辑，Delete 确认删除；Esc 返回原列表。全屏滚轮只滚动指针所在的列表或正文，不改变键盘选择与编辑光标；inline 沿用终端的鼠标选择和滚动行为。
- 标题与正文在同一表单编辑，Tab 切字段，Ctrl+S 保存；保留换行与空格，离开有修改的表单需选择继续编辑或放弃修改。
- 保存失败保留草稿，相同请求重试复用命令身份；版本冲突时 Ctrl+R 查看最新内容，u 明确采用其版本后返回草稿继续修订。
- `/memories memory:…` 或操作菜单中的打开引用读取精确版本；过期或已删除引用明确报错。
