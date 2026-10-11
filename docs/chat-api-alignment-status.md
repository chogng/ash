# Chat 文件与 API 对齐状态

只读参照：`../vscode/src/vs/workbench/contrib/chat`，提交 `f2d375b9623eb7245db28d3a7dab1c9fb3dddb0f`。范围为生产 `.ts` / `.css`，排除测试、图片与文档。

| 源码文件 | Ash | VS Code | 同路径 | 仅 Ash | 仅 VS Code |
| -------- | --: | ------: | -----: | -----: | ---------: |
| 首次审计 |  95 |     965 |     72 |     23 |        893 |
| 当前     |  95 |     965 |     73 |     22 |        892 |

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

## 实际验证

- `pnpm exec tsc -p tsconfig.renderer.json --noEmit` 通过。
- 定向 unit selection 实际执行 12 项：字体、范围校验、输入 provider 生命周期、代码块设置、自动接受与 timer 释放均通过；使用正常 `pnpm test:unit` 编译并运行。
- Chromium integration 验证 textarea 两行/三行、314px 上限、清空收缩与焦点；模型/effort 样式与描述、键盘行为分别覆盖 en/zh-CN 和 Chat/Cowork。
- Browser UI smoke 的空会话底部位置和 Stanza 向上增长两项通过。
- 触及的 TypeScript 格式、CSS stylelint 和 `git diff --check` 通过；CSS 原有 design suggestions 没有作为新错误。

## 仍未闭合的能力

### 本机 Profile 输入历史

实际调用方为 `ChatInputPart` / `ChatInputEditor`。Rust `crates/message-history` 与 `crates/state/src/message_history.rs` 已有文本输入记录、分页搜索及持久存储；TUI 从 `StateRuntime::database_path()` 打开同一 Profile 数据库。TypeScript 与 App Server 协议目前没有对应输入历史通道，不能用第二套 localStorage 或 workspace 历史冒充完成。

拟由 `src/ash/platform/messageHistory/common/messageHistory.ts` 定义异步 append/read/clear 领域契约，由 `src/ash/platform/messageHistory/browser/appServerMessageHistoryService.ts` 机械适配生成协议；两者为新增 Ash 平台归属，须按准确路径取得用户决定后实施。标准 Chat 历史展示/导航职责落到上游已有路径 `common/widget/chatWidgetHistoryService.ts`，草稿、光标和附件导航状态仍由各输入区拥有。

协议/服务必须使用本机 Profile 存储；远程执行环境不能改变输入历史归属。用户主动提交才记录，恢复/重放不记录；搜索确认只填回草稿。后端复用现有 Rust 存储，Main 保持透明 relay，消费者不导入生成 DTO。

### 语音对话

`ChatInputPart` 当前 Voice conversation action 明确禁用且回调为空。已有听写服务不能计为语音对话。需要先闭合实时 Voice 会话、音频播放、权限、取消和连接关闭契约，再接入 UI；尚未创建占位服务或按钮回调。

### Prompt 语法与响应内容

`IPromptsService` 当前主要支持 Skill 发现、管理开关和读取；`PromptFileParser` 仅分离 Markdown body。提示词语法诊断、补全等须先核对编辑器生产入口。现有 transcript 和 Chat Editing 服务已实现部分展示与审核，代码块、工具、引用等上游 content parts 需分别核对输入类型、真实操作及生命周期，不能按缺失文件数量直接建立组件。

### 其他目录中的已有职责

会话 UI 在 `src/ash/sessions/browser/chatViewPane.ts`，自动化 UI/契约在 `contrib/automation` 与 `platform/automation`，执行与持久领域状态由 Rust 共享后端拥有。尚未把这些能力当作 contrib/chat 文件缺失而新建竞争 owner。
