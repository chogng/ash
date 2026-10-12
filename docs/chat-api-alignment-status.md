# Chat 文件与 API 对齐状态

只读参照：`../vscode/src/vs/workbench/contrib/chat`，提交 `f2d375b9623eb7245db28d3a7dab1c9fb3dddb0f`。范围为生产 `.ts` / `.css`，排除测试、图片与文档。

| 源码文件 | Ash | VS Code | 同路径 | 仅 Ash | 仅 VS Code |
| -------- | --: | ------: | -----: | -----: | ---------: |
| 首次审计 |  95 |     965 |     72 |     23 |        893 |
| 当前     | 105 |     965 |     83 |     22 |        882 |

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

## 等待准确路径决定的迁移

- `browser/widget/input/chatCommandCompletion.ts` 与 `chatSkillCompletion.ts`：现有生产调用各 2 个文件。拟将两种 Stanza provider 合并到上游对应 `browser/widget/input/editor/chatInputCompletions.ts`，保留 catalog 和选区行为，同批迁移生产与测试 import。
- `browser/chatEditing/chatEditing.contribution.ts`：2 个生产入口。拟把服务和 overlay 注册移回 `browser/chat.contribution.ts`；Sessions 已装载该入口，移除其重复 import。

三旧路径均由 Git 跟踪；完整迁移预览在 `.build/chat-alignment/owner-migration-preview.patch`。尚未收到准确删除确认，因此没有删除、隐藏或改动候选及其调用链。新增语音平台归属的决定见下方语音设计。

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

下层设计供用户决定：新增 `src/ash/platform/voice/common/voiceService.ts`（前端异步 start/stop/interrupt、会话状态与转写的领域契约）和 `src/ash/platform/voice/browser/appServerVoiceService.ts`（生成协议适配）；App Server 的 `voice_operations.rs` 使用现有 `voice-agent` / `model-provider` / 音频运行时。标准 Chat 的语音状态、播放和操作落到上游对应的 `common/voiceClient/voiceClientService.ts`、`common/voicePlaybackService.ts`、`electron-browser/actions/voiceChatActions.ts`。

start 绑定调用连接、目标 Thread 和媒体代次；stop 只关闭该会话，interrupt 淘汰该代次的待播及迟到音频。房间成员变化、断线、关闭和重启均释放麦克风与模型连接。任务委托仅经 Core 的现有授权入口执行，混音转写不推断请求人；文本记录进入现有线程 owner，不创建另一套 Chat 历史。验证需覆盖真实媒体桥、协议模拟供应商、迟到音频、权限与 Core 委托；真实账户音频质量与计费另作验收。新增 Ash 平台 owner 尚未获准确路径决定，当前未创建这些文件或启用按钮。

### Prompt 语法与响应内容

已接入的正文、补全、Hover 和代码块操作见上方完成项。Prompt 尚未具备完整 YAML AST、编辑诊断、值补全与引用解析；当前后端 Skill catalog 继续拥有有效性、版本和权限判断。不能用前端根级键提示冒充完整 Prompt 语言服务。

响应仍需继续核对工具进度与结果、引用、图片/音频附件、终端、可交互 MCP 内容和增量渲染。现有 `ChatHookContentPart`、provider 链接装饰、Advisor 和编辑审核保持原 owner；本轮只接入真实调用链需要的 Markdown/代码块职责，不把其他缺失 content parts 计为完成。

### 其他目录中的已有职责

会话 UI 在 `src/ash/sessions/browser/chatViewPane.ts`，自动化 UI/契约在 `contrib/automation` 与 `platform/automation`，执行与持久领域状态由 Rust 共享后端拥有。尚未把这些能力当作 contrib/chat 文件缺失而新建竞争 owner。
