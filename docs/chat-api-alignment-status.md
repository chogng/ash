# Chat 文件与 API 对齐状态

只读参照：`../vscode/src/vs/workbench/contrib/chat`，提交 `f2d375b9623eb7245db28d3a7dab1c9fb3dddb0f`。范围为生产 `.ts` / `.css`，排除测试、图片与文档。

| 源码文件 | Ash | VS Code | 同路径 | 仅 Ash | 仅 VS Code |
| -------- | --: | ------: | -----: | -----: | ---------: |
| 首次审计 |  95 |     965 |     72 |     23 |        893 |
| 本批前   | 108 |     965 |     90 |     18 |        875 |
| 本批后   | 112 |     965 |     93 |     19 |        872 |

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

### 语音对话

`ChatInputPart` 当前 Voice conversation action 明确禁用且回调为空。已有听写服务不能计为语音对话。需要先闭合实时 Voice 会话、音频播放、权限、取消和连接关闭契约，再接入 UI；尚未创建占位服务或按钮回调。

已继续核实：`crates/voice-agent` 已能桥接授权人类房间音频与 `model-provider::VoiceModelSession`，但它不执行工具，尚未接入 App Server、Core 任务授权或 Chat 线程。其模型事件没有响应代次，打断播放后需要新建模型会话才能安全恢复播报。现有 `platform/call` 属于多人通话，`platform/dictation` 属于文字回填，两者的既有职责继续保留。

用户已确认下层设计：新增 `src/ash/platform/voice/common/voiceService.ts`（前端异步 start/stop/interrupt、会话状态与转写的领域契约）和 `src/ash/platform/voice/browser/appServerVoiceService.ts`（生成协议适配）；App Server 的 `voice_operations.rs` 使用现有 `voice-agent` / `model-provider` / 音频运行时。标准 Chat 的语音状态、播放和操作落到上游对应的 `common/voiceClient/voiceClientService.ts`、`common/voicePlaybackService.ts`、`electron-browser/actions/voiceChatActions.ts`。

start 绑定调用连接、目标 Thread 和媒体代次；stop 只关闭该会话，interrupt 淘汰该代次的待播及迟到音频。房间成员变化、断线、关闭和重启均释放麦克风与模型连接。任务委托仅经 Core 的现有授权入口执行，混音转写不推断请求人；文本记录进入现有线程 owner，不创建另一套 Chat 历史。验证需覆盖真实媒体桥、协议模拟供应商、迟到音频、权限与 Core 委托；真实账户音频质量与计费另作验收。两个 Ash 平台 owner 已获准确路径确认；当前继续核对房间权限、媒体释放与 Core 线程接入；尚未创建这些文件或启用按钮。

### Prompt 语法与响应内容

已接入的正文、补全、Hover 和代码块操作见上方完成项。Prompt 尚未具备完整 YAML AST、编辑诊断、值补全与引用解析；当前后端 Skill catalog 继续拥有有效性、版本和权限判断。不能用前端根级键提示冒充完整 Prompt 语言服务。

响应仍需继续核对工具进度与结果、引用、图片/音频附件、终端、可交互 MCP 内容和增量渲染。现有 `ChatHookContentPart`、provider 链接装饰、Advisor 和编辑审核保持原 owner；本轮只接入真实调用链需要的 Markdown/代码块职责，不把其他缺失 content parts 计为完成。

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
