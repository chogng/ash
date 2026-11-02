# Chat 工具调用组件对应

本轮以本地只读 VS Code checkout 的 `src/vs/workbench/contrib/chat/browser/widget/chatContentParts/toolInvocationParts` 为参照。当前提交覆盖 18 个同路径文件，另外 14 个上游路径没有对应的完整生产契约。没有仅 Ash 文件。表中“已接入”只表示当前 Ash 生产链路的职责已由对应组件承担；完整公开 API、数据模型和上游全部功能仍有明确缺口。

## 当前生产链路

Thread transcript 是执行状态的唯一 owner。[视图模型](../src/ash/workbench/contrib/chat/common/model/chatViewModel.ts) 按 Turn 和调用标识关联执行开始、等待交互、输出及结果，并投影为公共 [IChatToolInvocation](../src/ash/workbench/contrib/chat/common/chatService/chatService.ts) 只读快照。进度、输出和工具判定直接消费此契约，不另存执行状态。列表渲染器创建 [ChatToolInvocationPart](../src/ash/workbench/contrib/chat/browser/widget/chatContentParts/toolInvocationParts/chatToolInvocationPart.ts)，后者组合稳定的状态展示、结果、图片和 MCP App。

- [ChatToolProgressSubPart](../src/ash/workbench/contrib/chat/browser/widget/chatContentParts/toolInvocationParts/chatToolProgressPart.ts) 拥有详情 disclosure、状态图标及来源描述；更新正文时保留展开和焦点。
- 命令进度通过后端 binding 展示命令与目录，复制保留参数边界；原有 Side Chat owner 接收解释请求。自动展开只消费实际执行／输出／完成事件，用户操作后保持其选择。
- [ChatToolOutputSubPart](../src/ash/workbench/contrib/chat/browser/widget/chatContentParts/toolInvocationParts/chatToolOutputPart.ts) 拥有输入输出、媒体及资源动作的组合生命周期；共享文本组件继续保留原始证据和流式选区。
- 输入 owner 捕获真实交互标识，检查可见性、AI 开关、提交状态及允许决策。[AbstractToolConfirmationSubPart](../src/ash/workbench/contrib/chat/browser/widget/chatContentParts/toolInvocationParts/abstractToolConfirmationSubPart.ts) 统一能力范围、动作及控件生命周期；[ToolConfirmationSubPart](../src/ash/workbench/contrib/chat/browser/widget/chatContentParts/toolInvocationParts/chatToolConfirmationSubPart.ts) 呈现普通原因，[ChatTerminalToolConfirmationSubPart](../src/ash/workbench/contrib/chat/browser/widget/chatContentParts/toolInvocationParts/chatTerminalToolConfirmationSubPart.ts) 呈现精确 argv 和沙箱拒绝证据。领域 adapter 保留后端已有的拒绝原因、退出状态及按时间捕获的输出；安全重试仍是执行前授权，不能代替执行结果复核。按钮和快捷键仅提交后端提供的决策，退休按钮不能回答后继请求。
- 列表拥有 `chatContentParts/chatImageGenerationBatchPart.ts` 的稳定批次生命周期和画布移交，工具行借用其展示。同一 Turn 内连续图片调用的成功结果合并到最后一个调用的画廊；其他消息、普通工具和 Turn 边界中断批次。追加调用、迟到结果及原行移除保留已有画廊、预览和键盘焦点；每个结果保留自己的 source 和原始 contentIndex。
- [ChatMcpAppModel](../src/ash/workbench/contrib/chat/browser/widget/chatContentParts/toolInvocationParts/chatMcpAppModel.ts) 拥有 Webview、握手、授权代理、结果交付、异步请求和取消。[ChatMcpAppSubPart](../src/ash/workbench/contrib/chat/browser/widget/chatContentParts/toolInvocationParts/chatMcpAppSubPart.ts) 拥有控制按钮、viewport 和可见性 attachment。隐藏列表或折叠工具详情释放 iframe、上下文和原请求；重显按原 artifact 身份复用已读取文档，重新握手并保持外部焦点。断线使缓存失效，来源替换创建新模型。

上述实现来自现有 Ash owner 和生命周期。组件继续消费 Ash 领域值；构造参数及视图更新接口与上游的 `IChatToolInvocation`／`IChatContentPartRenderContext` 体系仍不同。`chatContentParts.ts` 的 `IChatContentPart` 已贯通列表投影与组件自己的 `hasSameContent`，Markdown 登记实际代码块并由列表通过 `IChatCodeBlockInfo` 导航；调用身份或 Turn 变化会退休旧工具组件。工具原始文本没有 codeblocks 编辑器。审批身份与提交仍由输入 owner 校验，工具条目没有独立内联审批入口，不能用转发到当前输入的 `acceptConfirmation` 代替准确调用关联。`McpAppLoadState` 向视图交付真实加载错误，错误保留在原 App 中，键盘重试重新读取同一来源。

## 全目录对应

| 上游路径                                        | 当前结论与前置条件                                                                                                                                                                           |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chatToolInvocationPart.ts`                     | 已接入组合分派与内容等价契约；完整渲染上下文和内联确认接口仍依赖工具调用模型。原始文本工具不登记不存在的代码编辑器。                                                                         |
| `chatToolProgressPart.ts`                       | 已接入后端证据驱动的状态、来源、展开和高度通知；不推断完成。                                                                                                                                 |
| `chatToolOutputPart.ts`                         | 已接入原始输入输出、媒体和资源生命周期；上游编辑器池、富输出协议未对齐。                                                                                                                     |
| `chatToolPartUtilities.ts`                      | 已接入图片身份、活跃状态和连续批次判定；其余公开工具判定缺少对应领域输入。                                                                                                                   |
| `chatImageGenerationProgressPart.ts`            | 已接入动画层；批次展示、可见性和画布移交由列表拥有的 `ChatImageGenerationBatchPart` 统一管理，没有并行的工具级结果 owner。                                                                   |
| `chatGeneratedImageResultSubPart.ts`            | 已接入成功结果快照、计数、批次末调用及共享画廊；原图坐标、预览和下载由原媒体 owner 保持。上游缩略图选择与全部公开 helper 尚未实现。                                                          |
| `chatMcpAppModel.ts`                            | 已接入协议、Webview、attachment 和加载错误状态契约；App 向 Agent 提供工具的发现、注册及隐藏保留契约仍缺失。                                                                                  |
| `chatMcpAppSubPart.ts`                          | 已接入视图控制、模型投影和隐藏通知；使用 Ash Webview 服务。                                                                                                                                  |
| `chatToolConfirmationSubPart.ts`                | 已接入当前审批 offer 的内容和动作；提交身份仍由输入／会话 owner 检查。                                                                                                                       |
| `chatToolInvocationSubPart.ts`                  | 已接入共享 DOM 释放与高度事件基类；普通进度、输出和命令进度使用同一生命周期契约。                                                                                                            |
| `abstractToolConfirmationSubPart.ts`            | 已接入普通／终端审批共用的动作与释放 owner，只展示后端提供的决策；上游编辑器及完整 action 配置契约仍有缺口。                                                                                 |
| `chatSimpleToolProgressPart.ts`                 | 尚缺 simple／hidden 等明确 presentation 元数据；当前调用使用稳定详情展示。                                                                                                                   |
| `chatToolStreamingSubPart.ts`                   | 尚缺参数流阶段和相应状态契约；当前参数值在原详情中更新。                                                                                                                                     |
| `chatInputOutputMarkdownProgressPart.ts`        | 尚缺分类型 Markdown 输入输出与编辑器池接口；当前工具输出按原始文本显示。                                                                                                                     |
| `chatResultListSubPart.ts`                      | 原资源列表由 ChatResourceGroupWidget 承担；上游文件列表结果类型与 pool 契约尚缺。                                                                                                            |
| `chatTerminalToolProgressPart.ts`               | 已接入 binding 中的精确程序、JSON argv、工作目录、复制及原始输出；不伪造集成终端实例或后台进程标识。                                                                                         |
| `chatTerminalToolConfirmationSubPart.ts`        | 已接入精确 argv、沙箱拒绝证据、退出状态及旁聊解释；提交仍由原输入按 offer 身份检查。                                                                                                         |
| `chatTerminalToolExplanation.ts`                | 已接入现有 Side Chat 服务，从审批的原会话解释精确命令；保留草稿及审批，隐藏或替换原 offer 会取消旧请求。                                                                                     |
| `terminalToolAutoExpand.ts`                     | 已接入执行开始、真实输出及完成事件；输出延迟 50ms 展开，快速完成取消。成功后收起自动展开的详情，用户操作优先；失败展开由 WINDOW boolean 设置 chat.tools.autoExpandFailures 控制，默认 true。 |
| `chatToolConfirmationCarouselPart.ts`           | 当前会话提供单个 pendingInteraction；尚缺同时展示多个待确认工具的集合 owner。                                                                                                                |
| `chatToolPostExecuteConfirmationPart.ts`        | 当前审批契约不包含执行后复核阶段。                                                                                                                                                           |
| `chatToolAuthenticationSubPart.ts`              | MCP 身份验证由原连接 owner 处理；尚缺工具调用内认证 offer。                                                                                                                                  |
| `chatOtherClientToolProgressPart.ts`            | dynamicTool 等待已有状态展示；尚缺远端客户端身份及可授权 skip 操作。                                                                                                                         |
| `chatSandboxPrerequisiteConfirmationSubPart.ts` | 当前权限请求使用已有目录／网络授权；尚缺沙箱依赖安装或修复 offer。                                                                                                                           |
| `chatModifiedFilesConfirmationSubPart.ts`       | Ash 文件变更以 Turn／checkpoint 为 owner；尚缺工具结果级别的 modified-files 确认 offer。                                                                                                     |
| `chatAgentFeedbackReviewConfirmationSubPart.ts` | 尚缺对应的 feedback-review 确认 offer 和提交契约。                                                                                                                                           |
| `chatExtensionsInstallToolSubPart.ts`           | Ash 使用独立扩展 SDK 与安装流程；尚缺对应工具 offer，不能接入 VS Code 扩展安装服务。                                                                                                         |
| `chatAutomationConfiguredResultSubPart.ts`      | 配置工具结果仍走原结果展示；尚缺可导航的结构化 automation 结果领域类型。                                                                                                                     |
| `chatSessionTargetResultPillSubPart.ts`         | 尚缺结构化 session-target 结果及其原会话导航上下文。                                                                                                                                         |
| `toolRiskBadgeHelper.ts`                        | 将策略评估投影到当前审批；Core 在持久 offer 前核对 action digest 与 policy revision，风险展示不授予执行权限。                                                                                |
| `toolRiskBadgeWidget.ts`                        | 已接入后端风险等级与原文原因，使用键盘可展开的稳定原生详情组件。                                                                                                                             |
| `media/toolRiskBadge.css`                       | 已接入独立编写的 Ash 样式、主题 token、焦点及高对比边框。                                                                                                                                    |

## 验证边界

Ash 的定向测试覆盖真实列表入口、审批输入、媒体资源和 iframe 边界。上游相关测试用于确认连续批次、结果保留、隐藏 iframe 与协议生命周期的可观察目标；本轮没有运行上游产品，跨产品同场景运行验证仍未完成。风险组件使用独立编写的 Ash CSS，其余组件沿用现有 Ash root 和主题 token；没有复制上游样式。

本轮最终验证结果：

- 工具呈现 15 项、图片 28 项、列表 41 项及交互 adapter 10 项测试完成并通过；审批定向命令单独通过 19 项，包含新增的命令解释取消和风险证据。覆盖中英文、四种主题、窄屏、选区、展开、焦点、迟到结果及沙箱拒绝证据。按钮和快捷键均不能提交未提供的决策，退休控件不能回答后继请求。包含完整输入套件的扩大运行因范围外 Voice DI 断言失败及耗时被中止；不记为整组通过。
- 44 项 MCP iframe 集成测试通过：隐藏／重显、取消、迟到响应、来源隔离、上下文、媒体、CSP、日志、下载及 fullscreen。
- 3 项 macOS Ash Desktop／App Server 自托管测试通过：真实命令的两种审批策略，以及图片生成、下载和恢复。首次退出失败定位到 Sessions scope 晚于借用存储释放；在窗口 owner 中修正注册顺序后，同组场景全部通过。
- Renderer 类型检查、任务文件格式、diff 空白检查及上述中英文定向场景通过。全局单元测试编译曾被范围外账号接口改动阻塞；提交门禁的范围外格式失败单独报告，不记为通过。
- 策略 15 项、Core 审批 5 项、领域协议 62 项、App Server 协议 177 项及 schema hash 2 项测试通过；相关 Rust check 和 warnings 检查完成。风险字段可选，旧审批记录继续按无评估读取；action digest 与 policy revision 的关联仍由 Core 核验。


对应命令：

```sh
pnpm test:unit --run src/ash/workbench/contrib/chat/test/browser/widget/chatContentParts/chatToolInputOutputContentPart.test.ts --run src/ash/workbench/contrib/chat/test/browser/chatImageGeneration.test.ts --run src/ash/workbench/contrib/chat/test/browser/chatListWidget.test.ts
pnpm test:unit --run src/ash/platform/agentHost/test/browser/appServerInteractionOffer.test.ts --run src/ash/workbench/contrib/chat/test/browser/chatInputPart.test.ts --grep 'approval|Approval|Retired answer|interaction'
pnpm test:browser:integration chatTranscript.integration.spec.ts --project=chromium --grep 'MCP App|MCP Apps'
pnpm test:smoke:desktop test/smoke/areas/chat/chat-tool-output.spec.ts test/smoke/areas/chat/chat-image-generation.spec.ts
```
