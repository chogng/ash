# Terminal 可选贡献

此目录拥有独立的终端用户能力，消费 [Terminal 界面](../terminal/README.md) 与 [实例服务](../terminal/README.md) 的公开契约，不创建第二份实例集合、PTY 连接或屏幕。

生产入口由 `terminal/terminal.all.ts` 统一装载，每项能力保留自己的 contribution 注册。links 按实例拥有 xterm 链接 provider、路径解析、悬停、打开操作和键盘选择器；屏幕只提供原 buffer 和 widget 承载。voice 注册开始/停止听写动作，`terminalVoice.ts` 拥有录音对应的实例和界面生命周期。语音文字进入原实例输入链，换实例、退出或隐藏面板取消录音，执行仍由用户按 Enter 触发。

文件链接支持相对路径、绝对路径、引号和空格、`file://`、家目录及编译器 / Python / 栈帧行列位置。`terminalLinkParsing.ts` 只产生候选，`TerminalLinkContribution` 使用命令所在行的 cwd、`IPathService` 和原文件服务确认文件，再通过编辑器服务打开；远端资源保留终端所属文件夹的 authority。鼠标 provider 和“打开检测到的链接”共用解析，Ctrl/Cmd+Shift+O 打开可搜索列表，Escape 返回终端，接受文件后由编辑器接收焦点。文本索引通过真实 buffer cells 换算成范围，覆盖宽字符和自动换行。状态、进程或工作区切换会撤回过期结果，关闭释放 provider、OSC 8 handler、悬停和选择器。HTTP(S) 检测和现有网页打开规则继续生效。

Find 按实例持有查询和大小写、整词、正则选项，使用该实例屏幕的 SearchAddon 搜索解析后的内容与回滚缓冲区。结果数通过 live region 读出；Enter / Shift+Enter 和 F3 / Shift+F3 导航，macOS 还支持 Command+G / Command+Shift+G。Escape 清除搜索高亮并恢复终端焦点。隐藏面板或切换实例保留查询；关闭实例释放控件、插件、监听器与上下文。Find 帮助使用已有 `accessibility.verbosity.find` 设置，Alt+F1 打开帮助，关闭后恢复原控件焦点。

history 贡献持久化最近命令并提供选择重跑。终端输出的帮助、Accessible View 和 verbosity 由 accessibility 贡献装载；Find 与语音自身的帮助分别保留各自职责。

新增贡献之前必须确定下层公共能力、状态 owner 和释放边界。命令与配置由各自 `.contribution.ts` 注册；界面消费前端事件和类型，不导入 Rust DTO。命令检测中的屏幕位置归 xterm，Shell 命令完成状态归执行后端，不能让贡献自行从输出文字猜测 exit code 或重新执行命令。

跨层生命周期与各项能力的适用范围见 [Terminal 职责与运行契约](../../../../../docs/terminal.md)。听写样式归 `terminal/browser/media/terminalVoice.css`，听写会话归本目录。

Clipboard 贡献按实例提供复制、复制并清除、粘贴命令；Linux 另提供 selection clipboard 粘贴。焦点选区键只影响终端复制快捷键，无选区 Ctrl+C 仍发送给 Shell。命令与浏览器 paste 共用 `shouldPasteTerminalText` 的多行决策及 `terminal.integrated.enableMultiLinePasteWarning` 设置。宿主剪贴板读取和确认完成后再次检查实例、连接代次、活动项与屏幕可用性；切换回来也不会发送失效结果。命令标记的复制／选区由 DecorationAddon 读取原 command capability 范围；重跑请求通过 xterm 事件到达本实例贡献，在未受信文本确认前后核对输入代次及原命令成员身份。所有发送复用实例 `sendText` 与输入确认，不复制输入队列。关闭实例释放监听和 DOM 上下文。`copyOnSelection` 和 `rightClickBehavior` 沿原输入、选区与焦点 owner 工作；HTML／资源粘贴不转换为文本执行。

多行粘贴确认可选择保留原文或“粘贴为一行”；后者只移除 CR/LF，保留原有空格和 Tab。“不再询问”仅在接受后将原配置写成 `never`，取消不发送也不保存偏好。

Sticky Scroll 仅投影原命令 markers 与屏幕，不保存命令副本。Suggest 合并可信历史、授权目录项与扩展 provider，支持触发字符及提示符内替换范围。Quick Fix 合并内置 Git 修正与扩展 selector 匹配结果；内置修正只插入文本，扩展动作按其声明插入／执行命令、打开 URI 或调用扩展命令。实例、输入、命令范围和工作区变化撤回过期结果。

## 功能与调用链

2026-10-19 对照本地 VS Code `72e9539ed6b` 的公开契约与可观察行为；实现使用 Ash 现有实例、配置和进程 owner，未按上游私有文件拆分复制实现。

| 用户入口                                                | 文件与唯一 owner                                                                                                      | 可观察结果                                                                                                                                         |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Switch Active Terminal / `term `                        | `quickAccess/browser/terminalQuickAccess.ts` → 原 `ITerminalService`、group/editor/editing 服务                       | 搜索已有实例，接受后聚焦其原面板或编辑器；行内按钮重命名与按原关闭策略关闭，已释放实例的旧条目不生效。                                             |
| Send Signal / `{ signal }`                              | `sendSignal/browser/terminal.sendSignal.contribution.ts` → `TerminalProcessManager` → 原 App Server/exec-server/PTY   | 支持 SIGINT、SIGTERM、SIGKILL、SIGHUP，选择器取消、切换及断线不发送。POSIX 目标为当前前台进程组；执行端不支持时明确报错。                          |
| Increase / Decrease / Reset Font Size，Mouse Wheel Zoom | `zoom/browser/terminal.zoom.contribution.ts` → 原 `IConfigurationService`                                             | 所有屏幕读取同一字号设置，范围 6–100；重置为平台注册默认值。滚轮开关默认关闭，启用后使用 Ctrl／macOS Cmd 或捏合，普通滚动与输入 owner 保持原职责。 |
| 调整终端尺寸                                            | `resizeDimensionsOverlay/browser/terminal.resizeDimensionsOverlay.contribution.ts` → 原 xterm resize / widget manager | 启动与重连稳定后显示实际行列数，最后一次 resize 后 500 ms 隐藏；关闭设置或实例释放撤销监听和提示。                                                 |
| 悬停已完成命令及输出                                    | `commandGuide/browser/terminal.commandGuide.contribution.ts` → 原 CommandDetection markers 与 buffer                  | 参考线按原保留范围投影；输入、alternate buffer、trim、设置关闭及实例释放撤回，不执行命令。                                                         |

| Auto Replies | `autoReplies` → 原进程 service → `terminal/setAutoReplies` → exec-server 原 PTY drainer | 创建时原子安装，原始字节跨块匹配、有界规则与每规则一秒冷却；隐藏屏幕不影响，detach／连接关闭／退出撤销。 |
| Local Echo | `typeAhead` → 原 prompt capability、raw key 与 output commit | 仅投影已确认输入态的可打印 ASCII，原输出确认后撤回对应预测；控制、输出不匹配、切换 buffer 或关闭设置清除。Enter 停止预测直到下个 prompt；不更改已解析 buffer 或拦截原输出。默认关闭。 |
| OSC 99 | `notification` → 原 xterm OSC parser → 原 NotificationService → 原实例输入 | 有界 UTF-8／base64 内容，通知更新、关闭、按钮与 query／alive／activation；关闭实例或禁用配置撤销通知及回写。声音、图标和应用过滤不属于通知宿主契约。 |
| Show Environment Contributions | `environmentChanges` → 原 launch collection 快照与 EnvironmentVariableService → 只读模型 | 对比当前进程启动时应用的扩展贡献与未来配置；重新附着不改原 PTY 环境，显式 Relaunch 才重新解析。未知快照明确标注，临时贡献不写入恢复存储。 |
| 扩展建议和 Quick Fix | Node Extension Host API → capability admission／动态注册 → MainThreadTerminalService → 窗口唯一 provider registry → 原 prompt／command | 范围替换、触发字符、精确 selector output window、有限结果与取消；卸载、重连、命令或 prompt 变化丢弃迟到结果。 |
| Developer: Write Data / Record Session | `developer` → 原实例显示入口／TerminalRecorder、状态栏和剪贴板 | 调试数据仅写屏幕；录制输入、输出、命令和 resize，停止后复制有界 JSON。录制包含用户终端数据。 |
| Terminal: Ask Chat | `chat` → 原输出快照 → 原 Chat draft／Session owner | 输入问题后将快照和问题添加到现有草稿，取消或切换实例／会话不交付过期结果，提交仍由 Chat 控制。 |
| 终端听写 | `voice` → 原 DictationInput → 原实例 `sendText(false)` | 保留非英文文本；英文口述符号转换为命令字符，过滤终端控制输入，不添加 Enter。 |
| 终端遥测 | `telemetry` → 原实例生命周期／配置事件 → `ITelemetryService` | 仅上报有界生命周期和类型、位置、布尔配置变化，不上传命令、路径、环境或终端名称；计时器随实例和窗口释放。产品使用 NullTelemetryService 时无采集流量。 |

每项均由自己的 `.contribution.ts` 注册，`terminal.all.ts` 装载；配置通过 `terminalContribExports.ts` 合并到终端的唯一 schema 注册。新 UI 文案和无障碍帮助均含中文资源。定向单测位于各贡献的 `test/`；真实交互集中在 `test/integration/browser/terminal.integration.spec.ts`。

## 宿主职责

Terminal 的交互 PTY 归原 App Server／exec-server；Agent 的执行工具归 Core 工具注册、权限／审批和 `shell-command` 执行 owner。`crates/ext/app-tools` 的 `openTerminal` 通过 Sessions `AppToolsHost` 创建界面终端。Workbench 不重复注册绕过 Core 授权的 run/send/kill/output 工具，也不把交互 PTY 伪装成 Core 的执行任务。终端问题、上下文、草稿、会话与提交共用现有 Chat owner；本产品使用这个组合入口，不另建 terminal-location 会话或 inline Chat 草稿。因此上游 terminal-location agent 的 initial hint 不注册空消费者。

本产品 xterm 使用现有 renderer，没有 WebGL addon atlas，也没有独立的 PtyHost 进程。Developer 的屏幕写入和录制按实际能力提供，不注册无效的 atlas/restart 命令，不用重启整个 App Server 代替 PtyHost restart。WSL 安装推荐依赖可安装的 WSL runtime 与扩展分发目标；当前终端宿主提供本地、SSH 和既有容器目录路由，不宣告 WSL 推荐或 WSL runtime 能力。

## 验证

定向单测使用各贡献 `test/` 与原 Terminal/Profile/ExtensionHost 测试；真实屏幕、键盘、通知按钮及扩展补全场景见 `test/integration/browser/terminal*.integration.spec.ts`。真实 Node Extension Host 的注册、撤销与调用测试位于 `resources/extension-host/node.test.mjs`。Rust 终端真实 PTY 测试覆盖信号、首次输出自动回复、连接隔离和租约撤销，App Server 测试覆盖实际 RPC owner。

2026-10-19 macOS 验证覆盖 28 条 Chromium 场景，以及 Electron 和 Web 各 2 条连接实际打包 App Server／PTY 的 smoke，后者验证自动回复、Quick Access 保持实例与前台 SIGTERM。终端单测、扩展桥接／Node／V8 测试、相关 Rust 包检查及正常产品构建通过。验证结果以执行日志为准。当前机器是 macOS；Windows／Linux PTY 测试目标曾通过交叉编译，完整 Windows exec-server 构建受缺失的 MSVC SDK 阻挡。未执行 Windows／Linux 实机信号场景及上游可运行窗口配对，不将编译或源码核对标为这些场景通过。
