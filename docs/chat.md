# Chat：输入、响应、工具与语音

Chat／Cowork 共用输入、响应组件和窗口服务。Session、Thread、Turn、工具执行与持久消息由 Rust 拥有；前端持订阅快照，组件只持有展开、焦点和生命周期。本文收束原 Chat 对齐记录中的行为与所有权；未闭合能力见 [Chat / Speech TODO](../TODO.md#chat--speech--todo)。

VS Code 只读对照为 `../vscode/src/vs/workbench/contrib/chat`，首次参照 `f2d375b9623eb7245db28d3a7dab1c9fb3dddb0f`，后续参照 `3fd165bbb0d1dcafd9e3df36c3aa26474c6ecb85`。文件／公开成员差异用于定位真实消费者，不作为实现队列或兼容完成率。历史清单在 `.build/chat-alignment/inventory.json` 与 `report.html`，可恢复快照在 `.build/chat-alignment/chat-speech-validated-slices-20261013`；whole-file 快照可能包含当时共享工作区修改，不能盲目恢复。

## 输入与附件

`ChatInputPart` 使用 Stanza 输入编辑器，textarea 为后备。输入字体、代码块字体与自动接受延迟的键归 `common/constants.ts`；`chat.shared.contribution.ts` 注册窗口服务和设置。命令／Skill 补全在 `browser/widget/input/editor/chatInputCompletions.ts`，装配和测试显式加载注册入口，不依赖产品类导入副作用。

Stanza 与 textarea 默认文本高度 40px，含工具栏默认总高 84px，最大文本高度 314px，文本增长向上扩展。textarea 根据内容与容器宽度布局，ResizeObserver／调度器随输入释放。附件与草稿归 `ChatAttachmentModel`／`ChatDynamicVariableModel`；输入框不展示当前编辑器文件推荐栏，切换文件或 SCM diff 不自动附加文件。添加上下文、粘贴、拖放和代码选区仍生成消息内引用。

引用快照与偏移归 `ChatDynamicVariableModel`；`ChatInputEditor` 拥有引用装饰和内联控件，沿 `editor/chatInputReferenceDecorations.ts` 注册可释放的共享样式。输出选区使用通道的可读名称：单根工作区省略重复的目录名，多根工作区保留目录名以区分同名语言服务器；原始 URI、行范围和选中时的内容仍完整保留。点击文件／代码引用或在引用处按 Alt+Enter，通过 `IEditorService` 在独立的只读标签中打开同一 resolver 保存的完整正文；快照资源身份按 resolver 区分，避免覆盖实时来源或另一份同名选区，重复打开复用原标签。移除引用、换草稿或释放输入会阻止迟到的打开请求。引用 hover 通过同一快照 resolver 预览附加的文件或选区正文，最多 12 行、4000 字符，缩短时明确提示；输出不展示内部通道 URI，文件保留来源路径。通用 Editor 的 `markdownHoverParticipant.ts` 读取装饰的 `hoverMessage`，通过原 Markdown renderer 显示正文并接收延迟快照更新。鼠标悬停或在引用处使用 Show or focus hover（Ctrl／Command+K，Ctrl／Command+I）均可查看，Escape 返回输入；移除引用或释放输入会清理对应展示，迟到结果不恢复旧引用。

正文中的引用位置用于表达材料顺序及其与前后说明的关系，设计缘由见[为什么 Ash 把上下文放进正文](blog/inline-context-references.md)。`resolveChatContextAttachment` 将正文引用偏移与保存的快照一起传给发送模型；Code 和 Cowork 保留未经裁剪的原始正文，`ChatService` 在普通发送、排队和 steering 中按引用位置拆分文字，将标签替换成相应的上下文或图片输入。同名引用保留各自快照，附件读取完成的先后不影响顺序。没有位置的旧草稿附件和来源上下文保持前置；空白片段不单独生成后端不接受的空文本输入，有效文字片段保留原有空白。越界或重叠的引用在提交前报错并保留草稿。Rust 的输入规范化、持久化与模型消息组装沿用输入顺序。

Profile 输入历史沿 `platform/messageHistory` 领域服务 → App Server → `SqliteMessageHistory`，普通 Workbench 与 Sessions 共用。仅主动提交文本追加历史；上下键导航、Ctrl+R 搜索／分页和确认只回填，Escape 恢复文本、光标、附件及 Skill 版本。远端 Thread 不改变本机 Profile 归属；取消、过期回包和连接替换不能改写新草稿，失败写入不自动重试。详见[输入历史](chat-input-history.md)。

已接受请求的“编辑消息”沿 `ChatListWidget` → `workbench.action.chat.resendRequest` → `IChatService.rewriteRequest` → `RewriteThread`，从原请求前创建新聊天并提交修改后的文本，保留原上下文、图片和音频。Enter 换行，Ctrl／Command+Enter 发送，Escape 取消；失败保留编辑内容，同一内容重试复用命令身份。原聊天与未发送草稿仍可恢复，后续 steering 和工具输出不会重放。

IDE 与 Agent Window 均提供 Fork Conversation 和 New Chat in Session。Fork 通过 `IAgentThreadService.fork` 复制当前历史，IDE 创建新 Session，Agent Window 在当前 Session 新建 Thread；新增聊天通过 `CreateThread` 创建同 Session 的空 Thread。后端拥有复制与执行，窗口导航修订阻止迟到结果抢回选择。IDE 与 Agent Window 的输入按 Thread 复用原持久草稿存储，保留文本、模式和用户选择的附件快照；实时来源上下文仍归其生产者。

普通 Workbench 的“Move Chat to Editor Area”与“Move Chat to Side Bar”借用同一个 Chat 画布、会话模型和输入框。Chat 可与文档分组并排；切换布局、隐藏、关闭标签和重启均不会提交消息，重启恢复当前聊天及草稿。画布只能存在于一个编辑器组，分屏或复制到新窗口不会生成第二份 Chat 状态。关闭窗口等待附件准备与存储写入，失败保留草稿并允许重试；输入的 Alt+F1 帮助说明这些操作。

### 截图

截图沿 `browser/actions/chatContext.ts` → `IHostService.getScreenshot(rect?)` → 平台 Host → Electron Main 捕获，`browser/attachments/chatScreenshotContext.ts` 负责转换、框选、预览和确认。Host 返回 PNG `VSBuffer`；平台契约在 `platform/native/common/native.ts`，IPC 校验／字节适配和 Main 捕获各归原 owner。Renderer CSS 像素经窗口缩放转换为 DIP；Web 由浏览器选择共享画面。

菜单与旧预览退出合成后捕获，在冻结原图上按图片像素裁切。鼠标、坐标输入、方向键移动和 Shift+方向键改尺寸共用同一区域；可恢复整图或重新截图。Escape／取消恢复消息焦点，切换草稿或释放输入取消流程，迟到图像不进入新草稿。无障碍帮助提供尺寸、坐标、真实快捷键与 verbosity 控制。

## 响应与工具

Markdown 沿 `ChatListWidget` → `ChatMarkdownContentPart` → `MarkdownElement`／`ChatMarkdownDecorationsRenderer`／`CodeBlockPart` 渲染。列表保留滚动／阅读锚点，part 拥有净化内容、provider 链接和子编辑器释放；代码块持只读 Stanza 模型、布局与工具栏。字体、换行和语言解析使用原配置与 LanguageService；超过 20 行仍可滚动。

`chatCodeblockActions.ts` 注册复制、插入和新文件动作。插入通过实际活动 pane 的控制器和原 Undo 栈完成，拒绝只读输入；新文件使用 Untitled 服务，复制使用宿主剪贴板并保留焦点。消息移除释放模型、编辑器、ResizeObserver 和调度器。流式 Markdown 只处理变化尾部的实现、回退与测量见[数据链路审计第 15 节](ash-app-server-data-path-audit.md#15-p1流式-markdown-只处理变化尾部2026-10-17)。

工具条目由 Thread snapshot／通知 adapter 转成领域值，按 Turn＋toolCallId 关联到 `ChatToolInvocationPart`，展示参数、来源、执行目标、stdout／stderr 和结果。Rust transcript 拥有执行状态，组件不创建执行器；结果缺失或 Turn 终止不推断成功。终端关联复用 [Terminal](terminal.md) 的领域契约。

持久图片／音频经已有来源授权取得 bytes。独立只读预览沿 `ChatAttachmentsContentPart` → response resource provider 的 exact bytes association → `IEditorService`／MediaPreview。来源更换即撤回旧 action；音频移交前暂停原行播放，不从任意 URL 抓取宿主文件。隐藏 retained Chat／Cowork 停止自身 Voice、暂停自身 HTMLAudioElement，保留草稿／快照／媒体字节，重显不自动播放；其他 Widget 的媒体不受影响。详见[媒体交付](media-delivery.md)。

accepted userContext 的 exact body 默认折叠，作为 literal 只读文本供列表和 Accessible View 读取，不触发文件／网络访问或再次发送模型。条目复用 DOM，保留展开和正文焦点，移除时释放。

### MCP 资源与 App

MCP 嵌入内容保留 annotations／`_meta` sidecar 的原位置，模型文本与 view-only metadata 隔离，并遵守硬预算。资源展开、原始 JSON／CRLF 复制、只读编辑器与外部链接使用现有文件／opener 边界；来源含精确 server／App／Session 身份，Profile 请求不伪造 Thread Session。

MCP App 在隔离 Webview 中完成声明／握手，交付工具输入、结构结果和 `_meta`；本地交互状态不随 Thread 刷新重置。主题、尺寸、CSP 元数据、外部 opener、fullscreen、文件导出和诊断沿原宿主契约。frame-src／base-uri 等策略在真实 iframe 中执行，不能读取 Workbench DOM；未宣告能力返回标准错误。连接退休、来源替换和关闭释放原 App 并处理 teardown ACK。工具调用、读资源及消息/context 通过原 Core 授权路径；sampling、media context 和完整双向 App tools 仍有缺口，不宣告未实现 capability。

## Prompt、Skill 与 Hook

`PromptsService` 统一提供文件解析、目录和 Hook 声明。`PromptFileParser` 保留 exact 原文，`PromptBody` 提供正文及 UTF-16 偏移／范围，CRLF／CR／LF 保留；Instructions 预览显示正文，原文编辑器保留元数据并定位正文开头。YAML AST 支持编辑诊断、目录名／工具值补全、正文引用和字段 Hover；后端 Skill catalog 仍拥有接受、版本和授权判断。

`promptFileAttributes.ts` 对应后端 Skill 的 name／description／license／compatibility／metadata／allowed-tools；根键补全排除已有字段，不把嵌套映射、正文或其他文件当头部。Hover 消费当前 AST 诊断与 schema 说明，Problems 和装饰使用独立 marker owner；不另存诊断。完整上游 Agent／Prompt 格式按真实 Ash 产品调用决定支持范围。详见 [Skills](skills.md) 与 [Agent 定制](agent-customizations.md)。

Hook 事件类型归 `common/promptSyntax/hookTypes.ts`，读取与变更通知归 `IPromptsService`；配置编辑器和 action 共用服务。Ash 保留 TOML、停用及历史事件语义，可传 Session；不宣称完整 ChatRequestHooks 或 JSON／Claude／Copilot 格式兼容。后端值和 adapter 在 agentHost，复用 `hook/list`／`config/changed`；本机 TOML 编辑走可信 `IWorkbenchHostService.editUserConfiguration`，工作区文件走原文件服务。旧 platform/hooks 和重复听写实现已退出，不保留转发别名。

## 设置、进程归因与窗口邀请

`chat.disableAIFeatures` 是 TypeScript UI 的 WINDOW scope boolean 偏好，默认 false，唯一资源是 profile `settings.json`。配置 → `ChatContextKeys.enabled`／model input state → `ChatService` → adapter 共用一条链。禁用阻止 start、queue、steer、Advisor、compaction 和提交说明生成，异步权限读取后再次检查；关闭本窗口活动或待连接 Voice。历史、草稿、停止与已存在 Turn 交互仍归原 owner，重新启用恢复草稿，不改 Rust 权限或停止共享 App Server。底层 Workspace／Folder 支持见 [Configuration](preferences-and-settings.md#configuration-的存储与配置层)，不沿用旧对齐记录中的未迁移状态。

共享后端同时服务 Agent、手动终端和扩展。`aiAgentEnv.ts`／宿主环境构建器过滤继承的 `AI_AGENT`（含大小写变体），不更改父环境；Rust `ProcessExecutor` 只为 Core 工具、Hook 和认证 Agent ProcessStart 的最终子环境设置 `AI_AGENT=ash`。手动终端默认不继承标记，显式 env 可以覆盖。该值仅作进程归因，不代表授权、身份认证、账号或模型，不另加配置或协议字段。

邀请沿成功的 `ChatService.onDidSubmitRequest` → sender 绑定可信 IPC → Main `AgentsWindowInvitationState` → focused conversation 的现有通知列表。只有后端接受的本窗口请求登记使用；Main 的 Application／Machine storage 仅保存首次使用计数与冷却，不读领域 RPC 或建立会话目录。单窗口等待 30 秒，并行活动等待 15 秒，全局只有一个 claim，真正可见后才记曝光。

邀请 action 捕获精确对话坐标，通过原 openAgentsWindow handoff／ack；成功确认后才清捕获草稿，失败保留重试。选择改变、失焦、AI 禁用、连接退休、reload／关闭、等待审批／输入／capability 均撤回提示。再次邀请同时要求五个新对话与一天；三十天内最近三次 Agents 使用抑制提示，缺日期的旧三次记录也保持抑制。流式 delta 不查询活动，durable invalidation 合并刷新。

## Speech、听写与朗读

内置语音有两条产品链：听写将麦克风音频交给 ASR，按配置使用本地、云端或订阅后端，只把转写写入当前输入，不自动发送；语音模式将音频交给实时语音大模型并播放回复，需要执行任务时通过原 Chat 模型交给 Core。标准扩展 Speech provider 是可选的听写／朗读后端，语音模式不依赖该扩展。上游 VoiceClient 的私有 transport 兼容不作为这两条内置产品链的前置条件。

窗口级 `IChatWidgetService` 只登记活着的 Chat／Cowork widget 和最近焦点，不拥有模型或音频状态。Desktop 的 `workbench.action.chat.startVoiceChat` 通过该服务进入原 widget 的语音模式；听写 toggle／hold 命令使用同一目标选择，拒绝隐藏、已释放、准备阻塞、AI 禁用或其他窗口的目标。输入切换、隐藏和释放取消本次准备与录音。hold 在准备前监听松键：不足半秒取消，长按结束后转写，旧松键不能停止替代录音；脱离按键上下文调用 hold 不启动录音。provider 创建完成但尚未报告 Started 时保留输入绑定。

模型无关的听写链路由现有 owner 闭合：配置在本次录音发布前解析并固定为领域选项，服务协调准备、启动、采音、转写、停止与取消，输入 owner 负责写回及会话隔离。PCM16 使用有符号小端编码，停止先 flush 尾包并排空上传，再取最终结果；本地／云端结果是累计快照，扩展结果按已确认片段累积。最终返回的空文字也具有权威性，本地最终事件等待停止回执；本地等待最终结果最多 8 秒，云端最多 35 秒，超时保留已流式返回的文字，无文字则报告错误并取消资源。取消绕过积压的音频或停止请求，新的后端获取等待旧取消回执；浏览器尚未返回的麦克风权限请求独立清理，迟到媒体流和旧会话事件不能影响替代录音。异步切换麦克风以最新选择为准，退休流立即释放。

Ash 保留现有模型、供应商、推理运行时和凭据归属。当前本地默认是 Rust 后端的 Paraformer 模型包，云端选择是 OpenAI／xAI API 或 Codex 订阅，`dictation.model` 只表示本地模型包；本地服务使用受管缓存并拒绝尚不支持的 Foundry runtime、代理及语言参数。模型准备与缓存操作仍走原服务，未加入运行时或模型迁移。真实账户、物理设备与音质的验收范围见 TODO。

| 职责             | 唯一 owner 与范围                                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 听写编排         | `browser/speechToText/chatSpeechToTextService.ts` 处理会话与累计转写，配置解析归 common constants                                                                  |
| 云端转写         | `voiceCodeTranscriptionClient.ts` 处理连接、发送顺序、PTT 音频、停止确认及断线；领域宿主契约在 `platform/renderer/common/dictation.ts`，adapter 只做 RPC／通知转换 |
| 浏览器采音       | `pcmCaptureWorklet.ts` 输出 PCM16 并提供 flush 屏障；Rust 持有凭据与识别，本地模型使用 `ILocalTranscriptionService`，TUI 可继续后端采音                            |
| 标准扩展 Speech  | `vscode.speech.registerSpeechProvider` → Node／V8 Host capability 和精确注册代次 → MainThreadSpeech → SpeechService                                                |
| Widget 实时语音  | `browser/voiceClient/voiceSessionController.ts`、ChatWidget／Cowork 的原输入生命周期                                                                               |
| Ash 语音领域适配 | agentHost `agent.ts` 数据契约、`agentService.ts` 服务契约与 `appServerAgentService.ts` adapter；optional `RendererHost.agentVoice`，不新设 platform/voice          |

标准 provider 唯一拥有 STT／TTS／keyword session。Host bridge 只持有 bounded invoke／read／close、opaque session ID 与取消 token；撤销或关闭释放该精确 registration／incarnation／activationGeneration 的全部会话，迟到创建显式 close，不能把清理送到 replacement。无选择的多 provider 明确拒绝，不按启动顺序抢占。SpeechService 的 availability 只指注册／声明的 Speech provider；原无扩展听写不冒充 TTS／keyword。

`speechLanguageConfigToLanguage` 从 TypeScript `SPEECH_LANGUAGE_CONFIG` 解析语言，同一次 factory 向 Host 递交；auto 使用 display language，未知输入回到 en-US。旧 `dictation.language` 只控制原后端，不双写。onSpeech 激活等待、provider acquisition 和 capture 归原 recording/token；等待时显示 Starting，收到 Started 才显示 Listening，同步取消后不再启动后端。精确 session 事件不写入另一个输入，预取消 keyword 返回 Canceled。

Desktop 只给已完成 Agent 回答提供 Read Aloud。`voiceChatActions.ts` 经 `renderAsPlaintext` → SpeechService／MainThreadSpeech 向原扩展逐段合成，每段遵守 Host 16384 UTF-16 上限且不拆代理对；RPC 接受不代表播放结束，必须等待 Stopped 后才能下一段。Error／取消／注册撤销拒绝等待并释放。来源文字改变、移除、隐藏、行 Escape 或窗口 StopReadAloud 取消本次 CTS，不停止其他窗口或其他 owner 的 TTS；旧 finally 不能清除同窗口新操作。Web 未装配 Desktop command 或 provider 撤销时隐藏按钮。

标准 HasSpeechProvider／SpeechToTextInProgress／TextToSpeechInProgress context keys 由 SpeechService 的事实驱动，不另存录音状态。无障碍提示、语言偏好、焦点、控制可用性均使用同一窗口服务；fixture 也必须在 window 级注册一次配置、ContextKey、ExtensionService 和 SpeechService。

### Ash 实时 Voice 的边界

本地 Voice 接通 Call／LiveKit、麦克风门禁、VoiceAgent 和 VoiceModelSession；Core journal 保存无执行 Turn 的转写，agentHost 转换后用纯文本展示。人类任务提议携带来源 Session／Thread、媒体代次与原 Core command ID，经原 model start／queue／steer 进入 Core／Queue，审批、状态和结果仍由后端拥有。

Profile 拥有媒体、模型及供应商；目录 Thread 通过原 gateway 的 canonical executionTarget 找到同一个 Core，不复制 Thread。开始设备前校验来源、archived 和取消；远端 SSH Core bridge 没有现成端口时明确拒绝，不把远端麦克风当作本机设备。每个 Widget 只有取得自己 resource receipt 后才可 stop／interrupt；pending start 用自己的 AbortSignal，早到任务有界缓冲并按 resource／epoch／source 交付。

启动与清理按原请求身份匹配，旧连接的迟到完成不能清除新连接的启动凭据。打断关闭原房间／模型并建立新媒体代次，从 Core 恢复有界上下文。关闭等待 bounded model close，只排空最终 Usage／Closed，拒绝迟到转写／提议；同一 resource 累计 SDK 权威时长，不推断价格。原来错误归到 common VoiceClient 的 Widget 控制器和 platform/voice 已退出；这些 Ash 自有行为不能当成上游 PTT／audio／session-context transport 已兼容。

## 调试日志导出

IDE 与 Agent Window 均可从命令面板运行“开发人员：导出 Agent Host 调试日志…”（`workbench.action.chat.exportAgentHostDebugLogs`）。共享 action 在 `workbench/contrib/chat/browser/actions/exportAgentHostDebugLogsAction.ts`，通过窗口原有的 `IChatSessionNavigationService` 固定当前 Session／Thread；切换聊天不会改变正在导出的目标，没有活动聊天时只导出宿主日志。该命令生成 `ash-agent-host-debug-logs.zip`，不改变消息、草稿或执行状态。

客户端日志沿宿主的 `ILoggerService.files`，仅选本轮 Main、当前窗口及其轮转文件、本地 App Server；Output 补充已保留的日志通道，排除用户另行打开的历史／其他窗口日志缓存。`host/` 另存 Session 所属本地或 SSH 宿主的进程日志和现存数字轮转文件：`IAgentSessionService.collectDebugLogs` → `session/debugLogs/collect` → 该宿主的 daemon 日志 owner。请求只接受 Session ID；内容通过当前连接所属的有期限资源分块读取、验证摘要并释放，不能提交任意路径，也不从本机推测远端路径。

会话执行记录与诊断分页沿原 `IChatDebugService` → `IAgentThreadService` → App Server 读取。模型正文按当前 Thread 及其持久记录中的子 agent 限定，独立 peer Chat 的正文不混入；Session 级事件仍保留为上下文。已保存的 Core 请求、物化请求、完整响应、失败／取消的部分输出与 Hook 正文放入 `session/payloads/`，manifest 用 capture／payload 身份关联原诊断引用。原 TraceReader 校验所属 Session、已保存引用和摘要；导出不自动开启录制，不补造此前未保存的内容，不宣称正文是 HTTP 原始字节。

ZIP 的 `manifest.json` 格式为 2，记录目标、来源、正文索引、录制状态及读取失败、未录制、截断和分页上限。每个文件最多 16 MiB，最多 1,000 个文件、64 MiB，每类会话证据最多 64 页；正文索引最多 1,000 项，完整原引用仍在诊断分页中。daemon 每次只读取该 profile 的最多 32 个日志文件，共最多 64 MiB，不修改生产日志。超过限额的来源和宿主尾读缺口均有标记，不再因旧的 1 MiB 单文件限制丢弃正文。部分来源失败仍导出已有证据并通知用户。取消等待当前有界读取结束后停止并释放尚未读取的资源，不下载半成品；后端连接或 capture 变化拒绝迟到证据，不向新代次续读。复测入口为 `exportAgentHostDebugLogs.test.ts`、`appServerAgentService.test.ts` 和 `test/smoke/areas/chat/chat-debug-logs.spec.ts`。

## 历史验证与复测入口

2026-10-20 的内置语音入口验证：macOS 定向单测 324 项／9 文件、分层检查 15 项通过。Chromium 内置 ASR 8 项覆盖中英文 Chat／Cowork 的生产听写服务、本地／云端适配器和原输入，验证 PCM 尾包、停止写回、积压取消及迟到结果隔离；后端识别和物理采音使用受控替身。听写命令 4 项、语音模式 10 项及既有 MCP App 回归 40 项也已通过。Renderer 4445 文件类型检查和触及格式检查通过。对应入口为 `pnpm test:unit --run <file>`、`pnpm test:browser:integration chatTranscript.integration.spec.ts --project=chromium --grep <scenario>` 与 `bun check -p tsconfig.renderer.json --all`；不代替真实账户、物理设备或音质验收，也不表示缺失的 MCP capability 已实现。

下表保留更早实现批次的验证范围，不据此声称当前 HEAD 或完整上游 API 通过：

| 功能／批次             | 记录的通过范围与限制                                                                                                                                                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 输入历史               | 前端 21 项、Chromium 5 项、Rust 存储／权限／路由 3 项、真实 Web／Electron App Server 4 项；详见输入历史文档                                                                                                                             |
| 截图                   | 平台／附件／焦点单测 12 项，浏览器上下文 69 项及最终截图 9 项；真实 Electron 与 App Server 截图 smoke、125% 缩放与三步录制通过；初始化 capability v3／v4 后端回归 24 项                                                                 |
| 隐式附件栏移除         | Chromium en／zh-CN × 四主题 16 项，记录在 `.build/desktop/playwright/editor-browser-Gp8EkJ`                                                                                                                                             |
| AI 开关                | 定向单测 187 项、分层／view 18 项、Chromium 20 项；原完整 unit 编译因任务外 decoder 旧协议引用失败，未计为通过；`.build/chat-settings-*`                                                                                                |
| 进程归因               | macOS exec-server 77 unit＋17 integration、Hooks 17 项；正常 TS runner 最终 9 项及分层 13 项；`.build/ai-agent-env-*`，不代替 Windows／Linux runtime                                                                                    |
| 窗口邀请               | 正常 unit 183 项、分层 13 项、Chromium 7 项和真实 macOS Electron 1 项；`.build/agents-window-invitation-*`，含重载／退出冷却持久化                                                                                                      |
| Markdown／Prompt／媒体 | 原 Markdown／代码块批次 19 unit、11 Chromium、2 Electron；后续独立预览／隐藏生命周期 6 Chromium、23 unit；流式优化另见数据链路审计                                                                                                      |
| 最终 Speech／朗读联动  | Chat 269 项／37 文件、Speech／MainThread／Extensions／Settings／Sessions 265 项／7 文件、agentHost 164 项／14 文件；Transcript／Webview 93 项、Speech／Editor／Terminal 22 项 Chromium；Code／Cowork 开发 HMR 2 项；Node 控制通道 27 项 |

最后一批 Renderer 3846 文件、协议 1477 文件类型检查和触及格式检查通过；CSS 0 错误，仍有原 3 项字体 role 建议。过程中 Logger、Terminal cwd 和 preview fixture 的失败最终由原完整入口恢复，不能把中间失败写成未解决功能。实际音频质量／物理设备、真实账户、完整动态 Speech 注册和上游 VoiceClient 仍未验收。

复测使用原 Chat、Speech、MainThreadSpeech、agentHost 单测，`chatTranscript.integration.spec.ts`／Webview／table 场景，截图和 HMR 对应 smoke；选择范围与命令见[单测 skill](../.agents/skills/unit-tests/SKILL.md)、[浏览器集成 skill](../.agents/skills/integration-tests/SKILL.md)和[smoke skill](../.agents/skills/smoke-tests/SKILL.md)。
