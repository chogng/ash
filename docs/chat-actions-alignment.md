# Chat actions 职责对应

以本地只读 VS Code checkout 的 `src/vs/workbench/contrib/chat/browser/actions` 为参照。下表覆盖上游目录中的 38 个生产文件；同名文件不代表私有实现、服务模型或所有产品功能相同。

本次补齐现有 Ash owner 能真实承接的命令，修复共享注册范围及异步确认边界。Sessions 普通文档导航会显示已打开的正文，Browser host 在窗口生命周期内只创建一次。表中“上游产品集成”“无对应内容类型”“不同领域契约”是明确的行为差异，不计为已实现的上游功能。

| VS Code 文件                          | 结论                         | Ash 职责及边界                                                                                                                                                                                                                                     |
| ------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chatAccessibilityActions.ts`         | 本轮修复职责                 | 焦点切换和恢复由输入 owner 承担，action 选择可见聊天并宣布无待确认请求；不读取组件私有 DOM、不代替用户提交确认。                                                                                                                                   |
| `chatAccessibilityHelp.ts`            | 由现有 owner 承担            | 帮助内容位于输入、对话列表、Quick Chat 和 Sessions 的现有 Accessible View provider；不增加第二套 provider。                                                                                                                                        |
| `chatActions.ts`                      | 现有覆盖                     | 输入／列表焦点、历史、输入历史清理、显示方式、浏览器和设置入口；窗口策略继续由导航服务承担。                                                                                                                                                       |
| `chatAgentRecommendationActions.ts`   | 产品契约差异，保留 Ash owner | 上游读取 product.chatAgentRecommendations 并安装 VS Code 扩展；Ash 的推荐属于 Extensions 推荐服务，角色选择属于原角色目录。未把已安装角色改称推荐，也未新增没有配置来源的推荐命令。                                                                |
| `chatClear.ts`                        | 已接通编辑器原位新建         | 编辑器标题栏 New Chat 捕获旧草稿后，在同一编辑器组和位置打开新草稿；会话仍由现有 Session owner 创建，旧历史和草稿保留。                                                                                                                            |
| `chatCodeblockActions.ts`             | 本轮补齐／修复               | 复制、插入和新文件操作移至共享注册；补齐上／下代码块命令和快捷键。导航复用当前回复的真实代码编辑器。新增 Apply to editor 的真实映射与审阅链；比较块和运行代码不属于现有只读回复代码块契约。                                                        |
| `chatContext.ts`                      | 本轮修复生命周期             | 分页刷新前将焦点保留在 picker 内，避免移除焦点行导致弹窗失焦关闭。上下文来源由现有 picker 和捕获服务负责，工具引用与执行工具选择分开；不以一个相同名称命令替代来源能力。                                                                           |
| `chatContextActions.ts`               | 现有覆盖                     | 选区附加和 Add context 的文件、目录、编辑器、搜索等来源共用输入捕获与取消生命周期。上游独立来源命令并非本地第二套来源实现。                                                                                                                        |
| `chatContinueInAction.ts`             | 部分职责由现有 owner 承担    | 本机窗口 handoff 由 captureActiveDraft、ChatMoveActions 和窗口导航承担。跨提供方或 Copilot 远端任务委派没有等价契约，未宣称支持。                                                                                                                  |
| `chatCopyActions.ts`                  | 本轮补齐／修复               | 新增复制最终回复，只取已完成 final_answer 或旧格式助手文本，排除流式文本与 reasoning；复制类操作在共享入口注册。                                                                                                                                   |
| `chatDeveloperActions.ts`             | 部分契约已接通               | 输入历史、会话索引和模型检查命令在共享入口注册，分别读取原 Profile、窗口目录与连接内的 ThreadRead；日志及标准 JSON 编辑器保留草稿和会话。Trusted CA、Copilot 订阅、模型引用与最近模型清理仍缺少同类下层契约。                                      |
| `chatElicitationActions.ts`           | 本轮补齐                     | 提交当前问题表单的命令及表单内 Ctrl/Cmd+Enter；使用原生必填校验和原有回答回调，保持草稿。                                                                                                                                                          |
| `chatExecuteActions.ts`               | 现有覆盖                     | 发送、停止、编辑后重发、模型／模式／权限选择器已有真实输入 owner。上游 handoff、目标／工作区 picker 和置顶模型轮换依赖不同的提供方及 picker 策略，不添加同名空操作。                                                                               |
| `chatFileTreeActions.ts`              | 已接通快照树与标准导航       | 真实 MCP structuredContent 或 JSON 资源中的 treeData 经 common 有界还原进入原资源列表；上／下树命令展开并聚焦原 ObjectTree，键盘打开原文件，展开不重新读取目录。原 JSON、资源打开／复制和生命周期保留。                                            |
| `chatFindActions.ts`                  | 现有覆盖                     | 当前对话查找、查找选项、前后结果以及更早历史加载，复用现有查找控制器。                                                                                                                                                                             |
| `chatForkActions.ts`                  | 现有覆盖                     | 通过后端不可变 checkpoint fork；Sessions 和 Workbench 保持自己的目标策略，不在前端复制会话状态。                                                                                                                                                   |
| `chatGettingStarted.ts`               | 产品契约差异，保留 Ash 引导  | 上游在默认 Chat 扩展安装后协调欢迎界面；Ash 的独立欢迎页、Models Settings、听写及 Voice onboarding 继续使用原 owner，不接入 Copilot 安装与启用流程。                                                                                               |
| `chatImportExport.ts`                 | 本轮补齐，行为差异明确       | 导出有版本的文本记录；导入在已有只读编辑器查看。导入不会还原可执行会话、工具结果、权限、附件字节或提供方状态；不等同于 VS Code 的可继续聊天模型导入。                                                                                              |
| `chatLanguageModelActions.ts`         | Ash 模型访问入口已接通       | 标准命令列出现有模型连接，通过原 LanguageModelsService 设置／移除 API key；移除先确认，订阅连接进入原 Models Settings。取消保留聊天草稿。VS Code 扩展模型访问授权与 provider-group 迁移仍是不同领域契约。                                          |
| `chatModelFeedbackSurveyActions.ts`   | Ash 模型反馈草稿已接通       | 标准命令使用所选模型，或聚焦已完成回复的真实模型，打开原问题报告草稿。已有问题草稿不覆盖，聊天原文不自动附加，提交由用户在报告页完成。没有接入 Copilot survey／遥测／投票工具栏。                                                                  |
| `chatMoveActions.ts`                  | 现有覆盖                     | 侧栏、编辑器与新窗口交接复用窗口导航、输入草稿和挂载 owner。                                                                                                                                                                                       |
| `chatNewActions.ts`                   | 修复共享注册                 | 标准 New Chat 命令在共享入口注册，创建、显示及焦点由各窗口导航 owner 负责；现代 Agent 委派已有 sessions.newSession，保留当前产品模式及提供方策略。历史 undo／redo 和 checkpoint 恢复仍由原编辑／会话域承担。                                       |
| `chatOpenAgentDebugPanelAction.ts`    | 现有覆盖                     | 定位当前或指定 Session 的调试视图；各宿主通过自身会话归属解析，不退回错误的环境连接。                                                                                                                                                              |
| `chatPluginActions.ts`                | 管理入口已接通               | 标准 Plugins 命令在共享入口注册，复用原 Extensions 的 @plugins 查询、已安装目录、搜索焦点和键盘详情；安装状态及权限仍由原插件服务持有。安装来源和 marketplace 配置继续使用 Ash 独立生态。                                                          |
| `chatPromptNavigationActions.ts`      | 现有覆盖                     | 前后用户请求导航、当前列表与输入焦点；只访问已加载内容。                                                                                                                                                                                           |
| `chatQueueActions.ts`                 | 现有覆盖                     | 入队、steering、编辑、移除、立即发送和清空使用后端队列项标识与版本，保留草稿及附件。上游 side-chat 是不同的委派能力。                                                                                                                              |
| `chatQuickInputActions.ts`            | 现有覆盖                     | Quick Chat 开关、关闭与转到 Chat，复用借用的 Session 和草稿生命周期。                                                                                                                                                                              |
| `chatSpeechToTextActions.ts`          | 现有覆盖                     | 开始／停止／取消／按住听写，以及现有麦克风选择命令；准备、录音和文本提交由语音服务与输入 owner 负责。                                                                                                                                              |
| `chatTitleActions.ts`                 | 本轮补齐；保留后端语义       | 重试命令调用原有模型的最新可重试失败 Turn 策略。当前策略发送 Try again. 续接同一历史，并非重放原请求。Helpful／Unhelpful 和 Report Issue 没有对应反馈投递服务；不制造成功状态。                                                                    |
| `chatToolActions.ts`                  | 本轮补齐                     | 批准一次、拒绝、配置工具命令。批准通过输入 owner 传递显示中的 requestId，模型在派发前核对真实 interaction offer；隐藏或禁用的输入不提交，导航后的异步完成不夺取新焦点。没有执行后审批的领域类型，因此不注册 post-execution 确认命令。              |
| `chatToolPicker.ts`                   | 现有覆盖                     | 工具配置继续通过同一棵 QuickTree、草稿工具选择附件及输入捕获生命周期完成。                                                                                                                                                                         |
| `chatTransfer.ts`                     | 工作区信任由 Ash 原边界承担  | 上游 contribution 只触发会话转移后的 workspace trust 补正。Ash 没有同一 transfer marker；目标工作区信任仍由原工作区服务处理，窗口交接使用原导航和草稿确认，不创建第二份 trust 状态。                                                               |
| `codeBlockOperations.ts`              | 现有覆盖                     | 插入使用活动编辑器的实际模型、选区、只读状态和 undo 栈。                                                                                                                                                                                           |
| `configureVoiceInstructionsAction.ts` | Ash Profile 指令链已接通     | 两个标准命令通过普通 Markdown 编辑器编辑实际语音后端 Profile 的 voice.md／dictation.md；保存按 revision 原子提交。下一次 Voice 连接附加语音指令；支持的听写后端发送原生识别提示，当前接通 OpenAI。其他听写协议不伪造支持，不增加文字模型整理步骤。 |
| `createPluginAction.ts`               | Ash Skill 插件创建已接通     | 标准命令选择工作区 Skill 文件夹，将完整目录与资产复制为有效 Ash 插件，原子发布并打开 manifest；取消不创建、碰撞不覆盖、失败清理本次 staging。创建后由原插件管理入口安装和启用。                                                                    |
| `exportAgentHostDebugLogsAction.ts`   | 本轮修复共享注册             | 原动作移至共享入口，为 IDE 和 Agent Window 提供同一个导出命令；后端归属、冻结日志、取消与导出机制保留，Debug 导出与纯文本聊天记录格式分开。                                                                                                        |
| `openAgentHostStateFileAction.ts`     | 产品状态契约差异             | 上游打开提供方暴露的 state file，命令保留 Copilot CLI 兼容 ID。Ash 的 App Server 没有该文件契约；实际对话快照由本轮已接通的 Inspect Chat Model／Debug owner 读取，不把它包装成 CLI 状态文件命令。                                                  |
| `reviewEdits.ts`                      | 已接通文本映射编辑流与原审阅 | 完成回复的 Apply to editor 经过 common CodeMapper 和真实 Core side chat 模型运行，按序进入原 IChatEditingService／working copy／undo。固定源回复、目标及建议 ID；取消、连接退休、目标关闭或用户修改停止后续批次，已收到的变化保留审阅。            |

## 本轮剩余 11 项的处理范围

用户确认补齐 Ash 对应能力，不接入 Copilot 专属集成。本轮落地插件创建、模型连接凭据管理、Profile 语音／听写指令、模型反馈草稿、文件树导航和代码块流式映射审阅，并补齐独立 Agent Window 的问题报告及原审阅命令装配。语音指令范围按用户选择采用实际语音后端 Profile 的 voice.md／dictation.md；听写仅使用受支持后端的原生识别提示。

推荐、首次启用、Continue In、Transfer、CLI state 五项沿用上述 Ash owner 和明确的产品差异，没有新增同名别名。文件树导航、代码块流式映射与审阅的两个 Ash 行为缺口已补齐；这次选定的 Ash 能力均已接入真实调用链。目录目前有 33 个上游同路径文件、1 个 Ash 专属动作文件；上述 5 个产品集成文件继续保持不存在，不计作已实现的上游公开 API。

## Actions 对应的 common 契约

- `common/chatService/chatService.ts` 只拥有实际消费的 `IChatTreeData`、资源树类型和外部 JSON 还原边界。原 `IChatService` 继续归 `workbench/services/chat/common/chatService.ts`，没有建立第二份会话服务。树最多 1000 项、32 层，JSON 文本长度上限为 262144；只接受原资源目录下的 file／ash-remote URI，标签保持惰性文本。
- `common/editing/chatCodeMapperService.ts` 拥有文本映射请求、响应、provider 和服务契约。内置 provider 使用原 Core side chat、源回复模型及订阅；模型调用保留原策略与记账，侧问不导航或改写源草稿。当前目标为一个打开的文本 working copy，输入及输出上限为 1 MiB UTF-8；不宣称 Notebook 或 VS Code 扩展 mapper 协议支持。
- `workbench/services/chat/common/chatService.ts` 的 `ChatEditSource` 承接真实源回复、Session、代码块建议 ID 与语言归因，进入原 bulk edit reason。`common/editing/chatEditingService.ts` 继续拥有唯一审阅契约；代码映射没有建立另一份文件、审阅基线或 Turn 状态。`common/model/chatViewModel.ts` 的原 feedbackSource 在按钮调用时读取，避免保留流式行的过期身份。
- 模型连接、工具选择、Profile 语音指令和反馈动作继续消费其现有 languageModels、languageModelTools、dictation 与 issue common owner；共同契约不反向导入 browser actions。

## 文本记录契约

`ash.chat.transcript` version 1 保存 title 和 messages（role、text、partial），包含用户／助手文本和语音转录；不包含工具执行权、交互凭证、提供方设置或附件字节。导出从原会话所属连接读取完整文本快照，在选择目标文件前冻结；后续切换会话不重定向该快照。导入验证格式、版本、角色、字段类型、条数和 10 MB 大小限制，通过现有 read-only initialText 编辑器打开，不改变当前会话及草稿。

## 验证边界

命令测试覆盖实际注册入口、原有工具选择器、原生表单、重试模型、最终回复复制和文件读写／只读编辑器调用；延迟确认覆盖导航、提示替换、隐藏和 AI 禁用。Desktop 自托管场景覆盖 IDE、Agents Code 和 Cowork 的共享注册、工具选择器、代码块导航、剪贴板及记录导出／导入。具体通过结果以本轮最终执行记录为准。

本轮定向回归为 89 项单测、IDE／Agent Code 两个 Electron/App Server 场景，七个环境的类型检查及分层检查通过。插件场景从真实本地安装目录开始，经标准 New Chat 命令创建并聚焦草稿，再验证 Plugins 的查询重置、搜索焦点、草稿保留和键盘详情；成功场景附带查询、焦点、草稿及主题证据。

只读上游源码的产物由原编译工具生成，官方 Chromium runner 的 105 项对应 actions／插件入口测试通过；真实上游桌面另行验证 Plugins 打开 Extensions、重置其他查询、聚焦搜索及保留同一未发送草稿。上游使用 @agentPlugins，Ash 使用原管理界面的 @plugins；两者默认主题分别为 Dark 和 Light，未修改样式。上游内置 GitHub／Emmet／Git 扩展尚未全部编译，这些结果不覆盖安装、授权或 marketplace。目录中其他 UI 场景的完整上游对照仍见根目录 TODO，不能据此宣称整个目录已完成 API／UI 对齐。

2026-11-02 本轮验证：167 项定向前端测试（15 个文件）、IDE／Agent Window 共 8 个 Electron/App Server 场景及 6 个 Browser/App Server 场景、七环境类型与分层检查通过。Rust 侧 Profile 文件与 RPC 5 项、原生提示 WebSocket 1 项、协议 181 项、ash-api 100 项通过，另有 1 项原有 ash-api 测试忽略；受影响 Rust 包 all-targets 警告检查通过。指令测试覆盖原文与 Profile 隔离、冲突、权限、超限、无效 UTF-8、符号链接、连接代次和编辑器观察生命周期。界面验证未使用真实语音账户或物理麦克风，不构成音质验收。

文件树与映射审阅的收尾验证：116 项定向前端测试（8 个文件），Electron/App Server 与 Browser/App Server 各覆盖 IDE、Agent Window 两个场景，七环境类型和分层检查通过。真实 MCP structuredContent 经 Core 保存为原 artifact，再由树命令打开原文件；受控模型端点经真实 Core side chat 生成文本编辑，原审阅命令拒绝后恢复 working copy，源草稿保留。取消、执行刚接受时取消、AI 隐藏、连接更换、用户在保存期间修改、UTF-8 大小及中文提示均有定向验证。树控件在 Light、Dark、HC Dark、HC Light 下覆盖键盘、焦点轮廓、几何和文本溢出；Chat 的 40 个 CSS 文件 ownership audit 无复制、品牌替换或新增上游品牌引用。
