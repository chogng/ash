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

## 应用窗口截图链路

桌面入口 `chatScreenshot.contribution.ts` 在 IDE 和 Agents Window 恢复输入框前注册应用窗口截图服务、action 和提示监听，避免漏掉首次粘贴。`chatAppWindowScreenshotActions.ts` 原路径新增，承担两个命令、Add Context 和后台快捷键；`screenshotTool/electron-browser/appWindowScreenshot.ts` 原路径新增，负责选窗和获取窗口图片。截图返回窗口身份、来源、像素和尺寸，聊天 action 再调用内置截图服务，附件继续进入原输入模型的 acquisition lease。

| 路径与对应关系                                                                                                                               | 本批职责与验证                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `chat/electron-browser/actions/chatAppWindowScreenshotActions.ts`，仅上游原有                                                                | 自动截图、手动选窗、显式 `sessionResource`、模型能力和 AI 配置准入；真实命令注册测试及中文标签测试。                    |
| `chat/electron-browser/actions/chatAppWindowScreenshotHint.ts`、`chatAppWindowScreenshotSetup.ts`，仅上游原有                                | 首次图片粘贴／拖入提示、共享存储原子认领、权限状态、设置跳转和返回复查；复用输入通知仲裁、Dialog、Button 和无障碍入口。 |
| `screenshotTool/electron-browser/appWindowScreenshot.ts`、`browser/screenshotTool.ts`，仅上游原有                                            | 窗口截图结果与图片数据契约；独立实现选窗、取消和像素获取，不迁入上游私有控制流。                                        |
| `platform/native/common/native.ts`、`nativeHost.ts`、`electron-browser/nativeHostApi.ts`、`electron-main/nativeHostMainService.ts`，双方都有 | 加入真实调用的窗口枚举与截图 API；元数据枚举不批量获取窗口像素，Renderer IPC 校验身份及 PNG。                           |
| `platform/native/electron-main/macScreenWindows.ts`，仅上游原有                                                                              | Core Graphics 元数据与系统窗口 PNG 捕获；排除当前 Ash 进程、限制进程运行时间、清理私有临时目录。                        |
| `platform/native/electron-main/rendererSystemHostRoutes.ts`，Ash IPC owner                                                                   | 将窗口身份限定为发送窗口最近枚举所得的集合；已有 screenshot endpoint 仍只截发送方自身窗口。                             |
| `platform/imageView` 与 `workbench/services/imageEditor`，Ash 图片编辑 owner                                                                 | 已有图片输入不触发整屏捕获，也不检查屏幕录制权限；原编辑器与原插件生命周期继续生效。                                    |
| `code/electron-main/app.ts`，双方都有                                                                                                        | 系统快捷键在 Ash 失焦时选择最后活动窗口；各窗口租约仍由平台 registry 管理。                                             |
| 原测试替身、中文语言包与 Chat 无障碍帮助                                                                                                     | 同批补齐 Native Host 依赖，覆盖权限、取消、草稿退役、目标会话、图片传递和中文命令。                                     |

`chat.appWindowScreenshots.enabled` 默认开启，同时受 Chat AI 开关约束。macOS 使用 Core Graphics 的窗口顺序并优先屏幕上的窗口；其他桌面平台使用 Electron 枚举和单窗口媒体流。编辑在附件加入草稿前完成。命令支持失焦时通过全局快捷键发起截图，只有用户触发才获取窗口像素。现有整屏选区命令保持独立，不重复持有聊天草稿。窗口捕获反馈与飞入动画不在本批范围。

首次提示只响应当前输入框实际接收的图片粘贴或拖入，不响应草稿恢复。提示使用现有 Tip 通知层，向更高优先级内容让位；图片移除、草稿退役、禁用功能或已成功捕获后关闭。应用级共享存储 writer 原子认领一次显示，IDE 和 Agents Window 不各自持有一次性状态；未显示就失效的认领可释放。

macOS 权限不足时打开 Setup。允许设置跳转、只读复查、返回窗口时复查，系统限制状态提供对应说明；从设置返回仍未生效时提供显式重启。授权完成仅关闭 Setup，不自动继续截图。关闭和 Escape 保留原草稿并恢复焦点。新界面复用 Ash 控件、主题 token、Accessible View／Help 和 verbosity 设置，文案含中文翻译。

真实 OS 截图场景使用独立 Electron 测试应用，只包含测试色块。宿主缺少 macOS 屏幕录制权限时，该场景明确跳过；IPC 权限边界与已有图片的原生编辑场景仍可独立运行。完整实机截图验收状态见根目录 TODO。

本轮 Hint／Setup 验证：`pnpm build`、Renderer／Main／自动化类型检查、中文翻译生成、5 个文件共 38 项定向测试和 10 项输入框定向测试通过。连接 App Server 的 Ash 实机验证通过权限拒绝／受限／恢复、单实例 Setup、草稿与焦点保留，以及 IDE／Agents Window 提示仅显示一次；同时验证四种主题下的按钮边界与 Setup 无障碍帮助返回焦点。权限状态与系统设置调用由测试控制。全局截图快捷键在 Agents Window 初次导航、刷新和重开后也通过回归。此前 2 项 Electron UI 场景通过。真实外部窗口像素捕获仍因宿主权限不足跳过。

## 内置截图编辑器

已确认的 Ash 扩展能力归入 `workbench/contrib/screenshotTool`：截图后停留、矩形、箭头、画笔、文字、马赛克、撤销、复制、保存与加入 Chat。`screenshotTool.contribution.ts` 注册窗口级 `IScreenshotToolService`；服务编排内置呈现与取消，通用 Native／Browser 图片适配器承载交互，`platform/imageView` 持有原生窗口和输出，Native 层检查权限，截图入口协调 Setup。

`screenshotToolView.ts` 启动用户确认的增强编辑界面；从 Ash 自有 Snapshot 实现迁移，保持画布、坐标和历史模型，不复制 VS Code 标注实现。`imageEditorSelection.ts` 将代码快照从扩展适配器归还图片编辑领域，内置命令和扩展适配器复用同一读取逻辑。`snapshot.code`、`snapshot.code.*` 和截图快捷键配置保留现有身份；设置导航改为 Workbench 的 Screenshot 分类。

`extensions/snapshot` 已移除，产品构建直接打包隔离界面；默认截图不再经过扩展目录、SDK 或 Worker 激活。字体、主题、无障碍帮助与中英文文案随内置界面加载。Pin、OCR 与翻译不在本次迁移范围。

权限职责归位后，32 项定向单元／浏览器测试与 10 个 Ash Desktop 自托管场景分批通过。覆盖通用图片协议拒绝旧权限卡片、隔离帧忽略权限操作、桌面截图准入与取消、Chat 命令回退、标注导出、中英文 Setup、权限不足时的后台快捷键，以及已有图片和代码图片不取屏。Main、Renderer、Common、自动化类型、七环境分层、构建和 CSS 检查通过，中文缺失项为零。4 个真实桌面／其他应用像素场景因测试宿主缺少 macOS 屏幕录制权限跳过，保留根目录既有实机验收条目。

## screenshotTool 职责归位

当前行为链为：Chat／独立截图／代码图片 → `IScreenshotToolService` → 选区与标注界面 → 通用图片窗口承载 → 原生输出或 Chat 原草稿。

| 路径关系                                                                                       | 本批处理                                                                                  |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `screenshotTool/browser/screenshotTool.ts`，双方都有                                           | 定义实际使用的增强截图服务端口，不铺没有调用方的接口。                                    |
| `screenshotTool/browser/screenshotToolService.ts`，仅上游原有                                  | 迁入内置界面生成、截图会话取消与编辑编排；Chat 和代码图片直接消费该服务。                 |
| `screenshotTool/browser/screenshotAnnotation.ts`、`media/screenshotAnnotation.css`，仅上游原有 | 将 Ash 自有画布编辑器、标注历史和绘制实现原地迁入，无第二份编辑模型。                     |
| `screenshotTool/browser/screenshotSelection.ts`，仅上游原有                                    | 迁入现有图片坐标与裁剪几何，保留反向框选、像素取整和边界行为。                            |
| `screenshotTool/browser/screenshotToolView.ts`、代码图片及配置，Ash 增强职责                   | 隔离视图启动、代码图片渲染与内置截图设置随截图贡献归位。                                  |
| `services/imageEditor`，Ash 通用服务                                                           | 保留外部 Provider 注册、代码图片快照、主题数据和隔离窗口承载；退出内置截图默认 Provider。 |
| Chat 调用方、Native imageView 产品入口、构建插件、测试与文档                                   | 同批迁移真实依赖；平台权限、IPC 校验、窗口与输出 owner 保持不变。                         |

本批不复刻上游私有实现，也不把尚未在 Ash 使用的附件二次编辑和遥测接口当作迁移清单。

内置界面测试同时注册两个冲突的扩展默认 Provider，仍通过截图、代码图片、标注与取消场景；外部 Provider 的惰性激活、资源约束和撤销测试继续通过。分层检查覆盖七种运行环境，未发现反向依赖。

全桌面框选是 Ash 增强入口。权限卡片已退出图片标注与通用图片 IPC；权限不足由 Native 返回，`NativeScreenshotToolService` 或 Chat action 协调共享 `ScreenCaptureSetupService`，Chat 文案仍归 `chatAppWindowScreenshotSetup.ts`。全局快捷键在授权不足时回到 Workbench 命令。授权后结束本次操作，不自动续截。完整取像范围与生命周期见 [截图说明](../src/ash/workbench/contrib/screenshotTool/README.md#取像范围与权限)。
