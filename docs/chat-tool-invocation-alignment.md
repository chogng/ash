# Chat 工具调用组件对应

本轮以本地只读 VS Code checkout 的 `src/vs/workbench/contrib/chat/browser/widget/chatContentParts/toolInvocationParts` 为参照。文件对应与每项真实生产契约见下表；同路径文件存在不代表完整功能已对齐。表中“已接入”只表示当前 Ash 生产链路的职责已由对应组件承担；完整公开 API、数据模型和上游全部功能仍有明确缺口。

## 当前生产链路

Thread transcript 是执行状态的唯一 owner。[视图模型](../src/ash/workbench/contrib/chat/common/model/chatViewModel.ts) 按 Turn 和调用标识关联执行开始、等待交互、输出及结果，并投影为公共 [IChatToolInvocation](../src/ash/workbench/contrib/chat/common/chatService/chatService.ts) 只读快照。进度、输出和工具判定直接消费此契约，不另存执行状态。列表渲染器创建 [ChatToolInvocationPart](../src/ash/workbench/contrib/chat/browser/widget/chatContentParts/toolInvocationParts/chatToolInvocationPart.ts)，后者组合稳定的状态展示、结果、图片和 MCP App。

- [ChatToolProgressSubPart](../src/ash/workbench/contrib/chat/browser/widget/chatContentParts/toolInvocationParts/chatToolProgressPart.ts) 拥有详情 disclosure、状态图标及来源描述；更新正文时保留展开和焦点。
- 命令进度通过后端 binding 展示命令与目录，复制保留参数边界；原有 Side Chat owner 接收解释请求。自动展开只消费实际执行／输出／完成事件，用户操作后保持其选择。
- [ChatToolOutputSubPart](../src/ash/workbench/contrib/chat/browser/widget/chatContentParts/toolInvocationParts/chatToolOutputPart.ts) 拥有输入输出、媒体及资源动作的组合生命周期；共享文本组件继续保留原始证据和流式选区。
- 输入 owner 捕获真实交互标识，检查可见性、AI 开关、提交状态及允许决策。[AbstractToolConfirmationSubPart](../src/ash/workbench/contrib/chat/browser/widget/chatContentParts/toolInvocationParts/abstractToolConfirmationSubPart.ts) 统一能力范围、动作及控件生命周期；[ToolConfirmationSubPart](../src/ash/workbench/contrib/chat/browser/widget/chatContentParts/toolInvocationParts/chatToolConfirmationSubPart.ts) 呈现普通原因，[ChatTerminalToolConfirmationSubPart](../src/ash/workbench/contrib/chat/browser/widget/chatContentParts/toolInvocationParts/chatTerminalToolConfirmationSubPart.ts) 呈现精确 argv 和沙箱拒绝证据。领域 adapter 保留后端已有的拒绝原因、退出状态及按时间捕获的输出；安全重试仍是执行前授权，不能代替执行结果复核。按钮和快捷键仅提交后端提供的决策，退休按钮不能回答后继请求。
- 执行后复核由工具显式请求，默认不拦截其他结果。`ChatToolPostExecuteConfirmationPart` 呈现已捕获的原始证据；分享／跳过仅回答原 offer，不授予执行权限。Core 在持久交互中保留候选结果，分享后提交原结果，跳过只交付未分享标记；两者均不重新执行或自动撤销修改。进程恢复后从同一候选结果继续；支持的文件修改仍通过独立 checkpoint 操作恢复。Desktop 和 TUI 消费同一领域契约。
- 列表拥有 `chatContentParts/chatImageGenerationBatchPart.ts` 的稳定批次生命周期和画布移交，工具行借用其展示。同一 Turn 内连续图片调用的成功结果合并到最后一个调用的画廊；其他消息、普通工具和 Turn 边界中断批次。追加调用、迟到结果及原行移除保留已有画廊、预览和键盘焦点；每个结果保留自己的 source 和原始 contentIndex。
- [ChatMcpAppModel](../src/ash/workbench/contrib/chat/browser/widget/chatContentParts/toolInvocationParts/chatMcpAppModel.ts) 拥有 Webview、握手、授权代理、结果交付、异步请求和取消。[ChatMcpAppSubPart](../src/ash/workbench/contrib/chat/browser/widget/chatContentParts/toolInvocationParts/chatMcpAppSubPart.ts) 拥有控制按钮、viewport 和可见性 attachment。隐藏列表或折叠工具详情释放 iframe、上下文和原请求；重显按原 artifact 身份复用已读取文档，重新握手并保持外部焦点。断线使缓存失效，来源替换创建新模型。

上述实现来自现有 Ash owner 和生命周期。组件继续消费 Ash 领域值；构造参数及视图更新接口与上游的 `IChatToolInvocation`／`IChatContentPartRenderContext` 体系仍不同。`chatContentParts.ts` 的 `IChatContentPart` 已贯通列表投影与组件自己的 `hasSameContent`，Markdown 登记实际代码块并由列表通过 `IChatCodeBlockInfo` 导航；调用身份或 Turn 变化会退休旧工具组件。工具原始文本没有 codeblocks 编辑器。审批身份与提交仍由输入 owner 校验，工具条目没有独立内联审批入口，不能用转发到当前输入的 `acceptConfirmation` 代替准确调用关联。`McpAppLoadState` 向视图交付真实加载错误，错误保留在原 App 中，键盘重试重新读取同一来源。

本次剩余 14 项已接入实际生产消费者。富审批通过冻结的 `ToolActivity::Confirmation` 声明消费证据；MCP 目录的版本化声明由后端校验，未声明工具沿用普通审批。导航通过类型化 `ToolResultPresentation` 保存于仅供视图的 artifact，不猜测模型 JSON。结果分享复核继续使用独立的持久交互；批准执行和允许披露是两个原有 owner 的不同动作。

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
| `chatSimpleToolProgressPart.ts`                 | 已接入已完成、无参数且无流／资源调用的紧凑原始结果；其他 simple／hidden presentation 元数据仍有缺口。                                                                                        |
| `chatToolStreamingSubPart.ts`                   | 已接入模型参数增量；Anthropic Messages 与 Chat Completions 的真实 delta 进入临时 transcript，最终 binding 复用同一 Item 身份。未完成参数不触发执行，历史不重播参数流。                       |
| `chatInputOutputMarkdownProgressPart.ts`        | 已接入明确声明 text/markdown 的资源预览，保留原始证据、净化内容并复用 Markdown 编辑器；完整分类型输入／编辑器池接口仍有缺口。                                                                |
| `chatResultListSubPart.ts`                      | 已接入带原始 contentIndex 的资源结果组合和计数，读取及打开继续由 ChatResourceGroupWidget 唯一拥有。                                                                                          |
| `chatTerminalToolProgressPart.ts`               | 已接入 binding 中的精确程序、JSON argv、工作目录、复制及原始输出；不伪造集成终端实例或后台进程标识。                                                                                         |
| `chatTerminalToolConfirmationSubPart.ts`        | 已接入精确 argv、沙箱拒绝证据、退出状态及旁聊解释；提交仍由原输入按 offer 身份检查。                                                                                                         |
| `chatTerminalToolExplanation.ts`                | 已接入现有 Side Chat 服务，从审批的原会话解释精确命令；保留草稿及审批，隐藏或替换原 offer 会取消旧请求。                                                                                     |
| `terminalToolAutoExpand.ts`                     | 已接入执行开始、真实输出及完成事件；输出延迟 50ms 展开，快速完成取消。成功后收起自动展开的详情，用户操作优先；失败展开由 WINDOW boolean 设置 chat.tools.autoExpandFailures 控制，默认 true。 |
| `chatToolConfirmationCarouselPart.ts`           | 已接入同一 Turn 的相邻调用浏览；仅原 pendingInteraction 的控件可操作。浏览其他调用时快捷键不提交，返回当前审批保留原 offer。Ash 策略审批仍串行，不另造多 pending owner。                     |
| `chatToolPostExecuteConfirmationPart.ts`        | 已接入工具显式请求、原结果预览、分享／跳过、准确 offer 提交和持久恢复；跳过不撤销副作用，恢复不重新执行。                                                                                    |
| `chatToolAuthenticationSubPart.ts`              | 已接入冻结的 authentication 展示声明；登录只调用绑定来源宿主的 MCP 服务，隐藏／替换取消；登录成功不自动批准执行。                                                                            |
| `chatOtherClientToolProgressPart.ts`            | 已接入 dynamicTool 原始参数和跳过动作，失败结果使用原 callId／offer 提交；退休或隐藏控件不能回答。                                                                                           |
| `chatSandboxPrerequisiteConfirmationSubPart.ts` | 已接入类型化依赖与修复证据，决策仍回答原策略审批；视图不执行安装或修复。                                                                                                                     |
| `chatModifiedFilesConfirmationSubPart.ts`       | 已接入类型化文件路径、原文与提议内容；只读区域保留字面证据，实际修改仍属于工具与 checkpoint。                                                                                                |
| `chatAgentFeedbackReviewConfirmationSubPart.ts` | 已接入类型化反馈证据与原策略审批，不能将提议文本转换为新的执行权限。                                                                                                                         |
| `chatExtensionsInstallToolSubPart.ts`           | 已接入类型化扩展 ID 清单，安装仍由产生调用的工具执行并受原策略控制；不引入另一套安装服务。                                                                                                   |
| `chatAutomationConfiguredResultSubPart.ts`      | 已接入版本化 automationConfigured 结果，通过原 Session 的 provider store 解析 ID 并打开原自动化编辑器；过期或未知目标失败。                                                                  |
| `chatSessionTargetResultPillSubPart.ts`         | 已接入类型化 sessionTarget；原宿主解析并打开指定会话，保留草稿。原生 spawn_agent 已产出此元数据，MCP 可声明同一契约。                                                                        |
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

执行后复核补充验证：10 项前端／真实解码器测试通过，覆盖中英文、四种主题、窄屏、键盘、无障碍视图及退休控件；Core 4 项测试覆盖分享／跳过、原失败状态、取消、调用身份、大小限制，以及决定前后重启均不重跑工具。TUI 2 项测试与中文初始／滚动末尾快照通过。MCP 输出、能力协商、扩展到 Core 的 adapter 及协议的候选脱敏测试通过。真实 Ash Desktop＋App Server 场景通过跳过、分享、未声明复核直通和重开窗口恢复，并验证模型收到的内容及文件副作用只发生一次。该场景先后发现并修复了 MCP 扩展转换丢弃复核标记、客户端未声明新交互种类两处生产缺口。

图片 25 项与列表 41 项回归通过；工具展示中新增的紧凑结果／Markdown 用例及四主题键盘展开共 6 项复验通过。原失败分别来自选中了隐藏结果节点、错误的编辑器选择器，以及键盘操作与自动展开之间的时序假设；修正的是测试入口与定位，没有放宽生产行为。

对应命令：

```sh
pnpm test:unit --run src/ash/workbench/contrib/chat/test/browser/widget/chatContentParts/chatToolInputOutputContentPart.test.ts --run src/ash/workbench/contrib/chat/test/browser/chatImageGeneration.test.ts --run src/ash/workbench/contrib/chat/test/browser/chatListWidget.test.ts
pnpm test:unit --run src/ash/platform/agentHost/test/browser/appServerInteractionOffer.test.ts --run src/ash/workbench/contrib/chat/test/browser/chatInputPart.test.ts --grep 'approval|Approval|Retired answer|interaction'
pnpm test:browser:integration chatTranscript.integration.spec.ts --project=chromium --grep 'MCP App|MCP Apps'
pnpm test:smoke:desktop test/smoke/areas/chat/chat-tool-output.spec.ts test/smoke/areas/chat/chat-image-generation.spec.ts
pnpm test:smoke:desktop test/smoke/areas/chat/chat-tool-result-review.spec.ts
just test ash-core result_review
just test-tui-unit result_review
just test ash-mcp-extension explicitly_requested_result_review
```

剩余 14 项补充验证：工具呈现 20 项与暂存源码定向 42 项测试通过，覆盖真实审批工厂、同 offer 控件保持、相邻调用只读浏览、精确客户端跳过、登录取消、导航来源、中英文、四主题、Markdown 净化及编辑器复用。参数流验证贯通两个 SSE 解码器（10 项）、Core 的执行前绑定（1 项）和 transcript 的临时／最终身份与迟到 delta 拒绝（1 项）；原生 spawn_agent 的真实执行测试验证返回的子会话元数据。协议 63 项、MCP 输出 11 项、MCP 扩展 43 项、Core 结果复核 4 项及 TUI 2 项通过。新增 macOS Ash Desktop 场景验证五类富审批、参数流、按钮窄屏换行、真实执行记录、会话与自动化结果导航；执行后复核场景验证分享、跳过及重开窗口恢复。Renderer、自动化类型检查和独立暂存源码的 Renderer 检查通过；共享工作区全量单元编译有两处范围外列表测试错误，未计为通过。
