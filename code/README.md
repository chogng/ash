# Ash Code

`code/` 拥有 `ash code` 的终端界面：输入、正文显示、页面布局、功能面板、终端模式与退出恢复。`ash-cli/` 拥有用户命令、连接与启动；共享后端能力由 `ash-rs/` 提供。

| 阅读目的 | 文档 |
| --- | --- |
| fullscreen / inline 的区域、历史、面板、鼠标和模式切换 | [LAYOUT.md](LAYOUT.md) |
| 实现入口、提交与补全、功能接入、配置与主题、测试 | 本文 |
| CLI 用法、远程连接、安装与更新 | [CLI README](../ash-cli/README.md) |
| 跨客户端请求、通知与数据契约 | [App Server API](../docs/ash-app-server-api.md)、[App Server Client](../docs/app-server-client.md) |

```text
ash-cli → code/tui → ash-app-server-client → shared App Server crates
```

从仓库根目录运行 `just ash`；构建使用 `just build-code`。检查与测试见[测试与支持边界](#测试与支持边界)。

## 文件与职责

| 要修改什么 | 从哪里开始 |
| --- | --- |
| 启动、事件循环与请求调度 | [app](tui/src/app)、[dispatch.rs](tui/src/app/dispatch.rs) |
| 输入、历史、附件、补全与排队 | [composer](tui/src/thread/composer)、[共享输入历史](../ash-rs/message-history/README.md) |
| 审批与提问 | [interaction](tui/src/thread/interaction) |
| 正文、流式显示、缓存与执行输出 | [transcript](tui/src/thread/transcript)、[render](tui/src/render) |
| 本轮运行状态行、spinner verbs、耗时和中断提示 | [progress.rs](tui/src/thread/progress.rs)、[聊天布局](tui/src/app/chat_view.rs) |
| fullscreen / inline 的页面、面板、鼠标与终端输出 | [LAYOUT.md](LAYOUT.md) |
| 会话管理与 Issue 工作流 | [sessions](tui/src/sessions)、[issues.rs](tui/src/issues.rs) |
| 设置、主题、快捷键与界面语言 | [config](tui/src/config)、[theme](tui/src/theme)、[keymap](tui/src/keymap)、[nls.rs](tui/src/nls.rs) |
| 扩展、Connector 与目录授权 | 对应功能模块；目录授权见 [dirs.rs](tui/src/dirs.rs) |
| 状态、额度与内存诊断 | [status](tui/src/status)、[usage.rs](tui/src/usage.rs)、[memory.rs](tui/src/memory.rs) |
| 听写 | [state.rs](tui/src/app/state.rs)、[请求调度](tui/src/app/driver/command.rs)；App Server 的 [realtime-voice](../ash-rs/realtime-voice/README.md) 负责识别与模型安装，`ash-voice-host` 负责音频 |
| 终端、ANSI 转换与 Mermaid 排版 | [终端检测](terminal-detection/README.md)、[ansi-escape](ansi-escape/README.md)、[mermaid](mermaid/README.md) |

功能模块维护自己的状态、交互与请求。跨功能命令经 `dispatch.rs` 调用功能接口，App 只做调度；共享 `widgets` 提供通用控件。公开接口与参数以 [lib.rs](tui/src/lib.rs) 为准。

## 启动与事件循环

CLI 将已初始化的 `AppServerSession` 和 `TuiOptions` 交给 `run`：

1. 校验初始化结果中的命令目录，拒绝非法名称、空描述和内置命令冲突；连接事件流只取一次。
2. 读取配置、主题和启动信息。普通 fullscreen 启动进入首页，只加载会话目录；inline 启动创建会话，指定恢复身份则直接打开该会话。
3. 创建或恢复会话时沿用已有 Thread 事件监听，安装快照与历史分页；首页没有活动会话时不建立 Thread 监听。
4. 终端输入、后端事件和后台完成事件分别唤醒主循环；主循环更新状态并按需绘制。
5. 退出时清理客户端工作并恢复终端；连接丢失时返回原因，以及存在时的持久化会话身份。

首页输入通过 Sessions 创建会话并发送首条消息，创建期间锁定完整草稿；创建失败或首条消息被拒绝时恢复文字、图片与长粘贴绑定。打开首页即可输入，点击首页空白处也保持输入框聚焦。欢迎菜单可用 Tab、方向键和 Enter 操作；选中菜单时直接输入文字或粘贴会返回输入框并保留内容，Esc 也可返回输入框。`/home` 或顶部 Home 返回首页，Esc 返回已有对话；返回首页不停止正在运行的任务。

首页“新建工作树”打开项目工作树选择器，可创建 detached 工作树，或选择已有工作树打开。选中其他工作树后按 `d` 可确认删除：无会话归属的关联工作树必须干净，属于 Ash 会话的工作树则会在确认后连同该会话及其所有受管工作目录一起删除，包括未提交的改动。创建后停留在列表并选中新目录；打开前会重新验证目录可用性。打开工作树不会新建会话，随后从该目录提交任务才开始新会话。直接在首页输入任务仍走默认 detached 受管工作树。顶部“项目分支”面板可切换未被占用的本地分支，用 `b` 在 HEAD 新建分支，或选中非当前分支后按 `d` 确认删除；未合并或仍被检出的分支不会被删除。

命令入队时记录来源模式和编辑器身份，后台请求沿用这个来源。预览、详情和 Issues 结果只回到发起它的模式，即使两个模式的请求代次相同也不会互相覆盖。配置、模型和主题的保存结果仍更新共享模型。

输入、请求完成和后端控制事件不能相互长期阻塞。同一资源的写请求保序，不同资源可以并发；中断、批准和回答使用独立控制请求。具体功能解释自己的响应，事件循环只负责转交和调度。

`with_remote_dir` 只设置远程展示目录并关闭本地文件补全；导出仍受本机目录约束。`with_profile_root` 指定本机主题和听写设置的 profile，其余设置从后端读取。终端启动失败保留原始 I/O 错误，附加终端检测结果，并恢复已获取的终端状态。

## 输入如何提交

`ChatInput` 管理文字与原子元素，`ChatComposer` 根据任务状态产生 Submit、Queue 或 Steer。补全打开时，Enter/Tab 先处理候选，不能同时发送消息。

| 后端任务状态 | 发送行为 |
| --- | --- |
| 空闲 | Enter 提交新的 Turn |
| 已创建、尚未运行 | Enter 保存到本地 Queue |
| 运行中 | Enter 排队；Ctrl+Enter 单次补充当前任务 |
| 等待批准或回答 | 对应面板处理输入；仍可明确中断 |
| 取消中 | 抑制重复中断 |

任务模式通过 `/mode` 或输入框中的 Shift+Tab 选择。按键、颜色和两种屏幕模式的显示见 [LAYOUT.md](LAYOUT.md#任务模式选择与显示)；五种任务模式、队列与 Multitask 的共享行为见 [模式 crate](../ash-rs/collaboration-mode-templates/README.md)。

`/permission` 选择下一轮的权限策略，也支持 `manual`、`auto`、`bypassPermissions` 参数。权限策略不再占用 Shift+Tab；已有用户自定义的权限快捷键仍可使用。

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

`/model` 无参数时列出内置目录模型；本机 Kimi Desktop 或 Kimi Code CLI 连接就绪时，还会向对应端点查询当前型号。有离散推理档位的模型显示方块并可用左右键调整；深色格表示当前已启用的强度，浅色格表示剩余档位，未修改时采用模型的默认强度。右侧为支持的模型提供 `Fast on/off` 和 `272k / 1m` 两个入口，可点击，也可用 `Tab` / `Shift+Tab` 在当前行的 effort、Fast、上下文之间循环聚焦，左右键调整当前项。只显示可用设置，跳过不可设置的项；上下换模型后从 effort 开始，没有 effort 时从第一个可设置项开始，整行没有设置时 Tab 保持原位。模型选择器不提供 `none` effort 档位；原配置为 `none` 时从第一个有效档位开始。这两项即时保存到当前连接的模型配置，面板保持打开，不改变当前选中的模型和未确认的推理档位；Enter 应用模型与推理档位，Esc 关闭面板。effort、Fast、上下文各占固定列；不支持某项的行留空，后面的设置保持对齐。窄终端优先显示当前聚焦的设置。Fast 按模型和连接能力启用：OpenAI 使用服务档，Claude 按型号使用加速推理或 Priority，Gemini / Grok API 使用优先处理，MiniMax 和 Kimi Code 使用对应的 highspeed 型号；未声明支持的模型或连接不开放开关。上下文档位适用于所有声明至少 1m 容量的模型，用于后端预算与自动压缩，不改变模型声明的最大容量。GPT 模型默认使用 272k 预算，显式保存的上下文设置优先。按 `/` 聚焦搜索框，搜索中的 `/` 作为字符输入；Esc 先退出搜索，再关闭面板。固定模型排在列表顶部；已固定和未固定两组内部都保持模型目录原序，不按固定时间排序。取消固定后回到未固定组中的原有位置，键盘焦点仍留在同一个模型上。底部提示按当前选中模型的状态显示 `p 固定` 或 `p 取消固定`，只显示当前可执行的动作。没有候选时提示在 `/config` 配置提供商。模型出现在目录中不保证凭据或远端权限有效，实际调用仍由运行时校验。各型号可选档位见[内置模型表](../docs/models/ash-host-models.md#推理档位)。

`/effort` 选择当前明确选中模型支持的推理强度，也接受档位参数。fullscreen 无参数时在底部打开横向档位选择器，正文保留在上方；左右键暂选，Enter 应用，Esc 取消并保留原草稿。当前已生效的档位单独标注；指向 `max` 时使用主题颜色播放彩虹变化，移开或关闭后停止。Tab 暂选 Multitask，随 Enter 一起应用，只改变下一条消息的任务模式；这复用已有多 Agent 协作，不是新的模型档位或 Fast 开关。inline 无参数时继续使用选项列表；切换屏幕模式时，已打开的编辑器和未确认选择一同转交。Shift+↓ 降低一档，Shift+↑ 提高一档，只经过该模型支持的档位；到达最低或最高档时停住，不绕回另一端。两种模式都只在状态栏显示当前档位，不显示边界提示，也不重复写入配置。默认快捷键不使用 Alt 加标点，避免输入法把组合键转换成字符。未设置强度时从模型默认档开始调整；模型也没有默认档时，首次调整选择第一档。调整保留模型和其他配置；Ctrl+R 继续搜索输入历史。两个方向可通过 `/shortcuts` 分别重绑，`/help` 列出全部按键。未明确选择模型或模型不支持推理强度时显示说明。列表与弹层保留自己的按键处理。

推理档位按当前 `provider + model` 对应的目录项读取可选值、顺序和默认值。选择、升降与边界判断及配置更新由 [reasoning_effort.rs](tui/src/models/reasoning_effort.rs) 统一处理，快捷键与 `/effort` 共用这条路径。按键重绑由 `keymap` 管理，输入优先级由 App 管理。

文件补全只识别空白分隔的 `@token`，不处理邮箱中的 `@`，最多展示 50 项。请求校验查询文本和版本，关闭补全释放句柄；扫描、忽略与排序规则见 [file-search](../ash-rs/file-search/README.md)。

TUI 不扫描 Skill 正文；完整 `SKILL.md` 由后端在接受任务后按需加载。`skills/changed` 刷新目录与候选；Plugin 安装或变更也刷新相关 Skill 与打开的 Connector 面板。

## 面板怎样接入后端

下面只列会影响请求实现的导航、搜索和返回差异。

| 功能 | 接入要求 |
| --- | --- |
| 会话管理 | `/agents` 与 `/sessions` 打开同一管理器；`/subagents` 进入当前会话的 Thread 切换区 |
| 回退 | `/rewind` 或空输入下 500 ms 内连续 Esc 创建子 Thread，继承目标之前已结束的任务，原 Thread 不变 |
| 归档 | 归档当前会话成功后才创建新会话；归档列表的恢复不重跑已结束任务 |
| Skills | 目录只展示元数据；统一扩展面板 Skills 页中的技能项使用带来源的 Skill 身份与配置版本修改启用状态，随后重读 |
| Connectors | 支持设备码授权和断开；API key 与浏览器回调 OAuth 连接仍通过 Desktop 设置完成 |
| 目录 | 添加目录和授予访问权限分别处理；使用 Session RPC 与权限版本，不写入 profile 设置 |
| 设置和模型 | 带预期配置版本保存；各功能只接收自己需要的字段 |
| 批准和提问 | 只有后端选中且订阅该 Thread 的连接可以回答；禁止重复提交，超时由后端处理 |

Connector 操作见 [request.rs](tui/src/connectors/request.rs)：设备码复制到剪贴板后打开验证网址，按服务端间隔轮询；失败时取消授权流程。目录版本和连接代次用于拒绝过期操作。

配置保存替换完整 `[tui]` 表，因此必须保留其他 TUI 设置。API key 只通过专用凭据接口保存，不进入普通配置或展示状态。快捷键候选先完成全量校验，保存失败时保留上一份有效规则。

`/config` 中的 Git 自动获取模式与间隔写入共享的 `[git]` 表。App Server 对有仓库修改授权的目录执行定时 fetch；Desktop、Rust GUI 和 TUI 读取同一份配置。

“配置 → 网络”提供“运行网络诊断”和“所需域名”。域名来自当前已配置的模型连接、已登录订阅及后端产品服务；显示各请求实际选择的直连或代理地址，可复制去重后的服务域名。诊断通过同一 HTTP 客户端检查连通性，并单独查询已就绪账号的额度。收到 HTTP 401、404 等状态仍表示服务可达，不代表账号授权有效；页面分别显示 DNS、代理连接、TLS、超时和账号问题。诊断不生成模型内容、不测试流式响应、不写入配置。按 `r` 重试，Esc 返回设置；关闭子页后迟到的结果不会重新打开它。代理及证书沿用启动时的共享网络配置，不新增 TUI 网络开关。

“配置 → 提供商”按订阅和 API 分组，打开连接设置；账户页用于查看账户、登录和取消登录，已连接时按 `l` 退出，Esc 返回列表，未完成的登录可再次进入查看。首次进入读取账户与模型，后端变化通知刷新页面。提供商身份、端点、凭据优先级与认证存储由[账户接入](../docs/login.md)和[认证存储与验收](../ash-rs/docs/changes/chatgpt-auth/verification.md)维护。

资源采样由可见状态行项目和 Processes 页共同决定；没有需求时停止采样。关闭 Git 显示只停止状态行专属工作，不能停止 ChangeTurn 的目录跟随。

## Issue 工作流接入

`issues::Manager` 管理页面、搜索和请求代次，`board` 合并 GitHub 页面与后端工作记录并维护分组、折叠和稳定选择；`assignment` 承载分配预览、仓库设置和工作详情。Sessions 与 Issues 共用 `widgets::grouped_list` 的可见范围与排版。

列表刷新、工作概览与停止控制使用独立请求通道。关闭页面停止界面轮询，后端工作继续；迟到结果不能重开页面。缓存、领取、执行阶段、工作区、验收及 GitHub 同步由后端拥有，协议见 [Issue API](../docs/ash-app-server-api.md#issue-浏览与-agent-session)。

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

初始快照从最近 50 个 Turn 开始，订阅随后自动读完历史分页。两种模式都从同一正文模型绘制历史与当前回复。历史输出、活动视口和正文浏览的区别见 [LAYOUT.md](LAYOUT.md#inline)。滚动位置用单元身份和行偏移保存，不能依赖屏幕行号。

## 产品支持边界

Agent 回复与计划支持 Markdown 标题、列表、引用、强调、代码块、表格和链接；窄屏表格按字段逐项展示。HTTP(S) 链接通过 OSC 8 交给终端打开，本地路径保留可复制目标。用户输入和命令保持字面显示，HTML 标签作为文字显示。鼠标与选文行为见 [LAYOUT.md](LAYOUT.md#鼠标与横向对齐)；Vim 只改变输入框编辑。

`/export [relative-path]` 导出当前已加载正文，路径限制在本机工作目录内，不能覆盖已有文件。Ctrl+O 复制最后一条 Agent 回复。

Agent 回复和计划中的完整 Mermaid 围栏会附带“Open Mermaid in browser”链接。预览文件保存在本机 profile 的 `ash-code/mermaid-previews/`，会话重开后仍可打开。链接只指向 Ash 生成的页面；普通消息中的本地文件链接仍仅显示为可复制文字。预览页从固定版本的 CDN 加载 Mermaid，因此浏览器需要联网才能绘制完整图。

断线后，TUI 丢弃旧连接的待执行请求和操作；存在活动会话时返回其持久化身份，首页尚无会话时返回 `None`，重连后重新进入首页。本地和远程 CLI 在 30 秒窗口内重连；失败时分别给出 `ash resume SESSION_ID THREAD_ID` 或 `ash remote connect ... --resume SESSION_ID THREAD_ID`。正常服务端关闭和协议错误不进入传输重试。

## TUI 主题文件

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
dictationShortcutEnabled = false
dictationShortcut = "ctrl+g"
```

`screenMode` 的配置、即时切换和终端行为见 [LAYOUT.md](LAYOUT.md#屏幕模式配置)。除听写快捷键外，TUI 设置沿用 App Server 的 Config 读写通路。

`dictationShortcutEnabled` 缺省为 `false`。开启后，在 TUI 任意页面按 `dictationShortcut` 开始或停止听写，结果写入当前草稿；输入框聚焦时按 Enter 会结束听写，等最终文字返回后发送。`/voice` 不受开关影响。默认键为 `ctrl+g`，可在 Config 修改为一个带修饰键的组合键。两个值读写运行 TUI 的本机 profile，连接远端 App Server 不改变它们。macOS 的媒体键不作为默认听写键。

终端的 `/voice` 用于听写，将识别文字写入当前草稿，供用户审阅、编辑和发送；发送后沿用当前编码任务的模型、工具和权限。终端不提供独立语音对话或按停顿自动发送的入口。听写启动、下载模型和录音期间，中断键（默认 `Ctrl+C`）先停止听写并保留草稿，不触发发送、不退出 TUI。停止完成后，中断键恢复聊天任务中断或退出的原有行为。下载期间输入 `/quit`，会先停止听写再退出。下载失败与停止同时发生时仍显示错误，不发送草稿。

听写的模型检查、下载、加载和“正在听写”在 fullscreen 与 inline 中都显示于输入框上方的 tipline，停止听写快捷键与阶段文案放在同一行。本轮运行状态行固定在 tipline 上方，正文流式输出与历史滚动时保持可见，结束后收起。`Starting...`、`Working...`、`Cancelling...` 及其翻译以 `...` 表示进行中；等待批准或输入时使用静止标记。耗时显示为 `12s`、`1m 03s` 等紧凑格式，包含等待时间。位置、生命周期和同时运行时的行为见 [LAYOUT.md](LAYOUT.md#聊天进度与听写状态)。

普通聊天输入框下方，两种模式都只占两行。fullscreen 第一行是权限与统计等 statusline，第二行是独立 hintline。inline 第一行显示模型等状态信息，第二行平时显示权限；面板、提问、审批等需要操作提示时，由 hintline 替换第二行的整行内容，返回普通输入后恢复权限，关闭权限显示时则恢复为空行。inline 的权限与 hintline 互斥，不增加第三行；这只改变显示，不修改权限策略。具体触发状态与恢复顺序见 [Inline 第二行的覆盖与恢复](LAYOUT.md#inline-第二行的覆盖与恢复)。

取消或下载失败会清理安装临时目录并释放模型锁；进程被强杀留下的临时目录在下次安装前清理，不会断点续传。已经结束的下载不会因网络恢复自动重启。模型被另一个进程安装时显示占用错误，保留对方的安装临时文件。

`keyHintStyle` 只接受 `contrast` 和 `muted`，缺省为 `contrast`。`contrast` 使用当前主题的前景色与粗体显示按键，说明文字使用弱化色；`muted` 保留整条弱化斜体效果。该设置由 Config 的“通用”页写入，fullscreen、inline 和两者的功能面板共用同一渲染通路并即时应用。

`glyphSet` 只接受 `powerline` 和 `plain`，缺省为 `powerline`。`powerline` 用 U+E0A0 显示 Git 分支标识，需要终端选用包含 Powerline 字形的字体；`plain` 显示文字 `git`，不依赖特殊字体。Config 的“通用”页可以切换该设置，保存和外部配置重载后立即更新顶部栏与丰富样式状态栏。终端名称不能可靠说明用户选用的字体，因此不会据此自动切换。

`autoUpdate` 在“通用”页签中以单行选项切换：`latest` 跟随每次发布，`stable` 只跟随显式晋升的版本，`never` 不自动检查；缺省为 `latest`。CLI 在本地 TUI 启动时和运行期间读取这个 profile 设置，源码构建和其他安装方式不会被改写。下载、签名校验、诊断和版本切换契约见 [CLI README](../ash-cli/README.md#remote-connections-and-updates)。

`language` 只接受 `en`、`ja`、`zh-CN`、`fr`，缺省为 `en`。当前实现会立即切换 Config 根页面；供应商名、语言服务器标识、模型回复、代码和用户内容保持原文。TUI 在启动、读取 Config 和重载时校验完整 `[tui]` 表，未知配置键或无效值会报告错误；无效重载保留上一份有效设置、当前草稿和正在运行的任务状态。各字段仍由终端设置、状态栏、快捷键、模型、主题和听写功能分别解释，后端不解释 TUI 字段。单字段序列化保留其他同级字段，Config 保存前须通过完整候选校验。

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

颜色名由 [document.rs](tui/src/theme/resource/document.rs) 的 `apply_color()` 维护；未写字段继承所选 `appearance` 的内置调色板。不接受图形界面 token、别名、透明色或颜色变换。

推理档位条的已填充格使用 `segmentedActive`，未填充格使用 `segmentedInactive`；列表获得焦点时，选中项的已填充格、文字和箭头使用 `focus`。

## 修改 Welcome 宠物

只编辑 [pet.sprite](tui/assets/welcome/pet.sprite) 中的终端格、帧和动作；[build.rs](tui/build.rs) 在构建时校验并嵌入数据。

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
just test ash-tui --features in-process-tests
just test-tui
```

日常 `just test ash-tui` 运行不需要嵌入 App Server 的测试。`in-process-tests` 包含保留在功能所属模块中的服务器联动测试；CI 运行这组测试，修改请求、状态更新或流式响应联动时也要在本地运行。功能模块的测试检查状态、请求和完成结果；App 测试检查跨功能路由、优先级和退出；真实 PTY 场景检查完整 CLI/TUI 操作。`just test-tui` 先构建配套 daemon，Windows 与 Unix 使用同一宿主；可追加场景过滤器。上述命令是执行入口，不是本次通过记录。

真实场景由 [tui_real_scenarios.rs](../ash-cli/tests/tui_real_scenarios.rs) 加载，可按函数名或模块过滤，例如 `just test-tui config::`：

| 模块 | 场景归属 |
| --- | --- |
| [terminal.rs](../ash-cli/tests/tui/terminal.rs) | PTY、终端历史、滚动、尺寸、输入区域及进程退出恢复 |
| [conversation.rs](../ash-cli/tests/tui/conversation.rs) | 对话、队列、审批、会话及对话中的 Git 状态 |
| [config.rs](../ash-cli/tests/tui/config.rs) | 设置、供应商、账户、语言与配置面板导航 |
| [issues.rs](../ash-cli/tests/tui/issues.rs) | Issue 选择、会话创建与 PR；目前仅 Unix 场景 |

`just test-tui actual_tui_dictation_download` 用本地代理验证听写模型准备时的中断、断网重试、退出和跨进程模型锁；`/voice` 的取消、断网和重试在 fullscreen、inline 分别验证。这组场景目前仅 Unix，不下载完整模型，也不使用真实麦克风。

`just test-tui actual_tui_removed_dictate_command` 验证两种模式下，首次启动和已有会话中输入 `/dictate` 都只显示未知命令提示，不启动模型下载、麦克风或编码请求；随后仍能正常提交编码任务。

状态、请求和副作用断言与终端文本 snapshot 分别验证行为和显示；执行与基线审阅见 [test-tui](../.agents/skills/test-tui/SKILL.md)。两种模式的定向场景与终端兼容范围见 [LAYOUT.md](LAYOUT.md#验证入口与支持范围)。

## Marketplace 与语言服务器

- `/skills`、`/marketplace [query]`、`/mcp`、`/hooks`、`/plugins` 打开同一个扩展面板的对应页签。Skills、MCP、Plugins 的停用项在标题后显示红色 `[disable]`，用 Enter 切换启停；Hooks 按事件显示配置数量，在详情显示声明的启用状态。
- Marketplace 按包身份中的来源分组，Enter 或左右键展开收起来源；来源下用技能、插件、MCP、连接器、可执行程序、编程语言、主题、语言包和资源作为分类行标题。安装前审阅整个包的版本、能力和权限。
- Plugins 展示已安装插件的启停状态，按准确版本、摘要和配置版本提交 Enable / Disable；包的更新与卸载仍由 Marketplace 提供，使用中的包等待消费方释放后删除。
- `/lsp [language-id]` 查看当前目录可用服务器，修改启用状态、程序路径或恢复配置默认值。
- `/skills` 管理已发现的技能，`/marketplace` 搜索可安装包；`/mcp`、`/connectors`、`/lsp` 的获取入口共用包管理服务，Config 不重复提供语言服务器页签。
- Marketplace 展示返回包的来源；发行配置已提供 `ash`，增加独立来源才需要配置新的 metadata/targets 地址与信任根。
- `marketplace.rs`、`lsp.rs` 和 `guardian.rs` 拥有终端状态与交互，后端继续拥有业务和存储。
  `/guardian setup` 扫描当前项目、逐项审核并保存背景资料；`/permission` 选择权限模式，`/init`
  生成的 `ASH.md` 同时作为 Guardian 的项目说明。面板可选择读取此目录的项目会话，
  默认 50 个会话、每会话 200 条命令、不限定天数；可以调整范围，查看聚合事实的频次、来源样本与扫描覆盖量；历史资料不会授予权限。共享契约见 [Slash Commands](../docs/slash-commands.md#marketplace-与领域管理入口)。
- 定向验证：`just test ash-tui marketplace`；真实终端流程：`just test-tui actual_tui_marketplace_and_lsp_commands`。

## Hooks

`/hooks` 按 33 种事件浏览用户和会话获准发现的项目 Hook，查看来源文件、工具匹配与完整程序参数。
配置入口打开 TOML 或把配置需求填入草稿，浏览页不直接修改声明；`r` 刷新、`/` 搜索、`Esc` 逐级返回。
配置方法、事件目录和执行约定统一见 [Hooks crate](../ash-rs/hooks/README.md)。

## Memories

- Config 的通用页提供记忆总开关，默认关闭；关闭后保留已有记忆与范围授权，停止模型召回、读取和保存。
- `/memories` 按个人、项目展示记忆。
- `/` 搜索当前范围的全部记忆，Enter 提交；滚轮或键盘浏览到末尾时自动加载下一页，保留搜索条件。点击顶部 `+ New Memory` 或按 n 新增，a 打开操作菜单，s 选择具体范围，p 调整范围授权，c 前往 Config。
- Enter 查看完整正文，e 编辑，Delete 确认删除；Esc 返回原列表。全屏滚轮只滚动指针所在的列表或正文，不改变键盘选择与编辑光标；inline 的鼠标选择交给终端，正文用键盘浏览。
- 标题与正文在同一表单编辑，Tab 切字段，Ctrl+S 保存；保留换行与空格，离开有修改的表单需选择继续编辑或放弃修改。
- 保存失败保留草稿，相同请求重试复用命令身份；版本冲突时 Ctrl+R 查看最新内容，u 明确采用其版本后返回草稿继续修订。
- `/memories memory:…` 或操作菜单中的打开引用读取精确版本；过期或已删除引用明确报错。
