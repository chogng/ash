# `ash-app-server-protocol`

- 定义 App Server 的 JSON-RPC 请求、结果、通知、错误、方法注册、启动记录、序列化作用域，以及带稳定操作 ID 的领域取消契约；不拥有运行时、连接或存储。
- Session API 提供按 `session_id` 聚合的 Agent tree 与轻量会话列表；Project 使用独立 revision 和命令回执，不复制 Thread 状态。
- `session/list` 与 Session mutation result 的 `Session.model` 返回主线程当前选择的模型；主线程未选模型时省略此字段。子线程、fork 或全局默认模型不替代主线程的选择。列表从持久目录读取，不为显示模型逐个重放历史；旧目录版本通过历史重建后写入当前格式。
- `project/read`、Project mutation result 和 `project/changed` 的 root `path` 是绝对 `file:` URI；
  `environmentId` 指明所属环境，`dirId` 指明目录身份。URI 本身不提供文件访问权限。
- Rust DTO 与方法注册表是唯一协议来源；修改后必须从仓库根运行 `just generate-protocol`，并提交 JSON Schema、三张 TypeScript 方法映射与运行时解码器。

## 编译与导出

- 默认构建使用空实现 `JsonSchema` / `TS` 派生，保留属性但不生成实现；握手 hash 由构建脚本从已提交的 `schema/metadata.json` 写入编译常量。
- 单元测试使用真实派生，校验 Rust 定义与已提交产物一致。
- `json-schema` feature 只启用真实 `JsonSchema` 派生，供需要组成自有 schema 的 Rust 消费方使用。
- `export` feature 在 `json-schema` 之上启用 TypeScript 派生和完整导出 API；`generate_protocol` 二进制要求该 feature。`just generate-protocol` 显式启用并同步生成 schema、TypeScript 和协议元数据。
- 导出内容未变化时保留文件时间戳，避免重复触发 Rust 构建；开发监听器先生成协议，再编译服务。
- 开发与发布打包直接读取 `schema/metadata.json`，不启动协议生成器；测试校验它与 Rust 定义、运行时 hash 和客户端一致。
- 其他领域 crate 自己使用的 schema / TypeScript 依赖不受此开关控制。

## 运行基础设施

| Method | 参数与结果 | 行为 |
| --- | --- | --- |
| `diagnostics/read` | 空参数 → `DiagnosticSnapshot` | 有界无内容诊断、构建身份和使用计数 |
| `mcp/server/status` | 空参数 → `McpServerStatusResult` | 每个服务器的 `httpOrigin` 仅包含 HTTP(S) 协议、主机与端口；stdio 为 `null`，不返回用户信息、路径或查询参数 |
| `feedback/prepare` | HTTPS endpoint → `PreparedFeedback` | 返回待审阅内容和同时绑定内容/地址的摘要；15 分钟有效 |
| `feedback/upload` | operationId、digest → 空结果 | 用户明确确认后调用；仅原 connection 可上传，不自动重试；支持 request cancellation |
| `queue/enqueue` | commandId、Session/Thread、输入、mode、可选模型/推理等级/toolMode、approvalMode → QueuedMessage | 持久接收与相同请求去重；目录和省略时的工具模式由后端选择 |
| `queue/list` | Session/Thread → messages | 返回队列状态和输入；窗口关闭不删除队列 |
| `queue/cancel` | Session/Thread、commandId → QueuedMessage | 取消未交付消息；交付中或已开始使用 Turn 中断 |
| `queue/edit` | Session/Thread、commandId、expectedRevision、action → QueuedMessage | pause、replace、move、send；冲突直接报错 |
| `extension/items/list` | Session/Thread → items | 返回扩展自有文本展示项；校验身份和大小 |
| `memory/add` / `memory/update` / `memory/delete` | commandId、作用域、Memory 身份与 revision → mutation result | 用户显式新增、按 revision 更新或删除；命令可重放，删除立即移除正文 |
| `memory/scopes` | 可选 Thread → scope 标签和 policy | 返回 Profile、当前关联 Project 与已授权 Dir |
| `memory/list` / `memory/read` / `memory/search` | 精确作用域、分页或 Memory 身份 → 有界结果 | 只允许产品 host；cursor 绑定 catalog revision 和查询 |
| `memory/citation/read` | Memory ID、作用域、revision、UTF-8 范围 → 引用正文 | 引用不授予权限；已删除或版本不符明确报错 |
| `memory/policy/read` / `memory/policy/update` | 作用域、commandId、policy revision、automaticRead、modelWrite → 读取与模型保存授权 | 默认关闭；修改与重放沿用 Memory 通知和冲突契约 |
| `memoryDiagnostics/start` / `read` / `submit` / `stop` / `export` | 诊断 Session → report/resource | 进程内存诊断，不读取长期 Memory |

`memory/changed` 只向产品 host 发布作用域和新 catalog revision；客户端随后重新读取。`queue/changed` 是无内容的失效通知。Config 的 Feature 来源由 `ash-features` 解释。反馈待审阅包在 connection 关闭时释放，持久队列由 profile 后台调度器恢复。

## 未保存内容备份

`backup/workspaces`、`backup/list`、`backup/write` 和 `backup/discard` 仅接受产品 host 连接。
Rust 在 profile 的 SQLite 中原子保存工作区重开信息和正文，连接关闭不删除记录。
`clientId` 是稳定的客户端恢复命名空间，与 connection/window ID 无关；它用于隔离内容格式，并非权限凭证。
资源使用完整 URI，`format` 和 UTF-8 `content` 由客户端解释。正文最多 8 MiB，工作区最多 128 个目录。

创建时 `expectedRevision` 为 `null`；更新和删除使用上次看到的不透明 revision。
相同正文的写入重试返回同一记录，不同正文遇到旧 revision 返回 `BackupRevisionConflict`，不自动覆盖。
查询不消费备份；保存或放弃修改后显式删除，最后一份内容删除时一并清理工作区目录记录。
服务不可用与存储失败分别返回 `BackupUnavailable`、`BackupOperationFailed`。

Electron 编辑器使用 `ash-editor` 和 `ash.working-copy.v1`，生成备份和重建编辑器由前端负责。
启动时 renderer 查询待恢复工作区，再交给 Main 打开窗口；Main 不读取备份协议或正文。
旧 IndexedDB 内容仅在后端确认保存后删除，有冲突的旧内容保留。
浏览器及无后端的 UI 运行模式仍由 IndexedDB 持久化。Rust Desktop 和 TUI 可以使用共享协议，尚未接入各自的恢复入口。

## 编辑器文档宿主

Code Workbench 与 Agents 连接在 `initialize` 声明 `textDocuments: { version: 2 }`。
服务端向发起产品 Turn 的连接发送 `textDocument/read`、`textDocument/list`、`textDocument/apply` 和
`textDocument/release`。路径是该 App Server 环境中的绝对文件路径；工具在发出请求前检查目录授权。

`apply` 必须携带产生修改的 `threadId` 和 `turnId`。Turn 终止后，服务端仅向它所属的文档连接发送 `textDocument/turnFinished`，包含同一标识及 `completed`、`failed` 或 `interrupted` 结果；其他连接不会收到。前端依此结束该回复的审阅等待，自动接受策略与计时留在前端配置和 Chat Editing 服务。断线不转发给其他窗口，也不重放修改或结束通知。

`read` 返回当前模型正文与不透明 snapshot，正文包含未保存内容，不包含编码 BOM。
`list` 返回请求根目录内未保存的文本工作副本，以 `relativePath` 标识文件，供搜索替换对应磁盘内容；不创建编辑 lease。根目录的文件身份由后端确定，不受编辑器 URI 的 Windows 盘符写法影响。
`apply` 成功返回前保存受影响工作副本，保留已有用户正文与撤销记录；保存失败返回 outcomeUnknown。
`apply` 提交最多 128 个创建、版本绑定更新、删除或移动操作，前端复用模型与工作区编辑服务。
更新、删除和移动的 snapshot 在本次申请结束时被消费；重复读取同一资源替换旧 snapshot。
`release` 提前释放读取引用，断开连接时释放全部引用。两端均限制同时保留的 snapshot 数量。

修改结果区分 applied、conflict、cancelled、failed 和 outcomeUnknown。
提交后的断线、超时或取消可能丢失已完成的回复，工具返回 outcomeUnknown，不自动重发修改。
没有文档能力或产品连接的执行使用磁盘接口；已绑定窗口断开不能切换成磁盘写入。
本接口不创建新的文档状态服务，也不定义 Chat Editing 的接受或拒绝界面。

## Hook 配置来源查询

`hook/list` 接受可选 `sessionId`，返回 `HookListResult.sources`。每个来源包含 `namespace`、
`configPath` 与 `hooks` 声明；路径属于连接的 App Server 主机。用户来源始终返回，省略会话时
只返回用户来源。指定会话时，只读取同时拥有 `LoadConfig` 与 `DiscoverHooks` 的会话目录。
来源即使没有声明也保留，使配置工具能使用后端确定的目录身份。

该查询采用全局共享读，不提交 Hook 配置变更、不更改权限、不执行 Hook。读取仍遵循 Config
owner 的版本迁移规则。无效会话、获准来源的读取失败或配置
校验失败均明确报错；不把无效 TOML 当作空声明。配置数量包含禁用声明，不能作为已生效程序数。
用户写入继续使用带 `commandId` 和 `expectedRevision` 的 `hook/upsert`、`hook/remove`、
`hook/enablement/set`。用户指南和运行时约定集中在 [Hooks crate](../hooks/README.md)。

## 协作模式

`session/request.startTurn.mode` 与 `queue/enqueue.mode` 选择模式；省略时为 `agent`。公开 `Turn.mode` 独立返回模式，`TurnInstructions.modeInstructions` 保存所选资产；客户端不通过提示词 ID 推断模式。Steer 沿用已接受模式，改变模式的消息启动新 Turn。完整行为、子任务规则和兼容版本见 [五种协作模式](../collaboration-mode-templates/collaboration-modes.md)。

## 指令导入

| Method | 参数与结果 | 行为 |
| --- | --- | --- |
| `instructions/importPreview` | `scope`、`source`、`directory: {sessionId, path}`、`sources: string[]` → digest、items、diagnostics | 预览选定生态和作用范围的指令，sources 为空时发现全部；非空时只接受准确的已发现相对路径。需要目录 ReadFiles 与 BrowseFiles。 |
| `instructions/import` | 同一 scope、source、directory、sources 与已审阅 digest → items | 重读来源并检查摘要；需要 WriteFiles，逐文件有条件发布。 |

`scope` 必填，值为 `directory` 或 `user`，不隐式选择作用范围。`source` 必填，值为 `copilot`、`claude`、`codex` 或 `cursor`，无默认来源。摘要绑定该来源，不能跨来源复用。

预览项包含 source、target、转换后的 content、status 和可选 message。状态为 ready、unchanged、conflict 或 unsupported。
来源变化返回 `FileSystemRevisionConflict`，写入前失败。任一选中项预览为 conflict/unsupported 时整批不开始写入。
发布只创建缺失或填充空文件，不覆盖不同的已有正文；每个文件原子发布，成功状态为 imported。
发布期间的错误返回逐项 failed/conflict，已发布文件不会回滚；消费者必须检查每项状态，不能将 RPC 成功当作整批成功。
重试会重新检查当前权限、来源和目标，相同内容返回 unchanged。该接口没有持续资源或跨请求后台任务，关闭连接不回滚已经发布的文件。

项目级目标为 `ASH.md` 和 `.ash/instructions/*.md`。共享 `AGENTS.md` 不复制、不修改；其中指向外部规则的引用以诊断提示审查。
导入后通过原有目录文件刷新进入指令 catalog；不创建 Agent Turn，也不授予 LoadInstructions 或其他权限。

用户级导入使用同一组接口：`scope: "user"` 时，`directory.path` 是经授权的外部用户 home；支持 Claude 的 `.claude/CLAUDE.md`、`.claude/rules/**/*.md` 和 Codex 的 `.codex/AGENTS.override.md` / `.codex/AGENTS.md`（非空 override 优先）。Copilot/Cursor 尚无用户文件布局导入，返回 InvalidParams。

用户目标由当前 App Server 配置的 Ash home 决定，客户端不能指定任意发布目录；根文件写入 `ASH.md`，规则写入 `instructions/*.md`。预览返回 `targetDirectory`，目标路径相对此目录。摘要同时绑定 scope、来源目录和目标目录，切换 home 或 scope 必须重新预览。

来源目录需要 ReadFiles/BrowseFiles；目标 Ash home 独立需要 ReadFiles/BrowseFiles，发布还需要 WriteFiles。每次调用重新检查现有目录授权，不自动扩大授权。导入后由 AshHome 刷新用户 catalog，后续模型请求沿现有用户指令路径读取。未配置 home 或目录授权不足时不发布。

## 图片与音频附件

- `attachment/upload/start` 接受图片的 `mediaType`、`encodedBytes`、`detail`，或音频的 `mediaType`、`encodedBytes`。音频格式为 `wav`、`mp3`、`m4a`、`webM`、`ogg`。
- `attachment/upload/write` 按 `offset` 顺序上传 base64 分块；上传 ID 只允许创建它的连接使用。
- `attachment/upload/finish` 完成内容校验和存储，返回 `attachment`：图片含尺寸，音频含 `durationMs`，两者均含摘要、媒体类型和字节数。取消使用 `attachment/upload/cancel`。
- Turn 输入使用 `audioAttachment` 加已上传引用，或 `audio` 加 base64 data URL；后端先校验并保存引用，再接受 Turn。普通音频附件与实时语音是独立接口。
- 持久记录使用 `userAudioAttachment`；订阅、读取和恢复均不返回音频正文。模型调用时才读取字节。
- Chat Completions 用户消息编码 WAV/MP3，格式遵循 [OpenAI 音频输入文档](https://developers.openai.com/api/docs/guides/audio-chat-completions)；ChatGPT Responses 使用音频 data URL。编码器不支持的端点或角色会明确拒绝；模型是否具备音频能力仍由提供商决定。

## 通话屏幕共享

| 接口 | 参数与结果 | 行为 |
| --- | --- | --- |
| `call/screenSources` | `resourceId` → `sources` | 返回可用显示器和窗口的 `target`、标题与尺寸；要求已连接且成员可共享。 |
| `call/control` | `control: {type: "shareScreen", target: {type: "display" 或 "window", id}}` | 按所选来源以 15 fps 采集并发布；来源 ID 在执行时重新验证。 |
| `call/control` | `control: {type: "stopScreenShare"}` | 停止采集并注销视频轨道，保留通话。 |
| `call/screenFrames` | `resourceId` → `mediaEpoch`、`tracks`、`frames` | 拉取最新画面；每个 frame 含 `trackId`、`participantId` 和 base64 `jpeg`。 |

`CallStatus.screenSharing` 表示本地共享状态。上述接口仅允许拥有该通话资源的产品连接调用。角色限制由通话运行时执行；窗口关闭、重连和离开后需要用户重新选择并开始共享。

通知不携带像素。服务端最多保存 8 条共享轨道、64 MiB 最新 RGBA 画面，丢弃超过 500 ms 的待取帧。输出已应用旋转，缩放至 1920×1080 范围，单张 JPEG 不超过 2 MiB。`tracks` 是当前集合，`frames` 只包含本次有新画面的轨道；轨道移除后客户端释放对应画面。客户端按 `mediaEpoch` 和连接代次丢弃过时响应，最多一个拉取请求在途。

## xAI 订阅账户

- `account/login/start` 的 `method: {type: "xaiDeviceCode"}` 返回设备授权链接、验证码和 `loginId`；取消与完成沿用 `account/login/cancel` 和 `account/login/completed`。
- 开始 xAI 登录时注册空的提供商配置，保留已有配置，供登录后保存模型选择。账户 provider 为 `xai-subscription`；`account/logout` 按该 provider 退出。凭证仅保存在后端，账户 RPC 不返回 token。
- `model/list` 在订阅账户就绪时根据当前账户的 `/models-v2` 目录返回 `xai` 模型；订阅不可用时使用已保存的 xAI API 配置。切换账户后旧目录不可用于调用。`account/read` 刷新 xAI 身份与实时套餐；`account/rateLimits/read` 支持 `xai-subscription`，使用同一个登录 ID 校验整个查询。
- 额度结果的 `plan` 可为空。ChatGPT 继续使用 `limits` 和 `credits`；xAI 使用可选的 `xai` 字段，保留小数百分比、上游周期、访问资格和 USD 分字符串。缺失值表示未提供，不推导零用量、余额或允许状态。`xai` 为空时不序列化。
- 查询只读；取消或登录改变会丢弃旧结果。403/426/429 不刷新凭证，401 最多恢复一次。`account/updated` 发布经当前登录身份检查的资料。
- 用户输入的 `ThreadItem.clientId` 等于提交该输入的 `session/request.commandId`；同一次发送的文字、上下文、图片和音频共享此 ID，持久历史和实时 transcript 更新均保留它。客户端按 ID 确认本地待发送消息，不按文字匹配；旧历史未包含该字段时不能确认新发送的消息。

- `ThreadItem.reasoning.state` 保存带作用域的加密 Responses 项；重载历史和工具续轮保留完整项，切换账户、模型或端点后不再发送旧项。


## 交互式终端进程

`terminal/create` 和 `terminal/createInSessionDirectory` 返回实际启动信息 `ready: {pid, cwd}`；
`terminal/attach` 返回同一进程的启动信息并旋转短期 bearer token。cwd 是启动时实际使用的目录，
不是窗口 Workspace 的猜测，也不是当前目录。

| Method | 当前协议语义 |
| --- | --- |
| `terminal/processInfo` | 按 terminalId/dirId 查询 ready、当前 cwd 和最后成功应用的 rows/cols；当前 cwd 在 macOS/Linux 查询，在无法查询的平台或退出后为 null。 |
| `terminal/write` | 1–65536 字节 UTF-8 输入，保留现有命令状态检测。 |
| `terminal/writeBinary` | base64 包装的 1–65536 个原始字节；编码长度最多 87384，不解码成文本，不推断命令。 |
| `terminal/sendSignal` | signal 为 interrupt；Unix PTY 中断当前前台进程组，Windows 返回 TerminalUnsupported（-32066）。 |
| `terminal/resize` | 成功应用字符尺寸后更新进程属性；非法尺寸不更新。 |

以上查询与控制只允许当前附着 connection，并重新检查目录执行授权；错误连接返回 TerminalNotOwner。
非法 base64、超大输入和未知 signal 返回 InvalidParams。decoder、method map 和 schema 从 Rust 定义生成。
现有分页输出与连接租约没有提供解析后 ACK、进程列表、显式 detach 或跨窗口恢复；
这些操作不能按名称存在或有限缓存推断为已实现。服务进程退出后无法 attach 已退出的 PTY。
