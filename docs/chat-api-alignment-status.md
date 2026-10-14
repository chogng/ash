# Chat 文件与 API 对齐状态

只读参照：`../vscode/src/vs/workbench/contrib/chat`；首次参照提交 `f2d375b9623eb7245db28d3a7dab1c9fb3dddb0f`，当前 checkout 已更新至 `3fd165bbb0d1dcafd9e3df36c3aa26474c6ecb85`。范围为生产 `.ts` / `.css`，排除测试、图片与文档。

| 源码文件 | Ash | VS Code | 同路径 | 仅 Ash | 仅 VS Code |
| -------- | --: | ------: | -----: | -----: | ---------: |
| 首次审计 |  95 |     965 |     72 |     23 |        893 |
| 本批前   | 108 |     965 |     90 |     18 |        875 |
| 当前审计 | 123 |     971 |    104 |     19 |        867 |

文件集合差异和公开声明差异是待调查项，不等于对应行为全部缺失。完整路径、imports、exports、公开成员、CSS selector/token、生产与测试调用方已保存在 `.build/chat-alignment/inventory.json`；可读版为 `.build/chat-alignment/report.html`。不将未验证的上游公开成员计为已实现。

## 已确认的 Ash 归属

用户已确认：按职责迁移，保留 Ash 后端领域语义和 Stanza 输入编辑器实现；有上游对应职责的实现回到准确 owner。此确认覆盖首次审计的 23 个仅 Ash 文件及其现有公开契约，不要求把前端领域值改成生成 transport DTO。

模型选择器样式已迁至上游对应路径 `browser/widget/input/modelPicker/media/modelPicker.css`，两个生产 import 同批迁入。用户单独确认删除原 `browser/widget/input/modelPicker/modelPicker.css`；旧路径生产引用为零，新旧样式迁移时逐字节一致，Git 可恢复。

下列路径前缀为 `src/ash/workbench/contrib/chat/`。现有职责可继续使用；将职责迁回其他 owner 时仍需检查真实调用链，文件删除需按准确路径单独确认。

- `browser/advisorSettingsContent.ts`
- `browser/agentSessions/agentSessionsAccessibility.ts`
- `browser/attachments/chatAttachmentWidgets.css`
- `browser/chatEditing/chatEditing.contribution.ts`
- `browser/media/advisorSettingsContent.css`
- `browser/media/modelSettingsContent.css`
- `browser/modelSettingsContent.ts`
- `browser/speechToText/dictationSettingsContent.ts`
- `browser/speechToText/media/dictationSettingsContent.css`
- `browser/widget/chatListItems.ts`
- `browser/widget/input/chatCommandCompletion.ts`
- `browser/widget/input/chatInput.ts`
- `browser/widget/input/chatInputEditor.css`
- `browser/widget/input/chatInputEditor.ts`
- `browser/widget/input/chatInputEditorRegistry.ts`
- `browser/widget/input/chatSkillCompletion.ts`
- `browser/widget/media/chatListWidget.css`
- `browser/widgetHosts/viewPane/chatTabsControl.ts`
- `browser/widgetHosts/viewPane/media/multiChatTabsControl.css`
- `browser/widgetHosts/viewPane/multiChatTabsControl.ts`
- `common/skillSelectors.ts`
- `common/slashCommands.ts`

## 已完成的职责与行为修改

- `common/constants.ts` 拥有输入字体、代码块字体及自动接受延迟的键；`chat.shared.contribution.ts` 仅注册设置，不再导出服务消费契约。
- `chat.contribution.ts` 显式装载设置注册；输入编辑器、消息列表、编辑服务直接消费 common 常量。测试 assembly 显式装载设置，不依赖产品类导入时的注册副作用。
- textarea 后备输入从空 `layout()` 改为根据内容和容器宽度自动调整高度；支持产品传入的最小/最大高度，调度器和 ResizeObserver 随编辑器释放。
- Stanza 与 textarea 的默认文本高度均为 40px，默认工具栏布局总高 84px，最大文本高度 314px。保留用户确认的底部输入布局，输入变长时向上增长。

## Markdown、代码块与 Skill 语法（已接入）

响应链为 `ChatListWidget.renderItem` → `ChatMarkdownContentPart` → `MarkdownElement` / `ChatMarkdownDecorationsRenderer` / `CodeBlockPart`。消息列表保留滚动与阅读锚点，Markdown part 拥有 sanitized 内容、provider 链接装饰和子编辑器的释放；代码块拥有其只读 Stanza 模型、布局与操作工具栏。没有复制上游 renderer、DOM 或 CSS。

`chatCodeblockActions.ts` 注册标准复制、插入与新文件命令，`InsertCodeBlockOperation` 通过现有 `IEditorPart.activePane.getControl()` 找到真实文件/修改侧控制器，沿原模型和 Undo 栈插入，拒绝只读输入。复制使用宿主剪贴板，新文件使用既有 Untitled 服务。代码块继承字体与换行配置，语言别名交由原 LanguageService 解析；异步复制保留按钮焦点，20 行上限以上仍可滚动，移除消息释放编辑器、模型、ResizeObserver 和调度器。

Skill 链为 `ExtensionsEditor` / 文件编辑器 → `PromptsService.parseNew` / `ILanguageFeaturesService` → `PromptFileParser` / `PromptHeaderAutocompletion` / `PromptHoverProvider`。parser 保留完整原文，`PromptBody` 提供精确正文内容、UTF-16 偏移与编辑器范围。Instructions 预览显示正文；只读原文仍包含元数据，并定位正文开头。CRLF、CR、LF 均保留。

`promptFileAttributes.ts` 的说明对应 `crates/skills/src/format.rs` 的既有 name/description/license/compatibility/metadata/allowed-tools 字段；根级键补全去除已有字段，忽略正文、嵌套映射和其他文件，字段 Hover 只在键范围生效。注册统一由 Chat contribution 拥有，使用 Stanza 现有 provider 合同；不引入 VS Code 专属 Agent 字段或竞争的后端验证。

新增的 8 个生产模块/样式均有上游准确同路径和真实 Ash 调用方：Markdown part、CodeBlockPart、chatCodeblockActions、codeBlockOperations、chatMarkdownPart.css、promptHeaderAutocompletion、promptHovers、promptFileAttributes。公开契约仅覆盖本地实际需要的端口，未将上游完整成员清单标记为已实现。

本轮验证：19 项定向 unit、11 项 Chromium integration、2 项 Electron UI 启动/底部布局回归通过；覆盖 en/zh-CN、真实键盘补全与 Hover、复制、Undo、只读拒绝、新文件、字体/换行/选区、dark/light/HC、消息移除、provider 链接、Scope 切换和过期读取。Renderer 检查及产品构建通过；新增 CSS stylelint 为 0 错误，完整 Chat CSS ownership audit 未发现相同或品牌替换式上游 CSS、新品牌或上游 root；格式和 diff check 通过。

## 已确认的职责迁移

- `browser/widget/input/chatCommandCompletion.ts` 与 `chatSkillCompletion.ts`：现有生产调用各 2 个文件。已将两种 Stanza provider 合并到上游对应 `browser/widget/input/editor/chatInputCompletions.ts`，保留 catalog 和选区行为，同批迁移生产与测试 import。
- `browser/chatEditing/chatEditing.contribution.ts`：2 个生产入口。已把服务和 overlay 注册移回 `browser/chat.contribution.ts`；Sessions 已装载该入口，移除其重复 import。

用户已确认删除上述三个准确旧路径，现已完成迁移并删除；Git 可恢复。迁移后旧路径引用为零；11 项 Chat/Cowork 补全单元测试、Renderer 类型检查、格式和 diff check 通过。浏览器验证尚被 `test/integration/browser/diff.integration.ts:340` 的已有 `entry.group` 联合类型错误阻断，未计为通过。新增语音平台归属也已确认，见下方语音设计。

## 实际验证

输入历史追加验证：21 项定向前端单元测试、5 项 Chromium 交互测试（包含 en/zh-CN）、3 项 Rust 存储/权限/远程路由测试均通过。协议测试 126 项、协议生成和类型检查、Renderer 类型检查、依赖检查及两个 Rust 包的 warnings 检查通过。真实 Web/Electron App Server 共 4 项流程覆盖跨输入区共享与草稿独立、回填、不误发送、窗口重开和清空；数据重开持久化另由实际 SQLite 测试覆盖。

- `pnpm exec tsc -p tsconfig.renderer.json --noEmit` 通过。
- 定向 unit selection 实际执行 12 项：字体、范围校验、输入 provider 生命周期、代码块设置、自动接受与 timer 释放均通过；使用正常 `pnpm test:unit` 编译并运行。
- Chromium integration 验证 textarea 两行/三行、314px 上限、清空收缩与焦点；模型/effort 样式与描述、键盘行为分别覆盖 en/zh-CN 和 Chat/Cowork。
- Browser UI smoke 的空会话底部位置和 Stanza 向上增长两项通过。
- 触及的 TypeScript 格式、CSS stylelint 和 `git diff --check` 通过；CSS 原有 design suggestions 没有作为新错误。

## 本机 Profile 输入历史（已接入）

用户已确认新增两个 Ash 平台 owner：`src/ash/platform/messageHistory/common/messageHistory.ts` 拥有异步 append/read/clear 领域契约，`src/ash/platform/messageHistory/browser/appServerMessageHistoryService.ts` 适配生成协议。App Server 的三个方法复用既有 `SqliteMessageHistory`，打开本机 Profile 的 `StateRuntime::database_path()`；Main 没有新增业务逻辑。初始化仅向产品宿主与认证 Browser 宣告该能力，扩展客户端无法访问 Profile 输入。

标准 Chat 导航由上游对应路径 `common/widget/chatWidgetHistoryService.ts` 拥有；清空命令注册在 `browser/actions/chatActions.ts`。`ChatInputPart` 的真实提交、上下键回查、Ctrl+R 搜索和旧记录分页已接通。搜索确认仅回填文本；Escape 恢复文本、光标、附件及原 Skill 版本。继续编辑会结束旧导航，过期请求和释放后的回包不会改写输入。

Workbench 与 Sessions 注入同一平台契约，New Chat / Cowork 使用共享输入实现。持久记录只存用户主动提交的文本；恢复草稿、加载会话及搜索确认不追加记录。远程 gateway 明确将三个输入历史方法保留在本机 Profile，Thread 来源不改变归属。连接关闭的请求由现有协议客户端拒绝，前端展示本地化错误且不自动重试写入。

验证与边界见 [`chat-input-history.md`](chat-input-history.md)。此能力闭合不代表其他上游接口或 content parts 已完整对齐。

## 仍未闭合的能力

### 语音对话（Ash 自有实现，上游契约仍待核对）

VS Code 没有 `src/vs/platform/voice`。原 `src/ash/platform/voice` 是 Ash 自有的 App Server 领域适配层，已按用户确认删除；其职责迁回现有 agentHost 领域契约与 adapter，不能计作上游同路径/API 对齐。上游语音职责位于 `workbench/contrib/chat/common/voiceClient`、`chat/common/voiceChatService.ts` / `voicePlaybackService.ts`、Chat 的 browser/electron-browser 入口和 `workbench/contrib/speech`；原同路径 VoiceClient 的 Widget 控制器也已退出，回到 Chat/browser/voiceClient/voiceSessionController.ts；上游完整 VoiceClient transport 契约仍待兼容后端和真实消费链闭合。以下测试只证明 Ash 实时语音实现的行为，不证明上游 API 已补齐。

本机 Desktop 的原 Voice 按钮已接入实时会话。agentHost 的 optional agentVoice 领域契约和适配连接已有 Call、VoiceAgent 和 VoiceModelSession；Core journal 保存无执行 Turn 的转写，agentHost 负责其领域转换，普通 Chat/Cowork 用纯文本展示。明确的人类任务经原 model.send/start/queue/steer 执行，原 Core/Queue 决定审批、状态与结果。打断关闭原房间和模型后建立新媒体代次，并从原 Core 恢复有界上下文；最终 SDK 时长跨同一 resource 累计，不推断价格。

已有验证覆盖真实本地 Call/LiveKit 与独立 Live wire 供应商模拟、明确注入的 AudioHost IPC 设备替身，以及生成 decoder/client、原 Widget、英文/中文、焦点、草稿和附件。它们不代表真实账户音频质量或物理设备验收。远端 Thread 的自有 Voice/Core bridge不作为本次对齐实施队列继续扩展；尚无兼容 producer 的上游语音成员保持明确缺口。本次媒体会话的供应商/模型/声音选择已接入；不创建空 VoicePlayback service。验证细节见后续记录。

### Prompt 语法与响应内容

已接入的正文、补全、Hover 和代码块操作见上方完成项。Prompt 已具备 Skill schema 对应的 YAML AST、编辑诊断、目录名/工具值补全与正文引用，验证结果见后续准入记录。后端 Skill catalog 继续拥有接受、版本和权限判断；上游 VS Code 专属 Agent/Prompt 格式仍按真实 Ash 产品调用逐项调查。

工具进度与结果、持久图片/音频、流式 Markdown 与 Skill 引用已接入并验证。MCP App 已接入原工具执行、来源资源、消息/context、CSP、链接、真实 fullscreen、文件导出和诊断日志；后续继续调查实际产品需要的 sampling、media context、双向 App tools 及其他引用。终端关联由共享工作区同批的 Terminal domain contract 提供，保持其 owner 并验证 Chat 消费链。现有 `ChatHookContentPart`、provider 链接装饰、Advisor 和编辑审核保持原 owner；本轮只接入真实调用链需要的 Markdown/代码块职责，不把其他缺失 content parts 计为完成。

### 其他目录中的已有职责

会话 UI 在 `src/ash/sessions/browser/chatViewPane.ts`，自动化 UI/契约在 `contrib/automation` 与 `platform/automation`，执行与持久领域状态由 Rust 共享后端拥有。尚未把这些能力当作 contrib/chat 文件缺失而新建竞争 owner。

## 工具调用与 agentHost 联动批准入（2026-10-12）

用户读取工具执行 → 现有 ChatWidgetModel / ChatService → agentHost 的 Thread snapshot 与 transcript notification adapter → chatTranscriptListItems 按 Turn + toolCallId 关联 → ChatListWidget / ChatToolInvocationPart → 可展开的调用参数、来源、执行目标、stdout/stderr 与最终结果。Rust Thread transcript 仍拥有执行状态；现有 ChatWidgetModel 只保存订阅快照，组件只保存展开/焦点，不创建执行器或第二套工具状态。结果丢失或 Turn 终止时不推断成功。

准确范围：Chat 双方已有的 browser/widget/chatListWidget.ts 只增加工具内容组件接入、更新和视图状态；已确认 Ash 的 browser/widget/chatListItems.ts 只关联工具条目并保留文本可访问内容；双方有同路径的 browser/widget/chatContentParts/toolInvocationParts/chatToolInvocationPart.ts 在 Ash 缺失，原路径独立实现；样式落上游同路径 browser/widget/chatContentParts/media/chatCollapsibleContentPart.css，仅由新组件拥有。browser/widget/input/chatInputPart.ts 更新现有帮助。已确认的 src/ash/sessions/browser/chatWidgetModel.ts 仅把原 Thread 的 Turn 状态交给渲染转换，不改变订阅 owner；采用 sessions skill。agentHost 的既有 browser/appServerAgentService.ts 只转换工具调用/结果的嵌套领域值，Thread read、subscribe 和 notification 共用该边界；平台 owner 按 Sessions README 已确认的共享 Agent 领域归属保留，应用 app-server-api-integration skill。验证路径为现有 ChatListWidget、agentHost adapter 与 Sessions ChatViewPane 单测，以及 chatTranscript.integration.ts/spec.ts；另仅更新 chat.json 中文和本台账。其他路径只读，已有 Tasks/Terminal/Rust 修改保留。

上游证据只取同路径、ChatToolInvocationPart 的 domNode/toolCallId/onDidChangeHeight 公共职责、renderer 对调用 ID 的复用，以及工具调用可检查输入、流式输出和终态的可观察行为；不复制上游私有 subpart/observable/MCP 实现。Ash 直接使用其已有 ThreadItem / ChatToolCallBinding / ThreadTranscriptEntry，不引入 AHP 或生成 DTO 到内容组件。检验需覆盖真实 adapter→领域值→组件、跨 Turn 同 ID、结果/输出乱序、孤立结果、失败/中断、快照与增量、展开和焦点保留、主题/窄宽度、安全文本、中文、移除与释放。

Agent 通知边界追加准入：既有 platform/agentHost/common/agentService.ts 在 IAgentThreadService 提供领域 onDidUpdateThread / onDidUpdateThreadTranscript；既有 browser/appServerAgentService.ts 把已生成 decoder 校验的 notification 转为该领域事件，订阅随消费者的 IDisposable 释放，断开版本仍提供 Event.None。既有 workbench/services/chat/browser/chatService.ts 退出 Thread DTO 转换和 platform/browser adapter 导入，直接订阅上述领域事件；生成协议、Main、Rust 与连接拓扑不变。真实调用方为两种 Workbench 的既有 ChatService 装配；定向 adapter 测试验证 thisArgs、DisposableStore、不同 method 过滤和释放，Sessions 原 fakeApi 只改为使用正式 adapter 的通知契约，并覆盖重连与共享订阅。未新增 service、执行状态或 transport。

通知验证追加现有 platform/agentHost/test/browser/webRendererApi.test.ts：复用其 FakeTransport 与真实 AppServerProtocolClient，通过生成 decoder 后从 IAgentThreadService 观察领域事件、关闭/重连和 listener 释放；不建立测试专用生产端口。

无障碍追加：原 ChatListWidget 在回复元素获得焦点时提供现有 Chat verbosity 作用域下的帮助和 Accessible View，纯文本包含折叠工具的来源、目标、输入、输出与终态；关闭恢复原元素焦点。provider 由 widget 的 DisposableStore 拥有，不新增设置或 provider identity。现有 ChatListWidget 单测覆盖 provider 内容与 focus return。

本批结果：工具调用在原 Chat 渲染链保留一行身份，调用输入、来源链、执行目标、stdout/stderr 与结果由 agentHost 的既有领域值提供；以 Turn + toolCallId 隔离，同 ID 的其他 Turn 不混入。孤立结果和输出继续显示，不凭终止推断成功；Advisor 保留原专用展示。流式更新复用 DOM，保持展开和键盘焦点；窗口内视图恢复包含展开状态。无障碍帮助与纯文本阅读接入现有 Chat 设置，折叠详情可读，正文随领域更新刷新；关闭返回原焦点。Thread notification 的转换退出 ChatService，收敛到 IAgentThreadService 的领域事件；无外部生产调用方的两个旧转换 export 已移除，测试也沿正式事件端口接入。嵌套工具来源和结果在 adapter 内转换；注册、断线代次、共享订阅与后端执行 owner 沿用现有实现。

完整定向单测 4 文件 172 项通过；Chromium 8 项通过，覆盖英文/中文、原代码块/Skill 场景、工具流式内容、真实键盘和焦点、plain-text 阅读的动态更新与关闭、dark/light/HC、窄容器和移除。Renderer 类型检查 3719 文件通过，unit 与 browser TypeScript 编译通过；14 个 TS 格式、组件 CSS stylelint 和 Chat CSS ownership audit 通过（没有相同或仅品牌替换的上游 CSS，没有上游 root/token）。语言生成仅保留已有的 editorGutter 缺译。没有执行真实模型账号、MCP 服务或远程 SSH；这些结果覆盖生成 decoder、真实协议 client 和前端领域/UI，不等于外部供应商验收。全目录数字包含共享工作区同期的上下文附件变化，仅表示路径关系；没有把整个 Chat 或 agentHost 标记为完成。工具 rich media、完整增量 Markdown、引用/交互式 MCP 和语音仍按上方缺口继续拆解。

共享工作区本轮另一任务执行了 rebase，并把部分本批初始修改带入其 Terminal 提交。仅合并 ChatInputPart 中双方的帮助与建议上下文内容，保留其他任务的源代码和分支操作；本批后续差异仍在当前 checkout。

## 持久媒体与连续补全（2026-10-12）

用户阅读历史图片/音频或工具媒体结果 → ChatListItems 保留已有 ThreadItem / ChatContentPart 与所属 Session/Thread → ChatAttachmentsContentPart → IAgentThreadService.readAttachment → 原 App Server ProtocolClient → attachment/resource/open → 既有 read_session_thread 与 Attachments 验证 → 原 ResourceStore 的连接所属 handle → 原 resource/read/release → Blob URL 与图片/音频控件。输入和工具媒体均由原 Rust 附件存储拥有；前端组件只拥有加载取消、播放和 object URL，移除/切换/断线不把迟到字节装入新行。不以客户端 digest 或 URL 提供任意存储访问。

准确修改范围：既有 crates/attachments/src/{service.rs,audio.rs} 公开实际读取消费的验证端口；crates/app-server-protocol/src/protocol/{attachments.rs,registry.rs} 增加 Item 定位的媒体 resource 请求，现有生成器更新协议/schema/decoder；crates/app-server/src/{server.rs,server/attachment_operations.rs} 沿现有 Session/Thread 校验和 ResourceStore 接入，不新建 owner。验证追加 server/attachment_operations_tests.rs 并在 server.rs 注册 sibling test（Rust 独立测试文件），使用真实已存储用户与工具媒体、连接隔离、错误 Session/Thread/Item/index、取消与字节校验。platform/agentHost/common/agentService.ts 与 browser/appServerAgentService.ts 增加领域 readAttachment，复用原 readAppServerResource，不将 DTO 或 resource ID 暴露给产品。共用媒体展示落到上游同路径 browser/widget/chatContentParts/chatAttachmentsContentPart.ts，使用既有 DI 和原 Browser 控件，不复制上游内部实现；样式只追加现有 chatMarkdownPart.css 的该组件职责。已确认 chatListItems.ts / ChatListWidget、现有 toolInvocationPart、Sessions ChatWidgetModel 传递原线程身份；现有 Chat/agentHost/browser fixtures 验证真实读取、媒体、迟到回包、释放、键盘、主题和中文。其他模块改动保留。

媒体验证结果：真实 Rust 持久图片、音频和工具结果的 Item 读取测试通过，资源拒绝其他连接，错误 Session/Item/index 不建立可用 handle。3 个前端套件 107 项通过；Chromium 历史/工具媒体、音频播放与释放、迟到读取取消等 11 项通过，另补同一 Thread 快照刷新时保留播放和 blob URL 的回归。协议生成、协议类型检查与协议测试通过；App Server warnings 检查通过。媒体读取沿 IAgentThreadService / 原 resource 适配器，UI 只在用户加载时创建 object URL，取消后仍由原 helper 释放晚到 resource；断线不会向新代次释放旧 handle。后续继续闭合流式 Markdown 与 Prompt，不将媒体通过作为整个任务结束。

## 流式 Markdown 准入

Agent Thread transcript delta → 原 ChatWidgetModel → 原 ChatListWidget 的同 Item 行 → ChatMarkdownContentPart.tryIncrementalUpdate → 当前 Ash MarkdownElement 的 sanitized 渲染 → 原 CodeBlockPart / Stanza model。只对追加或终态确认复用；正文被替换时由旧行释放并重建。part 拥有稳定根、单一当前 Markdown lifetime、按代码块序号保留的原编辑器和当前响应的图片读取；不改变 Base sanitizer、滚动 owner 或后台 transcript。终态按实际 incomplete-token 标志重新解析，已完成的普通块保留，代码模型更新保留选区/焦点。

准确范围为双方已有 chatMarkdownContentPart.ts、codeBlockPart.ts、ChatListWidget 和既有 ChatListWidget/browser transcript 测试。tryIncrementalUpdate 采用上游已存在的公开职责与名称，参数使用当前 Ash IMarkdownString 与临时渲染标志；实现使用本地 sanitized node 的可复用块和已有模型，未引入上游 incremental morpher、私有 AST/动画或第二套模型。原 provider 装饰与 image resource lifetime 仍由当前 Markdown snapshot 拥有。测试覆盖连续 delta、未闭合 fence→闭合→终态、代码模型数、选区/焦点、静态段落选区、完整复制、替换、移除、链接及图片读取。通过此 slice 后继续 Prompt 与其他台账项。

流式追加回归补充：ChatListWidget 继续由本行拥有 memory 引用控件，并在增量正文中追加引用时复用已有按钮；标签进入客户端 NLS。避免为了增量正文跳过新引用，或重建整行丢失代码选区。准确范围追加既有 chat.json；测试沿现有 transcript fixture。

## Skill 语法树与编辑诊断准入

用户编辑 SKILL.md → 既有 Chat prompt contribution → PromptFileParser / PromptHeader AST → PromptHeaderAutocompletion、PromptHoverProvider 与上游同路径 PromptValidator → Stanza 的正式 syntaxProvider / completionProvider / hoverProvider registry。Rust Skill catalog 仍唯一决定是否接受、版本与执行权限；编辑诊断仅解释当前草稿，不另建 catalog。语法树使用独立 YAML 库的公开 parseDocument / node range API，保留 scalar、sequence、map 与精确源坐标，不复制上游 YAML 私有实现；解析不展开 alias，不执行 tag，限制输入和深度以保护编辑线程。

准确路径：双方既有 common/promptSyntax/promptFileParser.ts 增加实际 provider 消费的属性与错误；双方既有 languageProviders/{promptHeaderAutocompletion.ts,promptHovers.ts} 从 AST 读取键范围；双方既有 promptFileAttributes.ts 继续当前 Ash Skill schema；上游存在、本地缺失的 languageProviders/promptValidator.ts 在正式 registry 注册并提供本地化 syntax / required / unknown-key / shape 诊断；browser/chat.contribution.ts 仅增加该注册。既有 parser / language-provider / browser transcript 测试覆盖复合 YAML、错误修复、取消、精确范围、en/zh-CN 和真实编辑器诊断。package.json / pnpm-lock.yaml 加入直接 yaml 依赖，THIRD_PARTY_NOTICES.md 与 licenses/YAML.txt 保留该依赖许可证；chat.json 添加对应中文。新值建议只沿既有实际数据源实施，无后端数据时不伪造工具清单。其他路径保持只读。

诊断注册准入修正（写代码前）：读取生产 App Server syntax provider 后确认其优先级 100，普通 syntaxProvider 会被覆盖，提升 Chat 的全局 Markdown 优先级又会覆盖其他语言诊断。因此诊断独立使用既有 IMarkerService 的 owner，与其他诊断聚合；不改变 Editor/App Server provider 优先级。新增上游同路径 browser/promptSyntax/promptFileContributions.ts 的 PromptLanguageFeaturesProvider，由 contribution 注入 IModelService / IMarkerService，监听已打开 SKILL.md 的内容、语言与释放并清除本 owner markers。PromptValidator.validate 消费已解析 AST 输出现有 LanguageDiagnostic；不再实现 SyntaxProvider。浏览器 fixture 使用正式 IModelService 创建文件模型，观察真实 marker 与编辑器提示；仅更新既有 fixture/test，scope 与释放仍是宿主 owner。

Skill marker 生命周期实际入口阻塞与追加准入：使用真实 IModelService 创建资源模型时发现 ModelService.getCreationOptions 向 IConfigurationService 传递 resource override，而当前 Desktop 与 InMemory 配置 owner 明确拒绝此参数；既有单测使用自制允许 resource 的配置，未覆盖产品链。追加双方既有 editor/common/services/modelService.ts 的此单一调用 hunk，只请求已支持的 language override，资源身份/EOL/缓存仍由原 ModelService 拥有；追加既有 editor/test/common/modelService.test.ts 用真实 InMemoryConfigurationService 创建资源模型并验证语言设置。修复依赖后继续原 Chat 切片，不改配置 owner、不伪造测试专用模型 registry。

Hover 追加验证发现当前通用 ContentHoverController 尚未消费 MarkerService hoverMessage。准确范围内 PromptHoverProvider 改为同时消费 PromptValidator 的当前 AST 诊断：值位置可读相应字段/语法错误，键位置仍显示 schema 说明；不建立另一份 marker 状态，也不在 Chat 批次扩散改造通用 Hover。独立 owner 标记继续供 Problems 与标记装饰消费，Browser 通过实际键盘 Hover 验证中文错误文本。

## Skill 工具值补全准入

用户在 allowed-tools 字段输入名称 → 原 PromptHeaderAutocompletion → 当前宿主已注册 IAgentCapabilitiesService → App Server 的原工具目录 → 当前 AST 字段与编辑快照对应的值建议。只展示现有 direct/deferred 工具，隐藏 modelOnly/hidden，不推断执行许可，不建立缓存或新工具 registry；取消/旧模型结果由 provider 信号及原 Stanza 版本门禁淘汰。name 值继续使用当前资源目录。准确范围仍为既有 promptHeaderAutocompletion.ts、PromptLanguageFeaturesProvider 的 DI 创建与既有 language-provider/widget/browser tests；只有测试显式注册能力 fixture。双方 Workbench 和 Sessions 生产宿主已注册该契约，agentHost 的真实能力读取沿既有端口，不新增协议。精确 scope 是当前宿主 catalog，不能把它写成任意远程 Thread 的工具授权列表。

## Prompt 正文引用与 agentHost 资源读取准入

用户在本地 Skill 编辑器或已发现的 Skill Instructions 中打开正文文件引用 → PromptBody.fileReferences / resolveFilePath → 上游同路径 languageProviders/promptLinkProvider.ts → 既有 LinkDetector / Opener → 现有 text-model resolver → PromptLanguageFeaturesProvider 的只读 Skill content provider → IPromptsService.parseNew → 已确认的 IAppServerSkillApi → 原 skill/resource/open + resource/read/release。Rust SkillRuntime 与 SkillResourcePath 已经拥有来源、pinned digest、Session、路径穿越/链接与字节上限的校验，无须新协议或第二套文件存储。

准确范围追加：既有 parser 的 PromptBody 仅解析实际 provider 消费的正文文件引用，使用当前 Ash Marked lexer 跳过代码/HTML，不创建未消费的变量 API；缺失 promptLinkProvider.ts 按上游同路径创建并在原 PromptLanguageFeaturesProvider 注册。既有 promptsServiceImpl.ts 的已发现 URI registry 允许该 Skill 内衍生资源 URI，并保留来源、摘要与 Session；不接受其他窗口或 query 更改的 URI。已确认 platform/agentHost/common/appServerApi.ts 与 browser/appServerApi.ts 把 readInstructions 唯一入口迁为实际生产读取的 readTextResource(reference,path,signal,sessionId)，沿原 Resource helper 验证与释放，只消费 text MIME / UTF-8。所有既有调用与 fake implementation 同批迁移（rg readInstructions 的 Skills/Sessions/agentHost tests 和 fixture）；无新旧 API 并存。

PromptLanguageFeaturesProvider 通过既有 ITextModelService 注册 private scheme 的 Skill authority 文本，IModelService 仍唯一拥有模型，resolver 仍引用计数与只读模型；提供者释放取消 pending parse，不创建第二份正文缓存。ExtensionsEditor 的既有 Skill Instructions 预览传入 parsed body source，链接绑定原 Skill URI；Open instructions 直接打开原只读 URI，退出失去来源的 untitled copy。extensionsEditor.ts 只改这条 Skill 读取/打开链和原 renderDocument 的 Skill source URI 转换，包 README owner 保留；该仅 Ash 编辑器归属已在台账确认。验证使用既有 PromptsService/parser/provider/agentHost/Extensions 测试，正文 Markdown 引用、CRLF、代码排除、精确范围、相对嵌套、source/digest/Session、权限失败、取消/释放与中文仍沿真实入口；其他能力保持只读。

流式 Markdown 图片布局追加准入：既有 ChatMarkdownContentPart 补充上游已有 onDidChangeHeight 公开事件，当前 render snapshot 的异步资源回调和本 part root 捕获的 img load 触发高度变化；原 ChatListWidget 使用原 ScrollableElement 的滚动事件维护跟随状态并在资源加载时布局，不改变滚动 owner。测试仍限当前 widget/browser transcript，覆盖追加时只读取一次工作区图片、实际图片解码、用户阅读位置、移除后的 URL 释放和安全链接回调；不把 Base 的图片生命周期搬到 Chat。

资源关闭边界追加准入：持久媒体与 Skill IO 完成后，mint connection resource 前必须重新在 ConnectionState 锁内检查 closed，并持锁完成短暂的 ResourceStore.create。否则旧连接关闭清理与慢读取完成之间可能建立无人可释放的晚到 handle。仅追加 attachment_operations.rs 和双方现有 skill_operations.rs 的 mint hunk，保持 state → resources 的关闭锁顺序；不持连接锁执行文件或外部网络 IO。验证沿既有 App Server media/Skill 测试，并保留前端 generation / abort 回归。

## MCP 嵌入资源与结构数据准入

用户检查 MCP 工具返回的嵌入文件或结构数据 → Rust MCP 输出边界 → 原 ToolContent / ContentPart / ThreadItem.ToolResult → agentHost 深层领域转换 → ChatToolInvocationPart / ChatResourceGroupWidget → ChatResponseResourceFileSystemProvider.associate → 原 FileService / readonly editor。只展示工具实际返回的数据，原 MCP runtime、Core 事件、文件服务与模型各自保持 owner；不根据 JSON 字符串猜测 HTML App，不执行资源脚本，也不把资源 URI 当作本机路径。只读资源在当前响应 association 中持有，释放随行生命周期；原 Backend Thread 仍持有历史结果。

本阶段准确范围：新增共享协议 crates/protocol/src/tool_output_artifact.rs 的实际使用 payload / source / digest 契约并在 lib.rs / model/message.rs 接入；MCP 输出、Tools output 与 protocol_adapter 保留资源/结构数据，超过原输出预算时显式标记截断而不假装完整 JSON。ash-mcp Cargo.toml / Cargo.lock 仅增加所需既有 base64 依赖。所有受闭合 ContentPart / ToolContent enum 影响的匹配，仅增加 Artifact 的 inert model-text / context-size / unchanged-media 处理，不重排原实现。准入精确列表：

- `crates/core/src/thread_controller_tests.rs`
- `crates/rmcp-client/src/lib.rs`（只重导出当前 SDK ResourceContents，实际 MCP decoder 消费）
- `crates/tools/src/output.rs`
- `crates/ash-api/src/requests.rs`
- `crates/ash-api/src/endpoint/anthropic_tests.rs`
- `crates/ash-api/src/endpoint/anthropic.rs`
- `crates/tools/src/output_tests.rs`
- `crates/core/src/attachment_preparation_tests.rs`
- `crates/ash-api/src/endpoint/chat_completions.rs`
- `crates/core/src/thread_controller.rs`
- `crates/tools/src/protocol_adapter_tests.rs`
- `crates/tools/src/protocol_adapter.rs`
- `crates/ash-api/src/endpoint/responses.rs`
- `crates/core/src/attachment_model_service.rs`
- `crates/ash-api/src/requests/google_count_tokens.rs`
- `crates/core/src/turn/code_mode/response.rs`
- `crates/ash-api/tests/audio.rs`
- `crates/ash-api/tests/provider_adapters.rs`
- `crates/ash-api/tests/request_header_tests.rs`
- `crates/ash-mcp/src/output.rs`
- `crates/ash-mcp/src/output_tests.rs`
- `crates/core/src/context/assembler_tests.rs`
- `crates/app-server-client/src/session_tests.rs`
- `crates/core/src/turn/executor_tests.rs`
- `crates/core/src/attachment_model_service_tests.rs`
- `crates/app-server-client/src/client_tests.rs`
- `crates/core/src/attachment_preparation.rs`
- `crates/core/src/context/planner.rs`
- `crates/core/src/context/input_limits.rs`
- `crates/model-provider/src/request_settings.rs`
- `crates/core/src/context/assembler.rs`
- `crates/model-provider/src/image_request_tests.rs`
- `crates/app-server/src/tool_executor_adapter_tests.rs`
- `crates/model-provider/src/image_request.rs`
- `crates/rollout-trace/src/budget.rs`
- `crates/app-server/src/audio_tests.rs`
- `crates/model-provider/src/model_tests.rs`
- `crates/app-server/src/dynamic_tools.rs`
- `crates/app-server/src/tool_executor_adapter.rs`
- `crates/app-server/src/task_delivery_host_tests.rs`
- `crates/app-server/src/server/attachment_operations.rs`
- `crates/ext/mcp/src/composition.rs`
- `crates/app-server/src/server/attachment_operations_tests.rs`
- `crates/ext/image-generation/src/tool.rs`
- `crates/model-tokenizer/src/registry_tests.rs`
- `crates/model-tokenizer/src/request.rs`
- `crates/protocol/src/contract_tests.rs`
- `crates/app-server-protocol/src/schema_fixtures.rs`

该列表的测试与实现只允许闭合新 variant 的相关 hunk；测试覆盖 MCP SDK 字节、混合内容、原预算、hash、模型输入、恢复和 readonly preview。更远的新调用边先重做准入。

TS 精确范围：既有 platform/agentHost/common/agentService.ts 与 browser/appServerAgentService.ts / 现有 adapter tests 转换 Artifact 为深层领域值（bytes 为 Uint8Array）；Chat 的既有 chatListItems / ChatListWidget / toolInvocationPart / attachmentsPart 区分资源与图片/音频。新增上游同路径 common/widget/chatResponseResourceFileSystemProvider.ts，由 chat.contribution 单例及原 FileService 注册；仅实现真实消费的 associate / readonly filesystem 契约，不补未消费的 session 或 export 命令。新增上游同路径 browser/widget/chatContentParts/chatResourceGroupWidget.ts，真实工具结果和孤立结果都调用，资源正文只用 textContent / 原 readonly editor。样式追加既有 chatMarkdownPart.css 的资源组件职责。既有 transcript / widget / agentHost / Sessions fixtures 与测试机械同步 domain variant；chat.json 添加中文。完成本阶段后继续真实 resource link、MCP Apps 与语音，嵌入资源通过不代表 active App 已实现。

MCP 嵌入数据验证：正常 Chat 单测全选覆盖 20 文件（首次 145 项中只读 FileService 同步拒绝断言错误，已在原测试修复并单独 2 项通过）；agentHost 9 项通过。完整 Chromium transcript 19 项通过，含英文/中文资源展开、原始 JSON/CRLF 复制、只读编辑器、安全文本、行顺序/保留节点与键盘焦点、dark/light/HC、资源释放。Rust Protocol 58、Tools 40、MCP 14 项通过，真实三个模型 endpoint 的 inert Artifact replay 定向测试通过。App Server check、MCP warnings、依赖检查通过；共享 fixture appTools.integration.ts 仅补其已消费的 Disposable value import，解除正常 browser 编译阻塞。资源链接与 active Apps 尚未计为完成。

## MCP 资源链接实际读取准入

用户在实际工具结果中打开 resource_link → ChatResourceGroupWidget → IAgentThreadService.readToolResource（只传 Session / Thread / Item / contentIndex，不接收任意 URI）→ 新 tool/resource/open → 原 read_session_thread 中同 Turn 的 ToolResult 和 ToolCall frozen binding → 原 TurnExecutor / ToolService → 原 Composite / Reloadable 绑定服务 → 原 MCP extension 的连接授权 fence / worker → 原 McpRuntime / RmcpClient resources/read → 验证单一原 URI 结果 → 原 connection ResourceStore / read / release → 既有 readonly response FileService 与 Editor。链接描述保存在 ToolOutputArtifactSource.ResourceLink 和现有 JSON data 中，未读取时只代表服务器描述；读取内容不改写原 Thread 工具结果。仅用户操作开始读取，行释放、请求取消、连接关闭淘汰读取；旧连接/目录/插件/工具 generation 拒绝重新绑定同名 server/tool。

准确后端范围：既有 crates/protocol/src/tool_output_artifact.rs 增加实际消费的 ResourceLink source；既有 crates/ash-mcp/src/output.rs/tests 解码 SDK resource_link 并保留 inert descriptor；既有 crates/rmcp-client/src/{lib.rs,client.rs,client_tests.rs}、crates/ash-mcp/src/{session.rs,runtime.rs,runtime_tests.rs} 接入资源读取/取消与原身份校验；既有 crates/ext/mcp/src/{runtime.rs,composition.rs,runtime_tests.rs,composition_tests.rs} 沿原 worker 和权限 fence；既有 crates/core/src/{services.rs,turn/executor.rs} 提供仅被上述链消费的 read_resource 与绑定校验；既有 crates/app-server/src/tool_composition.rs 两种组合服务机械转发，server/mcp_operations.rs / server.rs 增加正式入口/取消，app-server-protocol/protocol/mcp.rs / registry.rs 增加正式 typed params/response/cancellation，原 server/request_processing.rs 的 control lane 补新增 cancel method。原 managed/gateway 若新 Session scoped method 未自动路由，仅追加对应选择 hunk。协议/后端原测试文件覆盖来源/连接隔离、摘要/上限、取消、断线与旧代次；拒绝缺 binding 的旧历史链接，而不猜测新来源。

准确前端范围：既有 agentHost/common/agentService.ts / browser/appServerAgentService.ts 与原 tests 加领域读取及机械转换，生成类型仍只在 adapter；ChatResourceGroupWidget 原 FileService association 不缓存竞争后台状态，读取仅产生当前行只读 association，原 ToolInvocationPart / ChatListWidget 传入已有 resource coordinates。既有 Chat/agentHost/Sessions fake service 的必需 method 同步编译。原 transcript browser fixture/spec 验证实际正式 adapter、取消、错误/晚到与 readonly resource；chat.json 提供中文文本。后续 active Apps 的脚本/UI 不通过此 inert 读取入口自动执行。

资源链接后端验证准确追加：新增 crates/app-server/src/server/mcp_resource_tests.rs 并在 server.rs 注册 sibling test，仅测试上述正式 RPC 对 canonical ToolCall/ToolResult 的选择、frozen binding、原 ResourceStore connection 权限、旧绑定拒绝和取消。该测试文件由 Rust server endpoint 拥有，不新增产品实现载体。Shell/Tasks 原测试闭合 ContentPart 的单一 Artifact 忽略分支，不改变已有测试目的。

资源链接验证结果：正常 renderer 类型检查 3768 文件通过；agentHost / ChatListWidget 定向单测 21 项通过；Chromium 3 项通过（en/zh-CN、原坐标、读取前无 IO、摘要校验和释放、重复打开复用、移除取消与晚到 handle 释放）。真实 App Server RPC 定向测试通过（1 项，canonical ToolCall/ToolResult、同连接读取、其他连接拒绝、错误坐标/任意 URI 拒绝、旧 binding、cancel-before-start）。MCP 16 项、SDK 5 项通过，extension 与 App Server all-target warnings、协议类型检查通过；追加 SDK resource/read 真实取消与 extension worker 读取测试仍在执行。链接读取不重新执行工具，不改写原 ToolResult，不以读取成功计为 MCP Apps 已完成。

资源链接追加验证已通过：RMCP 6 项含真正 resources/read 的对端取消；MCP extension worker 3 项含连续 Tokio runtime 的同步资源桥。资源控制 RPC 已进入原 Control lane，取消不会排在等待完成的普通读取后面。

## MCP App 声明与隔离握手准入

模型实际 MCP 工具结果 → 原 startup catalog 的 `_meta.ui.resourceUri` → 同连接/目录代次中的 ToolOutputArtifactSource.McpApp（保留仅视图消费的 `_meta`）→ agentHost 领域值 → 原 ChatToolInvocationPart → 上游同路径 ChatMcpAppSubPart → IAgentThreadService.readToolResource 原来源绑定 → 正式 MCP resources/read → 现有 IWebviewService 的隔离 origin / resource worker → 标准 ui/initialize / initialized / tool-input / tool-result。未声明 App 的 HTML 仍按 inert resource 展示。App 输出不是新工具执行状态；纯本地交互、尺寸/主题/生命周期由原 Webview 与 Chat 行拥有，工具执行、上下文/消息和文件授权仍由原后端/Chat owner 决定。

本阶段准确 Rust 路径：既有 crates/ash-mcp/src/{catalog.rs,catalog_tests.rs,runtime.rs,runtime_tests.rs} 在不可变工具目录保留并校验 `ui://` URI、输出真实 App 描述；crates/rmcp-client/src/{client.rs,client_tests.rs} 与 ash-mcp/runtime.rs 仅在接入宿主明确宣告时协商标准稳定 `io.modelcontextprotocol/ui` MIME capability。crates/protocol/src/tool_output_artifact.rs 在已有 source 增加实际消费的 McpApp、model_text 不向模型回放视图元数据；原 app-server/server/mcp_operations.rs 允许同 canonical result 的 McpApp URI，仍沿原 binding / ResourceStore。不增加 URI 任意读取或脚本执行的后端入口。元数据预算仍走原输出边界，截断不可冒充完整 App 数据。App 资源 MIME 必须为标准 HTML profile，任何读取失败保留文本工具结果。

准确前端路径：已确认的 agentHost/common/agentService.ts / browser/appServerAgentService.ts / 既有 tests 机械增加 McpApp source。新增上游同路径 browser/widget/chatContentParts/toolInvocationParts/chatMcpAppSubPart.ts，只由原工具结果组件实际创建；既有 toolInvocationPart / ChatResourceGroupWidget 区分已声明 App 和 inert 资源，既有 chatMarkdownPart.css 仅追加 App 容器职责。原 Webview 双方已有 browser/webview.ts、webviewElement.ts 与 pre/index.html 增加明确选定的原始 JSON-RPC 消息形式：只接收当前 inner frame，包裹其当前 document channel 经原 isolated bootstrap 转发；不为 Chat 另造 iframe resource owner，不改变其他 extension webview 的既有协议。App 模式保留默认无外网 CSP、无 localResourceRoots 和权限；仅支持已实际实现的 host capabilities，未知/未授权工具调用返回标准错误，不能伪装执行成功。既有 Webview unit/browser fixtures/tests 验证跨 frame/代次隔离与旧 API 不退化；原 Chat transcript fixture/tests、chat.json 与台账同步英文/中文、真实 UI 握手、主题、尺寸、移除/迟到/teardown。后续 Core 授权的 App tools/call 与 Chat 消息/context 将另按实际调用入口闭合，本阶段不计为全部 MCP Apps 完成。

App MIME 协商追加准确 hunk：既有 crates/ext/mcp/src/composition.rs 的 start_mcp_tools_with_updates 在原 App Server runtime options 开启稳定 UI MIME。直接 McpRuntime 的默认调用仍不宣告 UI，具有图形 Chat consumer 的 App Server composition 明确开启，文本结果仍保留给其他消费者。协议与摘要测试追加 crates/protocol/src/contract_tests.rs，证明只给 View 的元数据不会进入模型正文。

SDK UI capability 序列化追加准确依赖：crates/rmcp-client/Cargo.toml / Cargo.lock 使用 workspace 已有 serde_json（SDK 的 serde_json 重导出受未启用 macros feature 控制，不为一个值扩大 SDK features）。仅用于正式协商消息构造与相关真实 SDK 测试，不增加版本。

App 连接生命周期准确追加：IAgentThreadService.onDidChangeConnection 仅把原 ProtocolClient state 事件机械转成当前 renderer 的领域事件，disconnected implementation 使用 Event.None。唯一生产新增消费者为 ChatMcpAppSubPart，连接关闭/替换时取消原读并清理旧视图；不创建第二份连接或 Thread 状态。原 adapter tests 与 Chat fixture 使用真实事件端口验证关断，Main / 连接拓扑不变。

正常全选单测的共享编译阻塞追加准入：同期 Terminal 新建 test/browser/terminalEvents.test.ts 的 IOutputService 精简 fake 直接断言不满足当前 TS 兼容规则，只将该单行改为已有测试惯用的 as unknown as IOutputService，不改变测试/产品行为，不接管 Terminal 对齐。

App 声明/隔离握手验证：MCP 18 项、SDK 6 项通过，含实际 MIME 协商、合法/非法 UI URI、文本结果保留；协议定向测试证明 View-only metadata 在正常和截断状态都不进入 model_text。完整 Chromium Chat 24 项通过，新增真实隔离 Webview 的 en/zh-CN 握手、输入/结构结果/_meta 交付、本地交互不被 Thread 刷新重置、theme/size、CSP 外网拒绝、无法读 Workbench DOM、未宣告能力的标准错误、teardown ACK 和按钮焦点。连接生命周期追加 Chromium 3 项通过，含原 agentHost 连接事件关闭旧 App。原 Webview 浏览器 5 项、Webview/agentHost 单测 18 项和完整 Chat 单测 145 项通过。Renderer 3775 文件、App Server check/all-target warnings、MCP warnings、依赖检查与 CSS stylelint 通过。仍需继续 Core 授权 App tools/call、App 读资源与消息/context、完整 CSP 元数据策略以及语音；没有把 hostCapabilities 空集宣告为整个 App 功能已齐全。

大 MCP catalog 的资源/真实输入追加准入：既有 crates/app-server/src/tool_composition/mcp_exposure.rs / mcp_exposure_tests.rs 的 McpMetaToolService 沿已冻结 catalog/definition digest 解出原 nested ToolCall 后转发 read_resource，不能让包装后的默认不支持覆盖真实 MCP reader。App 的 ui/tool-input 必须来自 Rust MCP runtime 实际发出的远端参数，不能把 call_mcp_tool 的目录选择外壳交给 App；既有 runtime.rs / runtime_tests.rs 在仅 View 消费的 JSON payload 中保存实际 input 和 result meta，ChatMcpAppSubPart 仅消费该原始输入，兼容本阶段已有 direct 工具记录。该 immutable Tool 输出仍由原 Thread 保存，模型仍不读取其中任何 View-only 字段。

App visibility 追加准入：同一 catalog.rs / catalog_tests.rs 解码稳定 `_meta.ui.visibility` 的 model+app / model-only / app-only 闭合模式，McpCatalogSnapshot.model_definitions 排除 app-only，完整不可变 MCP catalog 仍保留来源供后续已授权的 App 调用。防止宣告 App MIME 后把服务器 UI 专用工具误暴露给模型；不扩展现有 Core 模型工具权限。

包装层追加验证：MCP 19 项通过，App-only 工具留在原 origin catalog 并从 model definitions 排除；View-only payload 保留真正远端 input。Chat App 浏览器 3 项再次通过，包括 call_mcp_tool 外壳与实际 input 不同的回归；原 App 接收 `{value:7}`。McpMetaToolService 的冻结 digest 资源桥定向测试已加入，正常 App Server 编译/运行测试继续执行。下一段使用 Core 的 model-free Turn 执行与原审批队列：从 App 原 ToolResult 验证来源，选择同 MCP server 且可被 App 调用的工具，生成一个原 Thread 中的明确工具 Turn；不在 iframe/broker 直接越过 Core 调用 SDK。

## MCP App 工具调用经 Core 执行准入

App `tools/call` → ChatMcpAppSubPart → IAgentThreadService 的 App 调用领域端口 → 正式 tool/app/call / cancel → canonical 原 App ToolResult 与同 Turn ToolCall / binding → 原 MCP provider 选择同 server 且 App 可见的目标 → 同代次 ToolPort 隐藏成员绑定 → Core model-free Tool Turn → 原 ToolScheduler / ActionPolicy / pending approval / cancellation / ThreadItem.ToolResult → 正式响应与原 Thread 通知 → 仅原 View 的 MCP result。iframe 不直接调用 RMCP，不从 App 参数信任 server/路径/权限；App-only 成员注册为 hidden，模型 frozen catalog 继续排除，Model-only 成员不得由 App 选择。UI 元数据保留为只供 View 使用的原 ToolResult 内容，不能回放给模型。App Turn 在同一原 Thread 中持久化，不创建第二份执行/审批状态；审批响应继续原 Chat 入口，长读取不持 Session 请求锁。

本阶段准确 Rust 范围：crates/core-api/src/{runtime.rs,lib.rs,turn_execution_observer.rs} 增加有实际 App Server 调用的 SubmitToolRequest / submit_tool / model-free Tool kind；crates/protocol/src/thread/command.rs 增加真实持久 StartToolTurn，crates/core/src/{thread_controller.rs,thread_reducer.rs,lib.rs,runtime.rs,services.rs,turn/executor.rs} 接入原 Thread 命令、冻结绑定及已有 model-free scheduler/恢复；ThreadController / executor 原测试只补工具 Turn、审批、取消、重放和不调用 model。crates/app-server/src/server/git_turn_changes_observer.rs 将该 model-free kind 纳入原 opaque baseline / failure 语义，不绕过变更捕获。crates/protocol/src/tool_output_artifact.rs / contract_tests.rs 增加有 View 消费的 metadata-only source 并确保 model_text 不泄露；crates/ash-mcp/src/{catalog.rs,runtime.rs,runtime_tests.rs} 与 crates/ext/mcp/src/{runtime.rs,composition.rs,runtime_tests.rs,composition_tests.rs} 保留实际 App-visible 定义与同 server 选择，原 app-only 对模型隐藏规则保持；crates/app-server/src/tool_composition.rs / tool_composition/mcp_exposure.rs / 对应原测试仅注册 App hidden routes、同代次绑定及包装选择。crates/app-server-protocol/src/protocol/{mcp.rs,registry.rs} 增加正式请求、结果、取消/保留实际 outcome；crates/app-server/src/server/{mcp_operations.rs,request_processing.rs,mcp_resource_tests.rs} / server.rs 加 canonical 路由、长等待及原取消，测试覆盖真实 Core / approvals 与 source / generation 拒绝。App Server RPC 的原 Thread owner 完成结果，handler 只持读取坐标/receipt；新调用边需先追加准确准入。

准确 TS 范围：agentHost/common/agentService.ts、browser/appServerAgentService.ts 与原 tests 增加实际领域 invoke、取消和 ToolResult 转换，DTO 保留在 adapter。现有 ChatMcpAppSubPart 仅在接通后宣告 serverTools，限制同 View 的并发/重复 request IDs，关闭/连接变化取消原操作；资源 widget 排除只供 View 的 metadata，工具/列表可访问正文仍沿原 Thread。既有 Chat/agentHost/Sessions fake method 机械同步；transcript fixture/spec 覆盖 UI RPC、结果/metadata、失败/取消/迟到/刷新，chat.json 添加中文。其他模型、Shell、Tasks、Terminal 的行为保持原 owner，完整检查证明确切链未退化。

View-only 预算职责追加准入：既有 crates/tools/src/output.rs / output_tests.rs 的 model text truncation 不裁剪 McpApp / ViewMetadata 的数据，也不把其计入模型文本预算；硬字节限制仍由 MCP producer 边界计算/拒绝。否则只供 View 的实际输入会被模型字数设置裁成文本，再退回 metadata wrapper 外壳；不能用错误输入继续初始化 App。公开 MCP 内容的既有显式截断规则保留。

等待结果的实现准入细化：ThreadController 提供实际 RPC 消费的 completed_tool_result 读取，仅在原 loaded Thread 锁内借用状态、完成时复制一个 ToolResult；不在审批等待期间循环克隆整段公开 Thread 历史。handler 仍只持 receipt 和取消信号，不注册第二份操作状态，取消以原 Core interrupt 结束该工具 Turn。等待间隔 50ms，不持 Session serialization lock。

App 资源读取追加准入：已打开的原 MCP View 的 resources/read → 同 ChatMcpAppSubPart pending request/lifetime → IAgentThreadService.readAppResource → 正式 tool/app/resource/open / tool/resource/cancel → 与 template open 共用 canonical Item / 同 Turn ToolCall / frozen binding → 原 MCP read_resource / 当前 provider fences → connection ResourceStore → 原 verified read/release。允许该 App 请求其原 server 的资源 URI，URI 不能选择另一个 server 或本机 FileService；非 McpApp 坐标拒绝。准确范围仍是原 mcp.rs / registry.rs、mcp_operations.rs、request_processing.rs、server.rs、mcp_resource_tests.rs、agentHost common/browser/tests、ChatMcpAppSubPart 和原 transcript fixture/spec。浏览器只转换资源 bytes 为标准 MCP contents，不建立资源持久状态；并发、取消、关闭与工具调用共用当前 View 的 pending owner。协议/后端未接通之前不宣告 serverResources。

Core/App 工具验证追加：Core 完整单测 322 项通过、2 项原有 ignored；工具组合 30 项通过（包含大 catalog 原 member 的 hidden route 与 Deferred picker overlay 不重复、App-only 不进模型、旧 registry origin 拒绝）；真实 MCP provider 同 server / app visibility / 原审批定向测试通过；原工具 RPC 与资源 RPC 两项通过（正式初始化审批 capability、原连接 request owner、approveOnce / decline / cancel、canonical 持久 ToolResult、model-free 与无 AgentMessage）。agentHost 12 项通过；en/zh-CN MCP App 浏览器 7 项通过，包含真实模板、实际 remote input、结构结果与 View-only metadata、serverTools 与 serverResources、text/binary resource/release。资源取消的扩展 browser selection 正在修复 fixture 的 evaluate 参数并重跑，未计为通过。

CSP 资源声明追加准入：既有 protocol/tool_output_artifact.rs 与 lib.rs 提供 MCP 资源声明的 typed app CSP（只有实际读取的 HTML template 消费，不进入模型文本）；ash-mcp/runtime.rs 在资源边界解码 _meta.ui.csp、限制列表/字节与 origin 语法，原 runtime_tests.rs 覆盖恶意指令注入/协议/资源身份；mcp.rs / registry.rs 为 tool resource open 返回准确资源 metadata 与可选 CSP（原四个 handle 字段保持），mcp_operations.rs 仅传递此原读取结果。agentHost domain adapter 只转为 frontend domain policy，ChatMcpAppSubPart 把其传到原 IWebviewService contentOptions，并在 host initialize 报告实际应用的 sandbox CSP/空 permissions。原 WebviewElement 仅在 MCP messageProtocol 下组合 domain directives；HTML 页内 CSP 只能收紧该固定 policy。准确范围追加 webview.ts / webviewElement.ts 及原 webview unit/browser tests/fixtures，transcript fixture/spec 验证声明 CDN/fetch 可用、未声明域拒绝、DOM/permission 隔离与旧 extension view 不变。禁止直接拼未经 boundary 验证的服务器字符串，也不让资源原 URI 获得本机文件权限；相机/麦克风等权限维持明确拒绝。暂不宣告未经实现的 dedicated-domain/display-mode。

CSP origin parser 的依赖准入：crates/ash-mcp/Cargo.toml 与 Cargo.lock 引入 workspace 已锁定的 url。需要真正 URI origin parser 处理 host/port/credentials/query/fragment/IPv6 和 wildcard 后缀，不能自己按字符串实现 URL 语义；只加既有版本的包边，不扩大 SDK features。运行依赖检查并验证对应 normalized origin 与拒绝案例。

App result 的媒体交付追加准入：原 ChatMcpAppSubPart 重构标准 MCP result 时，不能丢掉 Core 已持久的 image/audio attachment。只在用户打开的该 View 内用原 readAttachment（结果 Item + contentIndex）读取并验证/release，再重构 MIME/base64；不重新执行工具，不凭远端 URL 获取任意本地文件。工具 result 的结构数据/ViewMetadata 保留顺序，通知与 request 的媒体 IO 归当前 View AbortController；关闭/替换/移除取消，旧 View 不接收新结果。同一结果刷新用发送内容签名避免重复媒体读取，持久内容仍只属 Core。准确范围仍是 ChatMcpAppSubPart 与原 transcript fixture/spec，agentHost 既有附件端口只新增实际消费者，无新媒体存储或传输协议。

App Chat message/context 准入：View ui/message / ui/update-model-context → 原 ChatMcpAppSubPart source-bound delegate → ChatToolInvocationPart / ChatListWidget options → 当前 ChatWidget → 原 ChatInputPart.attachmentModel / 当前 IChatWidgetModel.send → 原 ChatService / agentHost / Core 用户输入。App 无法从参数选另一个 Session/Thread，Widget 在调用时重新比对原来源与当前身份；模型、mode、审批与 queue/steering 仍取原 Chat model。ui/message 使用 App 自己的 context entry，不自动发送或清空用户未提交草稿与其他附件。update-model-context 的文字/结构 JSON 仅更新原 composer context attachment，不另建 App context store；下一次真实发送成为 Core 已有低信任 UserContext。多次更新替换同一来源，保持到来源关闭或用户移除；View close/connection change/source移除清理自己的 entry，旧 disposable 不删新版本。unsupported media context 返回标准错误，不伪装支持。公开 attachmentModel 对应上游同名公开 getter，有实际 Widget consumer；不读取/复制上游私有实现。

准确范围：原 services/chat/common/chatContextService.ts 给既有 attachment 定义 source/submission 生命周期；ChatInputPart.ts 暴露已拥有的 attachmentModel（上游对应公开成员）并在 submit 保留 source lifetime；ChatMcpAppSubPart.ts 定义实际消费的 delegate，ChatToolInvocationPart.ts / ChatListWidget.ts 机械转接，ChatWidget.ts 在原 owner 中更新/释放和发送。原 input 单测、Sessions model/part 单测和原 transcript browser fixture/spec 覆盖文本/JSON替换、连续提交、用户删除、来源关闭、保留草稿、exact scope和迟到响应；chat.json 的新用户文字中文同步。未新增后端 App context 历史；持久记录继续只有正常 Core Turn 输入。

MCP message contract 核对追加：稳定 MDX 示例的单个 content block 与当前官方 SDK McpUiMessageRequest 的 ContentBlock[] 不同。实际消费按当前 SDK 的数组形式实现，同时接受该稳定文档的单个文字 block；只能 user role / 非空文字，unsupported媒体仍标准拒绝，不能按旧示例遗漏真实 SDK 调用。公开依据 https://apps.extensions.modelcontextprotocol.io/api/interfaces/app.McpUiMessageRequest.html ，不读取或复刻 AppBridge 私有实现。

跟随消息在 model-free Turn 中的语义缺口：Core App 工具 Turn 原先复用 Coding kind，而 frontend adapter 同时丢弃已存在的 Turn.kind。默认 Agent mode 的 App ui/message 可能被错误地 steer 进没有模型调用的 Tool Turn，导致接受的用户消息没有回答。需要在原 Turn purpose 中准确区分工具/独立 Shell/显式 compaction 与 Coding/Review/Advisor，再由 agentHost 机械保留 kind，Chat model 对非模型 Turn 排队真实用户 Turn，Core拒绝向非模型 Turn steering；新 App 消息不创建另一套执行调度。

准确准入：protocol/turn/execution_kind.rs、Core thread_controller.rs / thread_reducer.rs 的原 StartTool/Shell/Compact 与 steering校验、core-api/runtime 的提交契约和真实 command caller（旧持久 Shell/Compact 记录继续兼容）；agentHost common/browser/tests、Sessions chatWidgetModel.ts 与原 tests。闭合枚举导致的 model/context/rollout/tui 现有 match 只补明确语义，先按编译/调用证据列准确 hunk，不借此重排这些 owner。相关测试必须证明默认 Agent 中的 App后续消息排队，原Coding/Review steering继续可用，Tool/Shell/Compact 无新增模型请求/原命令不重放为用户文字；暂未将这一缺口计为完成。

Turn purpose 的准确依赖补充：实际 steering owner 是 crates/core/src/thread_controller/steering.rs（原入口由 thread_controller 模块装配），在原 canonical snapshot 下拒绝 Shell/Tool/Compact 命令对应 Turn，包括 kind 仍为旧 Coding 的持久记录。protocol/turn/execution_kind.rs 只新增已有独立命令对应的 Shell、Tool、ContextCompaction purpose；thread_controller 与 reducer 在原接受事件中设置/验证，旧 Shell/Compact 记录的 Coding 仍允许读取。src/ash/workbench/contrib/chat/browser/widget/chatListItems.ts 对非模型失败不提供误导的模型重试，Sessions 原 retryFailedTurn 也不重放这些独立动作；原 chatViewPane.test.ts / chatListItems.test.ts 与 Core thread_controller_tests.rs 补真实行为回归。新种类由原命令拥有，客户端不得向 regular startTurn 填入独立动作种类来绕过原 command/binding。

App/Chat 继续验证：Turn purpose 修正后 Core 完整 322 项通过、2 项原有 ignored；Sessions + agentHost 110 项通过，含四种独立执行期间的用户消息带最新 context 入队，Coding 原 steering 保留。完整 Chat 单测 146 项通过；完整 transcript / Webview Chromium 43 项通过，含真实 ChatWidget + 原 ChatInputPart 的 en/zh-CN context 替换、私有草稿/文件保留、source close 清理、旧 Thread 拒绝。MCP 20 项通过，CSP byte/列表/协议/origin/凭据/路径/注入/重复域验证；协议 129+2+1、CSP 与原 Webview/agentHost 21 项、View-only model-text contract 定向 1 项通过。URL 只新增现有依赖边，208 workspace members / 92 reviewed duplicate packages 依赖检查通过。实际 browser 证明声明 API/CDN 可访问而未声明域拒绝；原 extension Webview 5 项仍通过。后端 App RPC/资源/CSP 2 项已通过，Turn purpose 后的 RPC/warnings/renderer 正在补跑。

下一段继续 MCP 公共接口：资源读取须保留原 text/blob 种类而不能仅按 MIME 推断（例如自定义 JSON MIME 的文字资源），以及资源/内容的 metadata 和 annotations；tools/list 必须按原 server 的 App visibility 枚举真实 catalog。外部链接与 display-mode 需沿现有 opener/实际 DOM fullscreen owner，不能只宣告 capability。语音与剩余响应/终端关联继续按本台账调查，不把当前 App 交互验证视为整个 Chat 已完成。

资源种类/metadata 保真准入：原 MCP ResourceContents 的 text/blob 决定 encoding，而 MIME 仅决定文件类型；tool resource open 返回编码和原资源 _meta 的 JSON，agentHost 把 extra metadata 与四字段 handle 分离，再用原 verified reader 读取；View resources/read 重建原 text/blob 与 _meta。ToolOutputArtifact 只保存实际被 View 消费的 resourceMetadata JSON，models 的 model_text 不加入它；MCP output/runtime 边界计入真实 payload 预算并保持原 metadata。准确 Rust 文件：protocol/tool_output_artifact.rs、ash-mcp/output.rs/runtime.rs 及原 tests、app-server-protocol/mcp.rs/registry.rs、mcp_operations.rs 与原 RPC tests；TS 仍为 agentHost common/browser/tests、ChatMcpAppSubPart 与原 transcript fixture/spec。只增加已有资源与实际 Caller 的数据字段，不增第二份资源保存/读取 owner；字节与 contentDigest 仍对应原 readable bytes。

资源跨 runtime 路由缺口准入：原 managed/gateway.selected_execution_target 只用 Session/Thread 选择目录/SSH runtime，resource/read 与 release 原四字段/单字段请求没有该作用域，打开在目标 runtime 的句柄会错发 Profile server。继续使用原 gateway 的 Session 选择与原 connection ResourceStore，不新增句柄映射/缓存。准确新增 hunk：app-server-protocol/protocol/resources.rs 的 metadata/read/release 增加可选 sessionId；agentHost/browser/appServerApi.ts 的 createAppServerResourceApi 保留可选 origin Session，tool/附件/Skill reader 在实际有 Session 时传入。原 Resource API factory 默认仍是 Profile scope；四字段 handle 验证不变。准确测试追加原 agentHost resource/skill tests与 App Server managed/gateway_tests.rs，证明 directory/SSH 的 read/release 同 open 作用域，Profile read/clear历史仍不跟随远端；服务端仍按原 connection 验证句柄，Session字段只选择原 runtime。

resource DTO 闭合编译补充：crates/app-server-client/src/lib.rs 的 Profile memory diagnostic bytes reader 与 client_tests.rs 的 Profile Skill reader 构造 ResourceRead/ReleaseParams 时显式 session_id: None；这些端口的 session ID 不是 Thread Session，不得转成 runtime 路由。没有改变产品调用或另建 reader。

MCP 内容 annotations/_meta 准入：ash-mcp/output.rs 在原 producer 保留各原内容块的 annotations 与私有 _meta，通过现有 ViewMetadata artifact 的专用 MIME application/vnd.ash.mcp-content-metadata+json 保存按原 contentIndex 的 sidecar（没有新资源状态或模型内容）。resource_link 的模型可见描述剥离 _meta，原 View 重构时恢复。原 text/image/audio/resource/link 全部使用同一表，persisted media 的坐标不改变；原 MCP 字节预算包含 sidecar，模型文本预算继续跳过 ViewMetadata。既有 ChatMcpAppSubPart 按原 block index 合并 annotations/_meta，顶层结果 metadata 独立维持原 application/json，不能混淆。准确文件仅原 output.rs/tests 与 ChatMcpAppSubPart / transcript fixture/spec，原 runtime 继续传递已有 top-level metadata。

App tools/list 准入：原 ui tools/list → IAgentThreadService.listAppTools → 正式 tool/app/list（四个 canonical App 坐标）→ 与 tool/app/call 共用来源解析 → 原 TurnExecutor/ToolService → 原 Composite/Reloadable/McpMeta/MCP owner → 同原 server、App visibility 的冻结 catalog。沿原 binding/registry incarnation/current provider fence 拒绝旧来源；不重新发现或复制一套活 catalog。保存 SDK 公开 Tool descriptor 的 JSON 在已有 McpToolDescriptor，原 snapshot startup 仅携带该不可变定义，与 alias/bindings 对应；原输入/输出 schema、annotations、_meta、icons/name/title 均原样给 App，模型仍用已存在的 model definitions。准确 Rust 范围：ash-mcp/catalog.rs 原 descriptor 与 catalog_tests；ext/mcp/runtime.rs/composition.rs 原 worker startup 和同 server 过滤、原 composition_tests；Core services.rs/turn/executor.rs；App Server tool_composition.rs/mcp_exposure.rs 与原 tests、mcp_operations.rs/server.rs/request_processing.rs/mcp_resource_tests.rs；app-server-protocol/mcp.rs/registry.rs。TS 准确 agentHost common/browser/tests 和 ChatMcpAppSubPart / 原 transcript fixture/spec，必要 fake 只补对应 method。短 catalog 读取不执行工具或创建 Turn；View pending/关闭同一 owner，不宣告 catalog change subscription。

App 原 opener / display mode 准入：ChatMcpAppSubPart 的 ui/open-link 使用 IOpenerService.open 的真实 external 路由，限定绝对 HTTP/S URL、拒绝凭据与控制字符，明确禁用 commands/contributed openers；由原 host 打开，iframe 不取得本机命令能力。ui/request-display-mode 使用原 Document/Element Fullscreen API，context 从 fullscreenElement 推导实际 inline/fullscreen，API 拒绝时回报实际模式而不保存假的 fullscreen state；pip 返回实际模式。原 fullscreenchange/ResizeObserver 发布实际 host-context，来源关闭退出自己的 fullscreen，不改其他窗口模式。原 CSS 只补该组件 :fullscreen 布局，现有主题色/关闭按钮/键盘焦点继续原 owner。message/updateModelContext capability 仅在真实 Chat delegate 存在时声明已实现的 text/structuredContent 类型。准确文件原 ChatMcpAppSubPart/media/chatMarkdownPart.css、transcript fixture/spec、chat.json，未新增 API/业务缓存/本机权限。公开依据官方 McpUiHostCapabilities、McpUiOpenLinkRequest/Result、McpUiRequestDisplayModeRequest/Result 契约，browser 测试必须验证实际 DOM 与原 opener 参数及无副作用拒绝。

App operation isolation 修复准入：原 tool/app/call 的 Core command/tool/cancel ID 只含客户端 operationId，跨 connection 同 operationId 可能重放他人的 receipt。沿现有 ConnectionState.connection_id 给同一操作三种 Core ID 加原 connection 作用域，RPC cancellation registry 已按 connection 隔离，不新增映射。仅 mcp_operations.rs 与原 mcp_resource_tests.rs 新增跨连接相同 operationId 的实际执行/取消测试；原 ToolResult 仍单一 Core owner，其他连接不能复用或取消这一 receipt。

后续 MCP 验证完成：资源 Session 路由 gateway 定向 1 项、Agent/Skill reader 80 项通过（Profile 请求仍不带 Thread Session）；MCP 22 项通过，包含内容 annotations/_meta sidecar 的原位置、硬预算/模型文本隔离和资源 inner metadata。原 MCP provider 同 server/App visibility catalog 定向 1 项、App Server 实际审批/执行/资源/catalog/跨连接同 operationId 隔离 RPC 1 项通过。Renderer 3800 文件、App Server 全 targets deny-warnings、正式协议 129+2+1 项通过；完整 Chat unit 146 项、完整 Chromium Transcript/Webview 47 项通过，含新增 en/zh-CN external opener、真实 fullscreen/退出/关闭、实际 frame-src 与 base-uri 的允许/拒绝、catalog schemas/metadata、媒体块 annotations/_meta。组件 CSS stylelint 1 文件 0 错误/0 design suggestions。Agent catalog 14 项已通过；新增后的完整 Agent/Skill unit 重跑遇到测试 runner 自身 SIGTERM fixture 的孤儿进程，精确终止本次测试两个合成 PID 后单独重跑，尚未把重跑结果计为通过。

语音实际媒体验证：使用本机已包装的 pinned LiveKit Server，原 ash-voice-agent bridge 的 4 项 ignored 场景实际执行并全部通过，覆盖授权人类音频→Live 协议模拟 provider→AI WebRTC 音轨、任务委托提议、最后人类离开、停止播放拒绝迟到音频、模型失败后的最终清理。这是原媒体链测试，不表示 Chat/App Server voice 已实现。Live provider 的 Input/OutputTranscript 均为 delta，没有完整句子结束事件；因此不能把每个 delta 创建成普通模型 Turn，也不能在 UI 或 App Server 另留一份持久转写历史。下一步准入需让原 Core 拥有独立于执行 Turn 的转写条目与 delta 合并，原 Thread transcript 统一显示；任务委托仍只经原 Core/审批，并仅接受独立 1:1 房间的授权人类来源。

Core 转写条目准入：语音增量由原 VoiceAgent worker 交给原 Core ThreadController；Core 在该 Thread 的 canonical snapshot 中合并连续同 media session/epoch/speaker 的文字（64 KiB 后开新条目），以 VoiceTranscriptRecorded 持久事实保存一个完整条目。它不是执行 Turn，不能改变 active Turn、model、mode、审批或重试，也不作为模型的 assistant/user 指令回放；只有授权 1:1 任务委托的文字走原 UserContext。条目记录原 speaker/time/source epoch 和原 ThreadItem 锚点，后端原 transcript entry 接口统一展示，UI 仅消费完整 upsert。voice sender 不保存第二份转写历史，不从音频混音猜测请求人。
准确新增 hunk：protocol/thread.rs、thread/event.rs、lib.rs 定义有实际调用的 VoiceTranscript/Speaker 与 committed event；Core thread_reducer.rs、thread_controller.rs、lib.rs、runtime.rs 和原测试拥有合并/持久/发布。thread-transcript/model.rs/accumulator.rs 与原 tests 增加无 execution Turn 的 VoiceTranscript entry；turn_id accessor 对此返回 None，现有调用方仅机械保留原 Turn filter。App Server 原 operations.rs/update_broker.rs 从原 Core snapshot 组装相同 Voice entries，原 voice_operations.rs worker 实际调用 Core；既有 thread/DTO literal 与 exhaustive match 只按编译证据逐个登记/闭合。TS 原 agentHost common/browser/tests 保留领域 source，ChatListItems/ChatListWidget/AccessibleView 与原 transcript fixtures显示原 text及本地化 speaker，不解释转写中的 Markdown/命令。新 voice 服务和正式协议/实际媒体运行时按前述批准范围接通后才算此调用链闭合。Voice history fork/rewind/import 的策略需随原 journal/Thread history owner 验证，不能伪称普通 Turn已覆盖。

转写 snapshot 的精确边界补充：保持现有公开 Thread DTO 的执行领域职责，Voice 字段只在原 Core ThreadSnapshot / journal；App Server 既有 transcript read/subscribe 在通过 Session scope 后读取同 durable sequence 的原 Core voice 条目，再加入原 ThreadTranscriptSnapshot，不创建另一份业务保存。Core 复用 load_snapshot_at_sequence 读取历史边界，分页只包含具有可见原 Item 锚点的转写；现有没有 Turn 的 voice spans 不混入执行默认 model/mode/retry。原 core_api ThreadView 与生成 Thread DTO 不增加未消费字段。

新无 Turn entry 的机械闭合准入：crates/tui/src/thread/transcript/model.rs 的既有终端内容 cell 直接使用原 speaker role/text，Turn owner 为 None，不生成工具或执行；原 client-id/Hook filtering match 只加入 VoiceTranscript 的明确 none。App Server update_broker_tests.rs 原 snapshot调用只显式空 voice slice；其余真实 source读原 Core记录。Core 既有 snapshot/test literals 与 ThreadEvent exhaustive match 的确切文件随后根据 compiler输出登记，不将未知 variant 用通配符静默吞掉。

依赖审计追加准入：Agent read/subscribe handler 不直接访问 Core implementation。core-api/runtime.rs 在原 AgentRuntime 增加实际三个 handler 消费的只读 read_voice_transcripts(threadId, sequence)，core/runtime.rs 仅委托原 Controller；operations.rs / session_operations.rs 经原 agent_runtime 读取相同 journal boundary。保留共享工作区同期 Session subscribe 的统一 ThreadView 改动，恢复其 Voice slice 参数，不另建缓存或 store。
编译闭合的准确文件：Core context/assembler_tests.rs、context/planner_tests.rs、context_manager_tests.rs、thread_controller/mailbox_tests.rs 的 snapshot literal 显式空 voice_transcripts；App Server session_operations.rs 原 Session subscribe 组装只读 voice snapshot，update_broker_tests.rs 原调用加空 slice；Sessions chatWidgetModel.ts 与 contrib/cowork/browser/coworkWidgetModel.ts 的原 cloneTranscriptEntry 深拷贝 Voice record，Cowork 原 widget/chatListItems.ts 和 chatListWidget.ts 仅复用正常 Chat 的 Voice presentation/既有 plain-text body。agentHost common 的 committed event type 集合补真实 VoiceTranscriptRecorded 标签（完整数据仍由原 Transcript entry DTO转换），不新建事件存储。

转写发布实现细化：运行中 Voice host 只需现有 ThreadController 的规范事实写入及原 ThreadUpdateSink，因此不增加未消费的 Runtime/AgentRuntime 方法；已移除尚无生产调用的 Runtime.record_voice_transcript wrapper。新的 sender caller 在 voice_operations worker，且由该 connection/epoch 生命周期守卫后调用原 Core owner。

Voice 会话实际端口准入：新增 app-server-protocol/protocol/voice.rs 并由原 mod/registry 生成 start/stop/interrupt/options/state、connection-scoped changed/delegation notifications（versioned voiceConversation contract）。App Server 已批准 voice_operations.rs 同时拥有 connection/epoch 的临时媒体生命周期，Core 拥有持久转写/任务；新 App Server dependency 只引用现有 ash-voice-agent，Cargo.lock/BUILD.bazel 只闭合该现有包边。原 Calls 改为 Arc 的同一服务实例，供 Voice worker 调用原 fresh Local call、CallRole.Agent invite/join、设备/麦克风授权与 leave/end；原 Calls executor 可供同 host 复用，不新建音频 owner。原 Calls/Dictation microphone gate 继续排他，关闭调用连接先取消其 Voice，再关闭原 Call/Dictation。interrupt 结束旧 room/model/AudioHost epoch 后重建 model session，不能用 StopPlayback 后继续旧 session 输出。
准确 server hunk：server.rs 注册/字段/初始化/close、operations.rs optional contract广告、request_processing.rs start background与 stop/interrupt control、managed/gateway.rs Voice media操作留在本机 Profile，不能把 capture路由 SSH；voice start 只接受 canonical本地 Thread scope，远端 Voice/Core bridge 另行闭合后才宣告支持。Core 当前 read/record_voice_transcript 有实际 worker caller；ThreadController.read_voice_task_progress 在原 snapshot 下读取由原 UserContext.client_id 与 exact transcript识别的真实 Core Turn/status/result，Voice worker仅缓存通知投递签名，任务执行/审批始终原 Core owner。Frontend 新 Voice service只保留状态领域镜像，不保留第二份转写，原 Chat Voice client通过已绑定 widget 的正常 model.send（附原低信任 UserContext）提交授权 1:1 人类任务，拒绝过期source/epoch。

Voice frontend 闭合范围细化：已批准的 platform/voice/common/voiceService.ts 和 browser/appServerVoiceService.ts 定义异步领域服务、显式 connection/epoch/current-request cancellation与 domain转换；IRendererHost 只加 optional voice领域字段。原 platform/native/electron-browser/rendererApi.ts 仅在本机 connection 的 voiceConversation contract成立时装配；原 workbench/browser/workbench.ts 注册 optional IVoiceService，缺少产品能力的 host显式 undefined，与现有 Dictation模式一致，不建假 capture服务。common/voiceClient/voiceClientService.ts 是原 ChatWidget scope controller，连接具体 canonical Session/Thread，关闭/identity替换停止自己的 room，VoiceDelegation只送原 model.send 的固定用户请求与本地化标签的低信任 context；绝不凭焦点重选任务目标。ChatInputDelegate/InputPart 仅消费该已接通 controller 的 available/active/toggle/interrupt，中文文字在chat.json。必要Standalone/Sessions fixture只显式注册 unavailable capture，browser fixture以明确的领域设备替身接入原 Widget；正式生成 decoder/client → Voice adapter 单独由 agentHost 单测验证。

Voice task correlation 细化：不把 opaque context marker显示为用户标签。正式 delegation给出原 Core submission commandId（由 voice resource/epoch/delegation tuple哈希生成），原 ChatWidgetModel/CoworkWidgetModel.send 的实际第五参数把它交给原 ChatService start/queue/steer options，三条既有路径仅在提供该值时复用该 commandId。Core 用原 UserContext.client_id + exact transcript查真实 Turn，而 UserContext.name使用客户端 NLS“Voice request”。准确额外 hunk 为 services/chat/common/chatService.ts 的既有 Start/Steer options、browser/chatService.ts 原三个commandId选择、两个原 model.send 与 IChatWidgetModel、voice proto/adapter/controller；没有新增任务队列或持久状态。原自动 commandId行为与正常模型/审批维持原逻辑，需覆盖 start/queue/steer和重放/来源拒绝。

Scoped submit补充：第五参数实际为 ChatSubmissionOptions（source、可选commandId/signal），不是裸ID。两个原 model在 initialize/ensureActiveSession/subscribe 的异步边界后再次核对同 Session/Thread 与abort，避免语音/MCP来源在切换Thread时把接受请求送入另一个目标。此值只约束原 send，不新建 sender/队列；现有 composer不提供该值，行为不变。原 service options仍只携带已接受correlation ID；中文UserContext标签不包含opaque协议IDs。

空 Chat 语音入口闭合：原 ChatWidgetModel/CoworkWidgetModel.prepareConversation 复用 materializeUntitledSession/promote/subscribe，不创建空模型Turn，不丢失用户选定model/mode/approval；真实 Voice connect 在provider choices就绪后取得该canonicalSource。VoiceClient.connect的Window为原Widget所属窗口，并要求当前用户激活，命令/工具的后台调用不能静默开启麦克风。目标变更在options/preparation后再次比较，原scope被替换时取消，不跟随焦点。Standalone/Sessions两个现有fixture明确提供 undefined IVoiceService以覆盖无音频host，其他测试缺依赖仅按实际compiler/runtime证据同步。

## 实时语音联动验证准入（2026-10-13）

Voice 的实际调用链已进入原 Call 本地房间、麦克风门禁、VoiceAgent 和独立 VoiceModelSession；Core 在原 Thread journal 保存 VoiceTranscriptRecorded，转写不启动或修改执行 Turn。agentHost 将无 Turn 的转写条目转换为领域值，普通 Chat 与 Cowork 用纯文本展示。任务提议携带来源 Session/Thread、媒体代次与原 Core command ID，经原 ChatWidgetModel 的 start/queue/steer 提交；播放器和物理设备继续由 Call/AudioHost 拥有。尚未验证的真实 App Server 生命周期和完整 UI 行为不计为闭合。

验证准确范围追加既有 agentHost/test/browser/webRendererApi.test.ts（正式 decoder/client→Voice adapter）与上游同职责 common/voiceClient 的本地测试，既有 Sessions ChatViewPane/浏览器 transcript fixture 验证语音按钮、转写及草稿保留。Rust sibling server/voice_operations_tests.rs 使用原 AppServer/ConnectionState/Core，真实本地 Call/LiveKit 与明确注入的 AudioHost IPC fixture；fixture 仅替代物理设备，不替代媒体、房间权限或 ModelProvider Live wire。测试必须区分媒体桥验证与真实账号/物理麦克风，不把它们混计。停止与打断按原连接/代次串行，房间清理单一所有者，断线取消旧媒体；重播和交错通知不能操作新代次。继续后续台账项，不以此批收尾。

Voice 历史边界追加准入：原 thread_reducer 的 HistoryMoved / HistoryPrefixBound 已从同一不可变 source snapshot 恢复文本、Hook 与上下文；同批恢复该 snapshot 的 voice_transcripts，复用原 prefix digest 和精确 sequence，不增加历史存储、运输 DTO 或重新执行媒体/任务。create_forked_thread / create_rewound_thread 的原测试验证父线程后来追加的转写不进入早期 prefix、重开保持一致、转写仍无执行 Turn；legacy Turn-only import 沿其实际已有数据，不猜测缺失语音。

编译闭合追加：原 App Server hook_events_tests.rs 的 transcript snapshot caller 传入同一 Core voice slice；原 TUI transcript/batch.rs 的增量字节预算计入 Voice 文本，原 renderer/turn filter 仍使用 None（无执行 Turn）。原两个 WidgetModel.ensureActiveSession 在 materialize 完成后检查原 Untitled identity，保留已创建 durable Session，但取消已切换视图的请求，不覆盖新选中的会话。VoiceClient 在 provider lookup 前保存该 Untitled identity，避免两个尚无 canonical Thread 的草稿被当作相同来源。

最终语音时长验证追加准入：App Server 取消后仍需等待原 VoiceAgent 的 bounded model close，并只排空最终 Usage/Closed，拒绝迟到转写/提议；同一 resource 的打断累计原 SDK 报告时长，不把时长当价格。真实测试发现 VoiceAgent pump 把外部取消直接传入 Live receive，可能先触发 SDK 退役 socket，导致未发送 session.close。准确追加既有 crates/voice-agent/src/session.rs：receive 使用不可外部取消的读取 token，由原 select 的取消分支丢弃 receive future（该 SDK 的公开 cancel-safe 合同保留连接），发送的 partial-write 保护不变。既有 tests/bridge.rs 增加原 CancellationSource 路径，仍使用真实媒体和 mock Live wire，必须观察权威 Closed usage。

## MCP App 文件导出准入（2026-10-13）

实际 View ui/download-file（SDK 公共 contents: resource/resource_link；结果 isError）→ 既有 ChatMcpAppSubPart → 原 IDialogsModel confirmation handle / BrowserDialogHandler → inline 精确 UTF-8/base64 字节或原 IAgentThreadService.readAppResource 的同 server/frozen tool 来源 → 原 triggerDownload(Blob, filename, ownerDocument)。确认使用同一 Workbench 对话框，source/request abort 取消其原 handle；关闭、断线和重用 request ID 后不得下载迟到资源。URI 不成为本机路径或前端网络 fetch；一次请求在原八个 pending operation 限额内，文件数/消息与总字节受限，文件名经过下载边界规范化，成功和取消分别返回实际结果。

准确修改为现有 chatMcpAppSubPart.ts、现有 browser transcript integration fixture/spec 与 chat.json 中文；不新增 backend/DTO/文件服务/下载 owner。fixture 显式装配原 DialogService.model 和 BrowserDialogHandler/Contribution，浏览器实际下载事件校验文件名、原字节、中文确认/取消、链接来源、无任意 host IO、取消后零下载及 blob 生命周期。公开规格只参照 https://apps.extensions.modelcontextprotocol.io/api/interfaces/app.McpUiDownloadFileRequest.html 和 McpUiDownloadFileResult / McpUiHostCapabilities 的声明，不复制 SDK 或 VS Code 实现。下载功能真正闭合后才广告 downloadFile；不宣告未实现的 logging/sampling/media context。

## MCP App 日志准入（2026-10-13）

View App.sendLog 的公开 notifications/message(level/logger/data) → 原 ChatMcpAppSubPart 的已初始化来源 → 原 ILogService / runtime sinks。日志是诊断，不能写入原 Chat input context 或 Core transcript；JSON 编码保留数据并防止多行伪造，附原 Session/Thread/Item 坐标。只消费 SDK 已声明的八个 level，按原日志服务 severity 映射，单 App 的条数和消息长度受限；关闭/断线后的通知不再投递。准确修改仍是既有 subpart、browser transcript fixture/spec；ILogService 和 LogService 只读复用，fixture 使用真实 LogService 的可释放 sink观察日志，不新建 store/DTO/trace owner。真正处理该通知后才广告 logging，sampling 等不作空承诺。

本轮已通过：Core 323 项、Chat 152 项、合并新版草稿/审阅/粘贴处理后的 Sessions/agentHost/Voice 202 项；完整 Transcript/Webview Chromium 49 项，新增下载 4 项和日志 2 项分别覆盖 en/zh-CN；实际 App Server Voice RPC 3 项、真实媒体桥 5 项、协议 129+2+1 项通过。Renderer 3827 文件检查、App Server check、TUI check、App Server all-target warnings 和依赖 208 members/92 reviewed versions 通过。共享工作区变基合并后的全量回归仍在继续；Git rebase/index 由发起任务负责，未执行提交、继续/中止变基或发布。

Voice 供应商准备边界追加准入：现有 options 只看声明的 Live profile，会把未配置 direct credential 的默认 OpenAI 排在可用连接前，并在 New Chat 创建 durable Session 后才报错。准确追加 crates/model-provider/src/websocket_session.rs：由既有 connect_voice 同一私有 factory 解析 profile、独立 voice selection、direct authentication/target；实际 App Server caller 使用其公开 check_voice_selection 进行无 socket/device 的预检。voice_operations 的 options 仅返回该 factory 能准备的连接，start 在建立 Call 前重检；不从 text subscription readiness 推断 voice，不另查/存密钥或新增字段。原 websocket_session_tests / voice RPC tests 验证缺少凭据的连接不列入 choices、配置后独立模型可准备，真正连接仍由原 factory 执行。

多 Widget 语音关闭边界追加：等待 provider lookup 的 Widget 尚未拥有媒体；其取消不能调用共享 VoiceService.stop 关闭另一个 Widget 的会话。原 VoiceClientService 记录 start receipt 的 resourceId，只有该 resource 才能 stop/interrupt/接收任务；pending start 由原 AbortSignal 取消并等待自身 promise，早到任务先有界缓冲，receipt 到达后只投递匹配 resource/epoch/source。原 common client 与正式 adapter 单测验证两个 Widget（含同 Thread）互不停止、同来源早到任务不丢、失败/关闭只影响自身会话。没有新增全局 voice owner 或任务状态。

Voice 显式选择准入：用户首次点击 Voice → 原 VoiceClient 的 source/AbortSignal 生命周期 → 原 ChatWidget 的 IQuickInputService → 实际 ready connection/model/voice catalog → 原 VoiceService.start(selection)。选择只属于此次媒体会话，不写新的 settings/state，不改变文字模型或 backend config；取消及来源切换关闭原 Quick Pick，未创建媒体时不发送 stop。准确 hunk 为既有 common client、Widget / 原 direct constructor fixture、chat.json 与 browser transcript fixture/spec。所有选项来自原 factory，没有自由文本假模型/声音；选项只有一个时直接采用该真实选择。客户端错误走原本地化通知，取消无错误通知。通过实际键盘、非默认声音、取消和切换验证后，才计入可选语音功能。

Cowork 实际消费入口追加准入：审计发现 CoworkWidget 是独立 presentation，虽然原 CoworkModel 和 agentHost 已有 Voice records，原按钮没有接共享 VoiceClient；其 list 也仍用旧的 plain tool/Markdown 路径。准确扩展既有 sessions/browser/workbench.ts（同 api.voice optional 注册）、contrib/cowork/browser/widget/{coworkWidget.ts,chatListItems.ts,chatListWidget.ts} 与 CoworkModel 的原 scope。Voice 与选择 UI 复用 common/voiceClient 的实际控制器和同一 Quick Pick helper，不复制媒体 owner；MCP delegate 仍由 Cowork 的原 attachmentModel/model.send 拥有。内容使用已有共享 mapper/Markdown/tool/media parts，保留 Cowork root/布局与自身 host，真实 browser fixture 和原 Sessions/Cowork tests 验证后才计为接入。没有把领域映射存在误当作 Cowork UI 已完整实现。

Cowork 消费闭合的准确依赖补充：共享 chatListWidget.ts 的 classPrefix 由原 CoworkWidget 实际消费，其仅选择宿主已有 root/row/layout 类，所有内容、视图状态与可访问性仍由原共享 list 拥有；Cowork media/chatListWidget.css 仅增加共享 Markdown 字体/换行继承。原 coworkWidgetModel.ts 改用共享 mapper 并传递原 Thread turns / Session/Thread 坐标，避免 tool ID 跨 Turn 合并与附件来源丢失。newCoworkInput.ts 的实际 delegate.send 补传原 submissionSignal，不另造取消状态。以上均为既有路径的局部 hunk。Sessions 的旧 chatListItems/chatListWidget/ChatMarkdownDecorationsRenderer 已退出生产调用链，用户确认后已按准确路径退役，不创建兼容别名。验证在现有 chatTranscript fixture 直接装配 CoworkWidget 与 NewCoworkInputWidget，复用原 agentHost adapter；测试覆盖同来源 App 上下文、草稿独立、语音选择、来源替换及媒体清理。

来源切换追加验证：Cowork 原 composerGeneration 独立于后台订阅代次，onDidChangeComposer 只在切换 Thread 时发出，原输入 invalidatePendingInput 立即取消上下文解析/提交；首轮 materialize 和同 Thread 重订阅不误取消。原 model.send 在 initialize/subscribe 后核对同代次，旧提交的完成或错误不改新来源状态。准确范围仍为 CoworkModel/Widget、新输入包装与既有 Sessions unit/browser fixture。

Voice 重播边界准入：voice/start 的当前 receipt 可幂等读取，但 interrupt 换代后原 operationId 不得重新打开麦克风。准确修改现有 server/voice_operations.rs 和其真实 RPC tests：由原 Voices owner 保留每连接有界 start identity 集合（不复制媒体/任务状态），失败前验证、关闭连接释放；旧 operationId 与跨 resource 重用拒绝，不重试写入，不调用 AudioHost/供应商。原实际 Room 测试在 stop 后重播最初 start，必须拒绝，fresh operation 仍正常恢复。

Cowork 本轮实际验证：原 Sessions/Voice 137 项单测、Cowork 原模型的富工具/重复 callId/来源坐标/取消 1 项、完整 Transcript/Webview Chromium 61 项通过；包含两个实际 Widget 与 Cowork Stanza 输入、en/zh-CN、真实 iframe。Voice 实际 Room/RPC 4 项通过，加入退休 operationId 重播拒绝；App Server all-target warnings 通过。终端快照输入预览已由原 Terminal owner 接入；尚无工具调用→实际 PTY command ID 的领域契约，不从工具名称或同名 ID 猜测活终端身份。

MCP App 图片 context 准入：原 ui/update-model-context 声明允许 ContentBlock（https://apps.extensions.modelcontextprotocol.io/api/interfaces/app.McpUiUpdateModelContextRequest.html）；原 caller 当前只有 text/structured context，Chat 领域已有 image URL 输入、createImageAttachment 和 source lifetime 附件。准确扩展现有 chatMcpAppSubPart.ts、ChatWidget/CoworkWidget 的原 delegate hunk、chat.json 中文与原 transcript fixture/spec。App 的图片经同一严格 base64/消息预算边界和 createImageAttachment 实际解码/缩放，再在原 attachmentModel 按 exact source/slot 替换，最后发送原 ResolvedChatContext(kind:image)。不取任意 URL/路径、不写新媒体模型、不重用 tool-result `_meta`；新的有效更新覆盖旧准备代次，旧解码、关闭、取消与来源替换不得覆盖新 context。公开 image capability 只在行为验证通过后宣告，audio/resource/sampling 仍不宣告。测试在两个真实 Widget、实际图片解码、中文、用户删除/关闭、失效数据与异步竞态后验证提交内容和草稿不串。

MCP image context 定向浏览器 4 项通过：Chat/Cowork × en/zh-CN，真实解码与原 image 输入、App 独立提交、严格 base64/非法图片/audio 拒绝、用户删除、异步最后更新优先和关闭后迟到解码零副作用。原 downloads 的 canonical base64 边界合并为同一私有 helper，需回归文件导出。

临时 context 与持久草稿边界准入：source-lifetime App text/image 由原 View 拥有，不能通过 captureDraft 或 Sessions 自动保存变成另一个来源的持久附件；用户输入和普通文件/terminal snapshot 才属于原 Thread/untitled 草稿。准确范围为共享 chatInputPart.ts 的 capture/clear、sessions/contrib/{chat,cowork}/browser/new*Input.ts 的 writeDraft、已有 chat/common/newChatDraftState.ts 持久解析、原输入 unit 和 browser fixture/spec。只过滤原 lifetime，不新建设置/状态/格式；保存与窗口传递使用已存在的完整 draft 合同（含 Terminal owner 提供的 immutable terminalSnapshot / resource），复用既有 validateOpenAgentsWindow 校验持久边界。Cowork 消费同一 draft codec，旧 Cowork codec 退出生产调用链，不创建第二存储。清理 handoff 只移除捕获到的用户附件，保持活 View context；测试验证临时数据不读取/导出/保存、terminal metadata 重开和实际源取消。

持续回归：全 Chat 263 项（37 文件）、全 agentHost 163 项（14 文件）、完整 Transcript/Webview Chromium 67 项通过；持久草稿共享 codec / terminal 几何边界 2 项和源隔离 163 项通过。审计保持 121/965/102/19/863，所有 Chat 生产模块有消费引用。中文新增项有实际 en/zh-CN 验证；全仓唯一缺失译文为既有 editorGutter.itemBackground，本范围不改 Editor 色彩。上游文件差异仍不能当作行为差异：MCP sampling 尚无 Core-owned sampling 请求端口，活 PTY↔tool call 关联尚无领域身份；不从名字/JSON 猜测，不宣告这些能力。

MCP resource context 准入：原 update-model-context 的 ContentBlock 包括 resource/resource_link。准确扩展同一现有 subpart 和 browser fixture/spec、chat.json：embedded 的明确 text/blob 只消费值，不读取 uri；linked 只经原 IAgentThreadService.readAppResource 的精确 Session/Thread/Item/contentIndex + frozen server。资源原 encoding 决定文本，image 经原 createImageAttachment，其他不可消费二进制明确拒绝；`_meta`/annotations/private metadata 不进入模型。原逐 View pending/cancel/source/代次边界继续约束 linked reads，最多 8 个资源/图片槽、总体 256 KiB，串行资源读取保持已有并发预算。原 delegate / attachmentModel / Core input 不新建传输或 context owner。必须验证真实 iframe→agentHost adapter→ResourceStore read/release/cancel→原 Chat 提交，包含中文、无任意文件/URL访问、迟到读取与关闭后零副作用，再宣告 resource/resourceLink。

MCP resource context 的实际 12 项定向浏览器与 Renderer 检查通过（含原图片/文本 context 回归）；linked resource 始终走原来源 RPC，embedded uri 没有 host I/O，明确 text encoding 在非 text MIME 下仍保留正文，私有 metadata 排除；cancel/release 和关闭后迟到返回均覆盖两个 Widget、en/zh-CN。

MCP 混合消息准入：原 ui/message ContentBlock → 同一私有 content 准备函数 → 原 delegate.sendMessage(source,text,signal,images) → 原两个 Widget.send / model.send。准确 hunk 为既有 subpart、两个 Widget、chat.json、原 browser fixture/spec。仅接受 user role；text/image/resource 继续使用上一链的编码、解码、预算与原冻结资源来源。一次消息的图片只属于该次原 Core 用户输入，不修改或持久化 App context，不附加用户未发送文件/文本；App source context 仍由原附件模型消费。消息等待最后有效 context 准备，再交原模型，取消/关闭/切源前不能提交迟到内容，已接受的原 Turn 由 Core 正常完成。没有第三条发送路径或后台模型调用。image-only 请求与普通 image-only 输入使用同一实际契约。完成实际混合消息、中文、草稿、旧 source/媒体与资源取消验证后才宣告 message modalities。

混合消息实际入口 4 项与完整 Transcript/Webview Chromium 75 项通过，Renderer 3823 文件通过；image-only/mixed resource 使用原 Widget 提交，源附件与用户草稿均保持原 owner，准备中取消与换源零提交。共享工作区新一轮 rebase 由发起任务完成；本任务仅保留工作源文件快照（.build/chat-alignment/latest-tested-wip），没有运行 Git commit/push/stash/rebase 控制命令。

持久媒体独立预览准入：用户加载原 Thread 图片/音频后激活 Open image/audio → 已有 ChatAttachmentsContentPart → 已有 IChatResponseResourceFileSystemProvider.associate(exact bytes) → 原 IEditorService / MediaPreview editor。准确修改为双方已有 chatAttachmentsContentPart.ts 的 row/load/open hunk、ChatListWidget 现有无障碍 help / chat.json、既有 transcript fixture/spec。URI 是同一响应 bytes 的只读 view association，受原 row/disposal 生命周期约束；不从任意 image URL 抓取 host 文件或重建资源授权，不新造 carousel、播放器或编辑器。原 Sessions/Workbench main 已装配 mediaPreview contribution，双产品依赖就绪。预览消费已核验的 source bytes，Source index/row 更换立即退役旧 action；音频移交预览前暂停原 row playback。实际浏览器通过原 ImagePreview/MediaPreview 类观察尺寸、格式、焦点、播放停止和释放，覆盖 en/zh-CN 与 readonly 拒绝；若实际 editor 依赖缺失，先闭合依赖，不创建空 preview。

媒体预览验证的依赖追加：原 chatRenderer.test.ts 的 mount assembly 先装配真实只读 response provider 与明确的 Editor fake（未请求 open 时失败），保留已有测试的自定义实例。没有在生产做 service locator/空实现回退。原 ChatInputPart voice help 补选择器搜索/Enter/Escape，原 ChatListWidget help 补媒体读取/独立只读预览与音频暂停；两处 en/zh-CN 参数与键盘行为沿已有UI测试验证。

隐藏会话的媒体生命周期准入：Sessions ChatViewPane 对非活动 pane 调用原 Widget.setVisible(false)，仅隐藏DOM不能停止已播放的音频或已开始的语音。准确追加现有 ChatWidget/CoworkWidget 的 own VoiceClient.disconnect；现有 ChatListWidget → ChatToolInvocationPart/ChatAttachmentsContentPart 的可见性端口，只暂停它们自己拥有的 HTMLAudioElement，不重新执行/清空 Thread、草稿、媒体字节或 accepted Turn。新的 setVisible 端口有原列表真实消费，属于原 presentation 生命周期，不是新状态服务。其他 Widget 的媒体不得被停止（沿已验证的 resource ownership）。原 browser fixture/spec 覆盖两个实际 Widget、en/zh-CN、hide 后 Voice stop 与 native audio pause、重显草稿/快照保留；此前手工切 source 的测试不能替代真实 retained tab 隐藏。

本批真实媒体 UI 定向 6 项通过（en/zh-CN：独立 image/audio preview + 两个 retained Widget 的 hide/show），媒体 renderer/list 23 项 unit 通过；原 Sessions 独立列表 assembly 补真实 response provider / Editor dependency，Audio history 单独 1 项通过。隐藏不清理草稿或 snapshot，不恢复自动播放；独立预览持有原字节，row 退役后 response association 不可重读。

目录 Session Voice/Core 联动准入：gateway 将 Voice 控制固定在 Profile，这对本机媒体 owner 正确，但 start/记录/反馈同时使用 Profile Core，会找不到已由目录 App Server 拥有的 Thread。准确修改现有 server/voice_operations.rs、managed/gateway.rs 与原 voice/gateway tests：gateway 按同一 ProfileRegistry.local_session 的 canonical executionTarget 解析原 open_local_session，不复制 Thread；只为 Voice 提供该既有 Core 的 ThreadController/Queue/updates。语音供应商、Call、AudioHost、媒体 epoch、连接资源仍在 Profile owner。注册仅保留 Registry Weak，防止 Profile/server 生命周期环；standalone 的默认 Core 维持本机原实例。源 Session/Thread、archived 和取消在开始设备前仍校验。Remote SSH Core bridge 没有现成端口，仍明确拒绝，不把整套 Voice RPC 转到远端麦克风。测试必须从 gateway 创建目录 Session，再启动同一 Profile 的真实 Voice，观察目录 journal/原广播/Task feedback 和本机房间 cleanup 后才计完成。

目录 Voice/Core 实际验证：Profile/独立原 Core 的真实 Room/RPC 5 项通过，含原 task command 接受、queue/Core feedback、重播、3 epochs 与时长；实际 gateway 从 Session.create(local root) 到 Voice.start/read/stop 的真实 Room 流程 1 项通过，目录 journal 收到 speech，Thread.turns 仍为空，本机 Profile 媒体正常停止并报告 500ms。gateway 目录来源/供应商准备边界 1 项通过。两种验证分别证明 Core source 接入与实际目录 routing，不把独立 test Core 标成真实目录。App Server check/all-target warnings 通过；当前全 Chat 264 项、Sessions/Voice 139 项与全 Chromium Transcript/Webview 81 项通过。远程 Voice Core bridge、MCP sampling / App-registered tools 和无真实 Ash caller 的上游成员仍待闭合。

目录准备取消补充：原 request_cancellations 在整个 VoiceStart 进入前已注册 operationId，保留该唯一取消 owner；新 Core lookup 的取消错误必须映射 RequestCancelled（-32800），不能因 PreserveOutcome 把它改成 InternalError。准确 hunk 为现有 voice_operations.rs 的 await/error/post-await fence与其 test sibling。原 RequestDispatcher 的实际 start/cancel control lane 验证 pending lookup 被取消、没有 Call/Provider I/O；不增加 pending cancel 表或重复媒体状态。

用户已明确确认删除四个准确 Cowork 旧路径（上述 list items / list widget / markdown decorations / draft codec）。替代调用链为原共享 Chat mapper/list/content parts 和 chat/common/newChatDraftState；现已删除，未保留 forwarding alias，Git 可恢复。迁移使用原 Widget、媒体和草稿状态 owner，不建竞争实现。

用户指出 VS Code 不存在 platform/voice 后，停止继续扩展远程 Voice/Core bridge；该扩展尚未写入代码。重新核对确认：platform/voice 为 Ash 自有能力，现有 common/voiceClient 的同路径不代表其接口已对齐；上游 connect(window, authToken)、PTT/audio/session-context 等公开端口与本仓的 Widget scope connect/select/start 契约不同。不得把实时媒体、LiveKit 或 App Server 自有协议的验证记作 VS Code API 对齐成果。保留现有源代码等待归属处理，未擅自删除或搬动语音文件。

语音归属纠正准入：保留已存在的后端行为，不扩展设备、LiveKit、Voice RPC、远程 Core bridge。当前 connection-owned 语音领域契约/DTO 转换回到已有 platform/agentHost/common/agentService.ts 与 browser/appServerAgentService.ts；RendererHost 仅暴露 agentVoice 领域能力，原 Electron assembly/两个 Workbench 注册该 optional agentHost 契约。Widget 生命周期、用户手势、来源切换、Quick Pick 与原 model.send 归 Chat 浏览器层，在上游对应 browser/voiceClient/voiceSessionController.ts 独立实现；common/voiceClient 不再承载浏览器控制器。真实 connect(window) 入口从原 Widget window 提取 activation，选择器由 controller 的明确 caller 提供。原上游 PTT/audio/session-context 的 VoiceClient transport 尚无兼容后端，不伪造其接口。准确变更为上述既有 agentHost/RendererHost/native assembly、ChatWidget/CoworkWidget、两个 Workbench、原 agentHost/controller unit 与 transcript browser fixture；旧 platform/voice 两文件及错误 common controller 退出引用后提出准确删除清单，等待用户确认。Speech 的 provider/session 契约随后由原 dictation 调用链单独闭合。

旧 Cowork 删除后的必要测试迁移补充：chatHookRenderer.test.ts 仍在测试 import 旧 Cowork mapper/list。其生产入口已共享原 Chat，两种 host 的 Hook 回归也改为同一 mapper/list，Cowork 只传原 classPrefix；测试 assembly 显式注册真实 response file provider 与未使用时拒绝的 Editor fake。修复仅涉及该原测试，不重建旧实现。

Speech 会话契约准入：原 SpeechService 唯一 recording 继续驱动 Dictation backend；补上游同名 SpeechToTextStatus、ISpeechToTextEvent/Session 和 createSpeechToTextSession(token, context)。每次会话的事件与 token 只绑定该 recording，开始前/开始中取消关闭其迟到 microphone handle，旧 token 不结束后来会话；开始时的 bounded 最后转写在首次 listener 安装后交付。原 DictationSession（Chat/Editor/Terminal 共享）与 onboarding trial 改为消费各自 session 的 Started/Recognizing/Recognized/Stopped/Error，不从全局转写猜录音身份。原 preparation/state/flush/cancel 端口仍有实际设置、toolbar、command 消费，保持原领域语义。准确范围为 workbench/contrib/speech/common/browser/test 原文件、Chat 的 dictationSession/onboarding、相关原 input/activityBar tests 与现有 table/terminal browser 回归；不新增 TTS、keyword、provider backend 或远端音频能力。尚无原产品调用方的 provider/TTS/keyword 端口留待后续调查，不能补占位实现。

旧 Cowork 删除的浏览器依赖补充：github.integration.ts 的 Cowork 链仍引用旧 decorations renderer；该 fixture 迁入原共享 ChatMarkdownDecorationsRenderer，与产品的共享 Markdown 调用一致，无新增 provider 或 owner。

用户已确认删除 platform/voice/common/voiceService.ts、platform/voice/browser/appServerVoiceService.ts、chat/common/voiceClient/voiceClientService.ts 三个准确旧路径。现已删除并留工作快照；平台不再有独立 Voice service 标识/注册/host slot。实际链为 IRendererHost.agentVoice → IAgentVoiceService / AppServerAgentVoiceService → 已有 Voice RPC；Chat/Cowork → browser VoiceSessionController → 原 model.send。没有新增 Rust、RPC、LiveKit、远端 Voice 能力。归属迁移 216 项单测、120 项 Chromium、全 Chat 264 项通过。Speech 的 createSpeechToTextSession 和标准状态/event 生命周期实际由原 Chat/Editor/Terminal DictationSession 和 onboarding 消费；两项 token 隔离/早期转写/最终刷新测试加入后，定向 52 项和最终 accessibility lifecycle 10 项通过，终端/录音实际浏览器续验中。

已接受上下文的检查准入：Core ThreadItem.userContext(name,content) → 原 agentHost 领域 ThreadItem → chatListItems.contextText → 原共享 ChatListWidget 的只读 details/summary/pre。原列表已拥有 row DOM/滚动/展开/焦点，直接增补该 row variant，不新增 context service 或转调 component。标题保持原名称，正文始终 literal text、不渲染 HTML/Markdown/链接、不调用文件/网络；collapsed 状态与 Tab/Enter/Space、正文焦点、view state 保存、canonical 内容更新和移除沿原 row lifecycle。Accessible View 包含已接受正文，即使视觉折叠；帮助文字 en/zh-CN 同步。准确范围为现有 chatListItems/ListWidget、其 CSS 与原单测、transcript fixture/spec/类型、chat.json；没有修改 Core、未发送草稿、App source context 或审批边界。只显示 Core 已接受内容，不重复持久数据 owner。

归属纠正后的后续行为：已接受 userContext 的 exact body 可在原 Chat/Cowork 列表折叠查看，默认收起；正文 literal、不可执行，无文件/网络读取，无模型发送。原行复用 DOM、保留展开/正文焦点，view state 恢复读取 live disclosure 状态，移除释放；Accessible View 可读折叠正文。两项 unit 与四项 Chromium（两个 Widget × en/zh-CN、dark/light/HC、220px宽度和原 focus）通过。全 Chat 266 项通过，Renderer 3826 文件通过；CSS 0 错误，仅原三个 font-role 建议。Speech 的标准 start/end lifecycle 两端与原无障碍提示接通，最终录音/Editor/Terminal 7 项实际浏览器通过。共享 Terminal 的 transient Event.filter 缺口已由同步任务修复，本任务没有修改该 Terminal/Base 文件；最初验证未通过，不计为通过。当前全 Transcript/Webview 与最终 linked units 续验中。当前 upstream checkout 变更到 3fd165b…，仅刷新对应审计，不批量同步其新增文件。

最终联动验证补充：agentHost/ChatViewPane/Speech/accessibility 209 项通过。之后完整 Transcript/Webview 续验在启动前被共享 Terminal 的新 environment mutator fixture 缺失 variable 阻断；最终 Renderer prepare 又被其 common capability 对 @xterm/xterm 的类型依赖引入 DOM lib 阻断（公共 shim 重复声明），没有将两次失败记作通过。此前已通过的上下文4项、完整120项、录音7项和Chat266项仍按各自源码范围保留；本任务没有删改其他任务的 Terminal/typings 来绕过 common 层检查。

当前浏览器验证的准确前置修复：terminal.integration.ts 的 MODE environment fixture 使用新 IEnvironmentVariableMutator，却遗漏同一 entry 的 variable 字段。仅在原测试生产者补 variable: 'MODE'，与已有 map key 完全对应；不修改 Terminal 领域实现、公共类型、配置或测试期望。该一行是全 browser fixture 编译的必要依赖，不通过禁用 typecheck 绕过它。common capability 的 DOM 依赖由同步任务自身修复后，当前 Renderer 3827 文件检查已通过。

最终当前源码验证：Renderer 3827 文件通过；完整 Transcript/Webview Chromium 85 项通过（含新增4项 accepted-context）；Chat 266 项、agentHost/ChatViewPane/Speech/accessibility 联动209项通过；真实 Editor/Terminal/onboarding 录音7项通过。中文实际运行通过，CSS0错误，diff check通过。原缺译 editorGutter.itemBackground 不属于本批用户文字。上述 transient common/fixture 编译失败已在当前源码下闭合，不计旧失败运行作为成功。

当前语音对应关系：

| 职责 | 当前实际 owner / 调用方 | 状态 |
| --- | --- | --- |
| 连接所属语音领域适配 | 原 agentHost common/agentService.ts、browser/appServerAgentService.ts；RendererHost.agentVoice 装配 | 已纠正归属，保留既有 optional 后端能力；不算 VS Code 新平台 Voice |
| Widget 语音生命周期 / 选择 / 原任务提交 | Chat/browser/voiceClient/voiceSessionController.ts，ChatWidget/CoworkWidget 实际消费 | 已迁入 browser，原错误 common 控制器已删除；完整上游契约仍未宣告 |
| 转写会话 / 标准状态 / 成功开始与结束事件 | 原 SpeechService，Chat/Editor/Terminal 的 DictationSession 与 onboarding | 原后端唯一 capture、会话 token 与事件隔离；旧全局 transcript/end API 退出 |
| PTT/audio/session-context VoiceClient transport | 上游 Chat/common + browser VoiceClient 职责 | 当前无兼容 Ash producer；不以现有 App Server start/stop 伪装 PTT，不扩展自有媒体系统 |
| Speech provider 注册 / TTS / keyword | 标准扩展 → 原 Host capability / 注册 / 精确代次 → MainThreadSpeech → SpeechService | 已接通真实 Node/V8 producer 与标准会话、注销和取消；dormant onSpeech、语言偏好和实际听写已验证。Desktop已完成响应的朗读、行/窗口停止、逐段Stopped与来源取消已接通；PTT、自动keyword与自动朗读仍沿实际caller前置推进，不创建自有媒体backend |

以上为已验证行为和真实前置缺口，整个 Chat 对齐仍未标记完成。继续项必须从原 Chat/agentHost 真实调用方到唯一 owner 闭合，不能从路径差异反向制造模块。

Speech provider 前置链准入：标准 vscode.speech.registerSpeechProvider → 现有 resources/extension-host/vscode.js / host.mjs → 原外部扩展 speechProvider capability/registration → 原 extensionHostApi 的 incarnation/activationGeneration 绑定 → 上游同路径 MainThreadSpeech → 原 SpeechService。Provider 唯一拥有其 STT/TTS/keyword session，宿主兼容层只拥有有界事件交付和取消 token；原 bounded invoke/read/close 机制使用 opaque session ID、精确注册和代次，不新增媒体设备/RTC/供应商或后端 Voice RPC。注册撤销和 Host 关闭取消 provider 的所有 session，迟到创建关闭，不影响另一个注册。SpeechService 的标准 provider 注册与 availability、STT/TTS/keyword 生命周期直接消费此 producer；原 Dictation 作为已有无扩展时的输入路径保留，不伪装成支持 TTS 的 provider。多扩展不按启动顺序抢占：未作选择时多个注册明确拒绝，真实读/注册状态不复制 Core 事实。

准确范围：resources/extension-host/{host.mjs,vscode.js}；crates/external-ext-protocol/src/{lib.rs,validation.rs,protocol_tests.rs}；crates/plugin/src/manifest/editor_extension.rs；crates/app-server/src/{extension_packages_editor_extensions.rs,server/extension_host_runtime.rs,server/extension_host_runtime/source.rs,server/extension_host_operations.rs}；crates/app-server-protocol/src/protocol/extension_host.rs 与正式生成物；agentHost common/extensionHostApi.ts 和 browser/extensionHostProtocol.ts；workbench/api/browser/{mainThreadSpeech.ts,mainThreadExtensionApi.ts}、Speech common/browser service 与实际输入的 availability 订阅。tests 为原 external-js-ext host 的真实标准扩展、协议注册/授权拒绝、Speech/MainThread 与输入 unit 和 browser。新的 Rust match hunk只闭合新增注册枚举的现有 consumer，不重排其他 owner。后台媒体与 provider 认证、LiveKit、agentVoice RPC 均不扩展。

Speech assembly 前置补充：双方已有 workbench/api/browser/extensionHost.contribution.ts 仅增加 ISpeechService dependency，确保注册桥创建时服务已装配；双方已有 services/extensionHost/common/extensionHostService.ts 的注册摘要 union 增 speechProvider。MainThreadExtensionApi 的 constructor/update/clear/独立 bridge skip hunk 闭合原唯一 fleet 生命周期。原 extensionHost assembly 单测注册真实 SpeechService(undefined)，无替代 provider。

真实 JS Host 验证发现 crates/external-js-ext/src/runtime.rs 的 existing Invoke 操作 allowlist 尚未接通新注册，Host 会拒绝 createSpeechSession。新增准入仅为该 match 的四个原 bounded invoke 操作，不改变 runtime authority、进程、watchdog 或媒体能力。

Speech options 边界补充：扩展拥有 microphone/recognition options，不能给它显示原 Dictation backend 的设备选择。原 SpeechService.getOptions 返回 undefined 表示这条 session 没有由本服务管理的设备设置，原 onboarding/settings 的同一 options hunk 隐藏该选择器并订阅 availability；不增加配置字段或 provider 设置。trial 自己积累标准 final phrase，避免把标准事件重新变成累计文本。范围追加原 dictationSettingsContent.ts/options hunk、原 table.integration.ts/spec.ts 的真实 Chat/Editor 两种输入与中文验证。

真实 Speech UI 发现的编辑前置：连续 final phrase 在 ChatInputEditor.insertText 中倒序，因为原 executeEdits 没有提供 endCursorState；普通 EditorDictation 原 target 也有相同缺口。双方已有 Chat/widget/input/chatInputEditor.ts 与 codeEditor/browser/dictation/editorDictation.ts 仅在原 dictation edit hunk 用原 editor 的逆向 edit range 计算尾部 selection，保持选区、模型、undo 唯一 owner；不改变 CodeEditor 底座或全局编辑语义。原 table browser 验证两句中文、拉丁分隔、原选区替换和undo。

Speech runtime 验收补充准入：resources/extension-host/node.test.mjs 原独立 Node control socket fixture 增标准 Speech 注册/会话/异步创建取消/overflow 测试；crates/external-js-ext/tests/host.rs 已验证的是 Rust/V8 Host，不混称 Node。docs/editor-extensions.md 仅在已支持接口表与对应边界说明补本能力，明确 speechProvider ceiling 和 provider-owned media，不改架构目标。

Speech 市场包前置准入：标准 Open VSX JS deployment 当前只有旧固定 capability 列表，新 speechProvider 只能通过 Plugin 显式 capability 声明接入。准确修改已在范围内的 extension_packages_editor_extensions.rs 原市场 discovery hunk：仅 package.json enabledApiProposals 明确包含 speech 时请求 speechProvider，送入原 exact package/admission binding；声明无效使该包 activation failure，不能扩展所有包的默认 ceiling。原 sibling tests 新增有/无/非法声明的 bounded manifest 行为测试。既有原 ActivationPlan 不承担 provider registry，不增加媒体配置或状态 owner。

Speech 注册链当前验收：真实 Node control socket 全25项通过（含标准 Speech session、异步 factory token 取消与有界 overflow）、Rust/V8 Host Speech2项与 ceiling/重复身份协议1项通过；原 App Server 检查通过，市场 speech proposal 请求1项通过，协议130+2+1项与生成客户端/Renderer 检查通过。实际 Chromium11项验证 Chat/普通 Editor 两句插入、选区/undo、试录中文与 provider设备选项边界，含原 Terminal写入/隐藏取消。最新早完成 session 定向同编译选项18项通过；完整unit被同步 Terminal environment contract 测试未迁移阻断，未把旧101项作最新全部通过。无新增 microphone、player、RTC、模型或Voice RPC。

下一前置准入：用户首次听写 → SpeechService读取原 ExtensionService 已提交的 speechProviders 描述 → 原 activateByEvent('onSpeech', signal) → 原 AppServerExtensionHostService精确 dormant owner → agentHost activation DTO/source代次 → MainThreadSpeech注册 → 原会话。声明事实唯一保留于 ExtensionService committed manifests，Speech直接读取而不再存 descriptor副本；新窗口生命周期订阅仅更新 availability。只有声明需要激活时等待，取消/断连/代次变更不启动 fallback microphone；无法注册的已声明扩展返回明确失败，不偷偷回落旧 Dictation。原无扩展 Dictation输入保留。

准确路径/hunk：双方已有 speech/browser/speechService.ts 的声明验证、constructor依赖/availability/getOptions/getPreparation和acquisition前置；双方已有 services/extensions/common/extensionManifest.ts 的 speechProviders字段/原parser边界；双方已有 services/extensionHost/browser/appServerExtensionHostService.ts 的 selectActivationEvent；双方已有 agentHost/common/extensionHostApi.ts 的typed Speech activation；现有 Rust extension_host.rs DTO、extension_host_operations.rs validation/conversion、extension_host_runtime/source.rs match与source_tests.rs；原 extension_packages_editor_extensions.rs activationPlan从真实speechProviders产生onSpeech。测试仅上述原parser/activation/service/assembly，以及test/common/testDictationServices.ts注入真实 TestExtensionService 与已有 table/browser调用。公开 ISpeechProviderDescriptor(name,description)与speechProviders职责取自上游声明；只取 onSpeech activation 行为证据，不复制其内部 descriptor map。必须验证真正 dormant→registered 的Host与UI、取消、未授权、无fallback和非默认语言。

Speech dormant 前置已闭合：原 ExtensionService committed manifest 直接提供 speechProviders(name,description)，原 onSpeech / Plugin onDemand:speechProvider 精确激活，MainThreadSpeech注册真实provider。acquisition等待回到同一个Recording，Started仍只由provider实际事件发出；取消中不启用fallback。当前联动unit95项、实际Chromium14项（en/zh、注册与首次activation/cancel、Chat与普通Editor、原录音与试录）通过；Rust声明/请求/match3项通过。共享Terminal fixture恢复后，原隐藏输出与dictation2项浏览器通过；没有改其生产代码来绕过失败。最新Node26项通过（含同步任务新增的一项），JS all-target warnings通过；完整Chat/agentHost回归继续。

消息复制切片准入：用户激活原Chat/Cowork消息行Copy → 原共享ChatListWidget拥有DOM/当前item → 上游同路径browser/actions/chatCopyActions.ts的registerChatCopyActions与标准workbench.action.chat.copyItem → 原IClipboardService写入当时可见的原始文本。Thread/agentHost拥有消息事实，命令不复制数据owner；不读DOM HTML、不导出私有metadata、不发送模型请求。按钮属于原行、命令执行使用点击时immutable文字，来源移除只释放反馈/监听器，迟到回包不写新行。
准确范围：缺失但上游存在的chat/browser/actions/chatCopyActions.ts只注册实际copyItem操作；双方已有chat.contribution.ts仅装配注册；已确认Ash的widget/chatListWidget.ts仅增加消息行copy按钮/反馈，原Owned CSS只增加footer布局；原chatListWidget.test.ts / chatCodeblockActions测试同类真实命令验证与已有chatTranscript.integration.ts/spec.ts增加Chat/Cowork、流式当前值、移除与异步、en/zh、主题/窄宽度/键盘回归；chat.json与原AccessibleHelp同步。ICommandService直接构造注入，剪贴板仍由窗口平台owner提供。没有复制上游CopyActionViewItem内部实现，也不提前造copyAll/sessionLink的全局widget查找端口。

消息复制最小切片：20项mapper/list/hook unit、真实4项Chromium（Chat/Cowork×en/zh-CN，三主题、220px、键盘焦点、当前原始Markdown、异步校正与权限失败、行移除）通过；CSS0错误，仅原3项字体role建议。复制命令与footer沿原贡献和行owner，没有全局widget状态、模型发送或额外媒体API。空消息按钮禁用，正在复制不禁用原生按钮以保留焦点；item变化时旧回包不显示新文字的成功反馈。继续全链回归，整个Chat未标记全部完成。

全Chat回归发现早完成consumer前置：原dictationSession在全局Idle时先清active，即使它尚在等待自己session的bounded receipt，丢失早期final/error。准确改其原state/start/subscribe hunk：未订阅时由自己的Stopped receipt结束，而非另一层状态通知；旧listener在新start前释放，订阅期间同步结束时不再持有已释放的句柄。原chatInputPart测试用现有输入变化/通知事件观察结果，退出固定两次microtask的ready猜测；不增加生产测试端口或另一个recording状态。

Speech metadata 准入补充：MainThreadSpeech 的 metadata.extension/displayName 描述公开扩展，RPC invocation 仍使用原 Core runtime owner ID，两者不能混用。准确增加原该文件对 IExtensionService 的 constructor依赖，从其 committed catalog 的 packageSha256+version读取公开身份/名称；无对应声明目录的独立Host保留原runtime身份。不存第二份目录、不据公开名字反向选择Host、不增加DTO。原 mainThreadSpeech.test.ts增加真实TestExtensionService committed manifest与不同执行ID的验证，确保调用仍绑定原runtime/代次。

Speech availability 职责修正准入：标准 ISpeechService.hasSpeechProvider 只表示注册/声明的 Speech provider，不能以原仅STT的Dictation backend冒充TTS/keyword provider。准确改其原getter/createSTT guard；原DictationSession、onboarding、settings在原constructor读取已存在optional IDictationService，仅为其旧听写可用性/设备界面，不拥有捕获状态或执行第二条capture。实际capture/flush仍唯一经过SpeechService。原ChatInputPart action消费DictationSession既有action，标准consumer读取标准hasSpeechProvider。tests明确无扩展时标准flag=false而原听写正常，现有浏览器旧录音/扩展回归都必须通过；不增加新的Speech capability getter、媒体系统或配置。

Speech语言前置准入：现有createSpeechToTextSession/createTextToSpeechSession消费已注册provider，却一直不传language；原MainThreadSpeech/Host已能递交标准options。用户语言选择 → 原IConfigurationService → 标准SPEECH_LANGUAGE_CONFIG / speechLanguageConfigToLanguage → 同一次factory的language → 原注册Host，唯一偏好owner为TypeScript settings.json（原configuration层级，RESOURCE scope与上游注册继承契约对应），不另存Provider、Rust或旧Dictation副本。auto使用当前display language，未知/不支持输入回到en-US；支持的公开locale code集合取上游公开常量，名称用Intl独立生成，不复制其实现。旧dictation.language只控制原backend，不别名或双写。
准确范围：双方已有speech/common/speechService.ts公共语言常量/转换、browser/speechService.ts在原factory hunk读取configuration并传options；双方已有accessibility/browser/accessibilityConfiguration.ts原注册owner增加该设置（不是speech.contribution）；原Speech/MainThread unit与table实际browser验证en/zh默认与明确覆盖、非法配置拒绝、相邻新session读取新值；其原fixture配置服务注册dependency，chat.json中文同步。新constructor依赖为真实IConfigurationService，不建立另一配置容器；没有新增媒体、声源、RTC或后端Voice接口。

语言前置当前验证：同编译选项独立Speech/MainThread/agentHost24项通过；实际en/zh显示语言auto与下一会话覆盖tr-TR的2项Chromium通过。完整准备曾被同步TerminalShellIntegrationEvent遗漏导出阻断，随后原任务补齐；目前完整Renderer/unit/browser再被Terminal command contract迁移中的8项不一致阻断（agentHostOutputChannel/terminalInstance/terminalEvents.test），不修改其业务或用假的兼容字段绕过。实际目标fixture同编译选项typecheck与原browser runner通过，最新全仓失败保持记录，不宣告最新全仓全部通过。

Keyword前置取消补充：标准recognizeKeyword在token预取消时返回Canceled；新增onSpeech等待也应保持同一结果，而不是因等待层改成抛错。准确补原SpeechService的keyword acquisition/factory catch，当前token取消或窗口释放返回Canceled，其他授权/注册错误仍拒绝；原Speech unit验证不创建session。没有增加keyword监听工作流或自有识别器。

取消回包与测试装配准入：完整Chat回归发现新增Speech配置依赖被注册在输入child，而Speech singleton由window parent创建。准确追加原test/common/testDictationServices.ts仅在缺失时给其原window fixture注册InMemoryConfigurationService，不修改生产DI失败语义或覆盖已有配置。MainThreadSpeech取消creation的wrapper会拒绝迟到回包，旧accepted标志因此无法清理已经创建的Host session；准确改原MainThreadSpeech.finish：等原creation调用settle后，对自己生成的session ID执行一次幂等close，无论回包成功或因取消拒绝。注册代次撤销仍由原Host负责整体释放，不能向replacement发送旧close。原MainThread测试必须观察真实close invocation、无read与 replacement不受影响；真实Node测试补已完成create后取消invoke无效而显式close释放token的窗口。没有新增媒体或RPC。

朗读前置准入：上游标准扩展TextToSpeechSession.synthesize返回void，原Chat朗读caller却顺序await Workbench ITextToSpeechSession.synthesize；目前MainThreadSpeech只await原invoke接受回包，下一段会早于真正Stopped。准确仅补双方对应api/browser/mainThreadSpeech.ts的原synthesize/deliver/finish hunk（缺失文件已在标准注册链创建）：每次实际合成在该session里拥有一个completion，先建立等待再发送原RPC，Stopped完成，Error拒绝，取消/撤销拒绝并释放，不能按RPC成功冒充播放完毕。允许下一段复用同一provider session；不新增播放器、全局朗读状态或媒体接口。公共speech/common/speechService.ts仅补Promise完成边界注释。原api/test/browser/mainThreadSpeech.test.ts通过真实请求/事件验证接受后仍pending、完成后才能下一段、错误与取消释放、void标准producer；不复制上游Event过滤器或私有controller。此层通过后再准入真实Chat朗读caller。

命令可用性前置准入：原取消听写command在Idle也被展示可执行，标准Speech扩展的菜单when条件还读不到窗口Speech状态。唯一事实仍为SpeechService registered/declared providers与原STT/TTS leases；标准HasSpeechProvider/SpeechToTextInProgress/TextToSpeechInProgress仅投给原window IContextKeyService，不保存业务副本。准确增加双方speech/common/speechService.ts的三项公共外部when契约、browser/speechService.ts constructor绑定/事件同步/释放重置；原chat/browser/actions/chatSpeechToTextActions.ts仅给原CancelDictationAction加SpeechToTextInProgress条件。原test/common/testDictationServices.ts只在fixture root缺失时注册真实ContextKeyService，原Speech测试装配同类注册并验证provider声明/退休、STT获取与取消、多个TTS token释放前不能清true、窗口释放重置。原MainThreadSpeech测试再验证实际zh-CN合成错误翻译。没有创建全局Voice媒体owner或新的动作服务；真实朗读入口仍需自己的来源/取消controller准入，不能仅注册空命令。

同一Speech前置的同步取消边界追加：发布Recording/context时已有命令消费者可同步Cancel，原start随后仍会调用backend.start。准确补原SpeechService.startRecording入口只检查它所持recording是否仍被接受/未stop，结束的旧请求不能重新获取麦克风或唤醒扩展；原Speech测试通过真实状态事件同步取消，验证factory调用数为0。只修原获取顺序，非另建状态。新MainThreadSpeech文件的长constructor/import/边界条件按相邻代码风格换行，均只属于本轮原有职责。

上述context/Cancel验证准确追加原table.integration.ts/spec.ts：测试入口只读取window原ContextKeyService并调用已注册Cancel command，已存在en/zh Speech场景验证HasSpeechProvider/识别状态随注册、开始、结束和撤销同步；onSpeech等待中通过真实命令取消，保留草稿且无fallback capture。未增加生产测试API或第二状态。

Desktop响应朗读准入：用户点击原Chat/Cowork已完成agentMessage行Read Aloud → 原ChatListWidget持有本次来源/CTS、窗口context显示标准Speech availability → 上游准确electron-browser/actions/voiceChatActions.ts的ReadChatResponseAloud / StopReadChatItemAloud标准command → 原renderAsPlaintext → 原ISpeechService / MainThreadSpeech逐段等待Stopped → 原Host扩展synthesize。唯一媒体owner仍是扩展；响应事实仍是Thread，row仅持交互取消令牌。action私有window操作准入防止同时朗读，不另存Speech capture状态。行文字/来源修正、移除、隐藏、Escape取消原CTS，迟到错误不显示新来源；完成关闭原session。仅已完成Agent回答可朗读，用户消息/流式未完成回复没有该操作；Web未装配Desktopcommand时不显示。
准确允许路径：仅VS Code的chat/electron-browser/actions/voiceChatActions.ts原路径创建两项实际Action（不添加无caller的PTT/keyword/globalStop）；双方已有electron-browser/chat.contribution.ts与已确认Sessions desktop main仅装载该动作module（独立realm原装配，模块本身唯一注册，避免重复OpenAgents command）；双方已有chat/browser/widget/chatListWidget.ts原footer、reconcile/setVisible释放hunk与Help文案，原已确认DOM/CSS布局足够不新增CSS。输入只接同进程实际CancellationTokenSource和已有IChatListItem.type/text，不接受JSON伪token；输出plaintext使用已有base renderer、每段不超过Host16384 UTF-16限制且不拆surrogate。mainThreadSpeech保持唯一Host会话/事件owner。必要test准确同路径新test/electron-browser/actions/voiceChatActions.test.ts，原chatListWidget.test.ts与chatTranscript.integration.ts/spec.ts仅加真实command、标准bridge producer、en/zh-CN、焦点/主题/窄宽度/取消/来源隔离验证；chat.json翻译与本台账同步。旧Copy/UI内容owner保持，按原accessibility/design/CSS/theming门禁验证。

朗读scope前置补充：原chatTranscript fixture的CommandService由window parent创建，旧Speech却在单widget child；该fixture必须同生产装配一样只在window注册一次SpeechService/其依赖，朗读命令才能到同一owner。不覆盖真实生产容器。反馈沿原footer独立status，原chatListWidget.css仅将既有status颜色/换行selector覆盖该新status，避免复制和朗读反馈互相覆盖；scope准确包含此hunk。

朗读窗口命令追加准入：已闭合的消息行只在其自身焦点接收Escape；焦点离开消息行后仍需要标准workbench.action.speech.stopReadAloud，真实caller为原CommandPalette。准确仅在同一voiceChatActions.ts新增上游StopReadAloud class/标准ID/f1与TextToSpeechInProgress precondition，把原私有window准入WeakSet改为持本次CTS的WeakMap；媒体与全局TTS事实仍在SpeechService，不取消其他window/非Chat owner。原同路径action unit验证两个window同读时停止仅本window；原transcript fixture/spec添加该真实command调用、中英文既有场景验证，不新增globalEscape抢占对话框、配置或媒体状态。

设置装配scope追加：全链单测确认SessionsPreferences创建真实SpeechService之前没有ExtensionService，ContextKey也在之后才注册；Workbench Settings同类fixture的Speech配置依赖也晚于创建。准确允许src/ash/sessions/test/browser/sessionsPreferences.test.ts与src/ash/workbench/contrib/preferences/test/browser/settings.test.ts，仅将原configuration/context实例提前给同window容器、补真实TestExtensionService并由原fixture生命周期释放。保留原缺服务失败断言，不将生产DI改成忽略错误或新建替代容器。

设置fixture后续验证：原Manage Hooks导航仅等待一次timer便检查pane；改等原IEditorService事件后，实际open错误明确为缺ITextFileService，先前将其判为就绪竞态不准确。准确继续原settings.test.ts同一装配fixture，用现有createTestTextFileService和同一FileService注册真实文本文件owner；仍先订阅真实active事件并断言Manage Hooks按钮存在，保留Hooks结果与安全断言，不改Hooks生产逻辑或增加sleep。

删除后测试调用链追加scope：全src/test名称扫描找到test/smoke/areas/windows/renderer-hot-reload.spec.ts仍按Cowork选择已获批准删除的旧chatListWidget.ts，实际两种widget已经共享Workbench实现。准确只把该paths.chat literal改为共享workbench路径，两种场景仍分别保留，不改HMR行为或测试期望。按smoke-tests技能验证开发Browser窗口的Cowork场景；其source写入/恢复需沿原测试已有written核对保护共享工作区。本轮无新删除。

同一HMR fixture装配追加：第一次实际运行拒绝Unknown service: agentVoiceService，其自建window容器没有注册已确认optional agentHost Voice slot，model也仍缺原onDidChangeComposer/代次契约。准确仅给该fixture注册IAgentVoiceService=undefined（明确无Voice backend）及Event.None/0的原composer生命周期，保留真实Stanza输入factory、列表/sidebar状态与hot reload断言；不放宽生产注入或模拟媒体。

HMR真实交互继续揭示旧fixture用列表第一个button聚焦却断言错误行Start a new chat；新增消息Copy后第一个button已是Copy，这不是组件丢焦点。准确仅把该fixture的聚焦查找改为既有data-item-id=error行内button，原Start a new chat焦点和键盘调用断言完整保留，避免测试把新增可访问操作当作回归。

同一HMR的Code场景需其ChatWidget原IDialogService；真实运行明确缺slot（Cowork已通过）。准确在原fixture注册现有DialogService并由scope释放，仅闭合真实DI；测试不发起确认，不借此修改任何Voice或Dialog业务。

听写启动状态准入：onSpeech等待与异步provider acquisition仍由原Recording/token持有，但原ChatInputPart.statusText把active请求立即写为Listening，早于provider Started。准确仅改双方chat/browser/widget/input/chatInputPart.ts原status hunk：原SpeechService.isStarting为true时显示本地化Starting dictation，实际Started后原Listening生效；不新存started/UI事实。原table.integration.spec.ts的en/zh真实ChatInputPart加声明激活等待→Started→窗口Cancel场景；chat.json追加翻译，保留无麦克风fallback、草稿和停止断言。其他Speech/Voice实现不改。

Speech bridge释放准入：MainThreadSpeech.clear/dispose不等同于后端registration已撤销；当前close沿已abort的binding owner会被本地阻断，不能释放仍admitted的持续会话。准确只改原MainThreadSpeech binding/session的cleanup callback：close用原精确extension/registration/incarnation/activationGeneration和新cleanup signal，独立于本地取消；服务端仍拒绝撤销/旧代次，绝不选择replacement。原MainThread测试增加bridge clear时pending TTS被取消、read被fence且原session close实际到达，旧token不影响重建来源。朗读私有window CTS map在取消时释放准入，并以CTS身份fence旧finally，不能迟到擦除同window的新操作。原action test验证被取消的旧provider promise仍未settle时可以起新操作、旧回包不能清除新Stop owner。无新的媒体、服务或公开API。

当前真实结果：完整Chat268项/37文件、Speech/MainThread/Extensions/原两种设置与Sessions264项/7文件、完整agentHost164项/14文件通过；完整Transcript/Webview93项Chromium通过，Speech/Editor/Terminal原20项通过。最新bridge清理/取消identity与Starting状态之后，全仓准备被共享Sessions Workbench的ILogService→ILoggerService装配缺createLogger阻断，未把旧全量结果当作最新全仓通过。相同编译选项的受影响Speech/MainThread/朗读/agentHost decoder36项与实际Chat/Cowork×en/zh朗读、Chat启动状态6项Chromium最新通过；原ChatInputPart36项通过。shared Chat hot reload的实际开发Browser两个场景（Code/Cowork）通过，原焦点、滚动、折叠、Stanza selection与sidebar状态保留，source已由原owner保护恢复。Node完整27项（含已完成create后普通cancel无效、精确close幂等与另一session隔离）通过；前述Rust/V8与后端/protocol验证保持，其源不因本轮UI扩展而改变。

继续调查的真实前置：标准Speech注册当前由原Host sealActivation冻结，host.mjs register显式只允许activating；晚于activate的注册及其向后端fleet的即时增删尚无原admitted registry更新端口，不能把前端轮询或另一张provider表当作完整动态注册。标准Voice/hold命令还需要实际聚焦Chat widget与输入生命周期的准确IChatWidgetService调用链，原ChatWidget/Cowork不是上游SessionResource模型，不能从全量public成员差异造同名facade。PTT/audio/session-context完整VoiceClient仍缺兼容producer；App sampling/双向App tools仍需原Core-owned能力。整个Chat/Speech与agentHost对齐保持进行中，不因路径计数或本轮朗读链闭合而标记全部完成。

共享Logger装配已由原任务恢复，最新Renderer3846文件再次通过；重新用原完整测试入口收尾，而不是保留隔离编译作为全仓通过的替代。所有本轮触及14项TS格式通过，原footer CSS0错误，仅原3项字体role建议；旧已删除Voice/Cowork调用链的src/test引用扫描为0。

朗读不可用状态scope追加：通用Button的author display:inline-flex可覆盖浏览器hidden默认样式。准确只在已确认原chatListWidget.css为原footer child button[hidden]添加display:none，不改Base/其他按钮。原transcript Copy场景明确Web无Desktopcommand不显示朗读；朗读场景追加provider撤销后真实UI隐藏，沿原bridge/ContextKey事实不另存availability。fixture仅增加原bridge.clear入口，无新的产品API。最新全量unit又被共享terminalRecorder.test.ts的commandExecuted缺cwd字段阻断；新朗读/清理受影响36项与实际6项已通过、Renderer已恢复通过，不把该外部失败计为通过。

全量结果更新：原完整入口Chat269项/37文件、Speech/MainThread/Extensions/Settings/Sessions265项/7文件均通过。最新browser为91通过/2失败，均为Cowork原持久Terminal只读预览；共享Terminal的ShellIntegrationAddon新增ITerminalLogService依赖，fixture尚未装配。准确只改原chatTranscript.integration.ts的window服务装配：同一既有LogService实例同时注册其真实ILoggerService角色，原window注册真实TerminalLogService；不改Terminal生产实现、预览断言、协议或业务配置。共享Source事实不从缺注入推断功能缺失，修好后验证原两个中英文immutable preview。

最终本轮验证：原完整Chat269项/37文件、Speech/MainThread/Extensions/Settings/Sessions265项/7文件、agentHost164项/14文件；完整Transcript/Webview93项、Speech/Editor/Terminal22项Chromium、实际Code/Cowork开发HMR2项通过。Node控制通道27项通过。最新Renderer3846文件、协议1477文件、触及TS格式、CSS0错误与diff check通过；CSS保留原3项字体role建议。前述Logger/cwd/Terminal preview fixture失败均留有日志，最终对应原完整入口已恢复通过，未放宽业务或结果断言。清理/朗读取消identity36项同编译选项验证在恢复前先独立通过。

当前可恢复源码快照：.build/chat-alignment/chat-speech-validated-slices-20261013（62个准确文件及manifest SHA256，7个已批准删除路径均不存在；whole-file快照可能含共享同路径任务变化，不允许盲目恢复）。库存123/971/104/19/867仅为当前路径关系，HTML已改为纯事实清单，行为结论以本台账为准。没有commit、push、Git索引或工作树替换；整个Chat/Speech/agentHost对齐仍不宣告完成。
