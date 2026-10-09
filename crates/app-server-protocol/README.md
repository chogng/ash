# `ash-app-server-protocol`

- 定义 App Server 的 JSON-RPC 请求、结果、通知、错误、方法注册、启动记录、序列化作用域，以及带稳定操作 ID 的领域取消契约；不拥有运行时、连接或存储。
- Session API 提供按 `session_id` 聚合的 Agent tree 与轻量会话列表；Project 使用独立 revision 和命令回执，不复制 Thread 状态。
- `session/list` 与 Session mutation result 的 `Session.model` 返回主线程当前选择的模型；主线程未选模型时省略此字段。子线程、fork 或全局默认模型不替代主线程的选择。列表从持久目录读取，不为显示模型逐个重放历史；旧目录版本通过历史重建后写入当前格式。
- `project/read`、Project mutation result 和 `project/changed` 的 root `path` 是绝对 `file:` URI；
  `environmentId` 指明所属环境，`dirId` 指明目录身份。URI 本身不提供文件访问权限。
- Rust DTO 与方法注册表是唯一协议来源；修改后从仓库根运行 `just generate-protocol`；JSON Schema、TypeScript 方法映射、运行时解码器和 metadata 写入 Git 忽略的 `.build/protocol/`，只提交 Rust 定义及消费方改动。

`agent/capabilities/read.sandboxDiagnostics` 返回当前目录只读进程的后端准备状态，分别检查 denied、allowed、managed 网络策略；
`ready` 只表示准备通过，`unsupported` 和 `unavailable` 携带原因，不保证命令或 PTY 启动成功。
浏览器宿主能力版本 3 的 `browser/create`、`browser/observe`、`browser/perform` 可携带工具调用的 `networkToken`。
宿主通过 `browser/network/authorize` 提交 token、URL 和 HTTP 方法，结果为 `allowed`；token 绑定发起连接，在工具结束、取消或断线后失效。
该请求不占用浏览器动作的串行作用域，否则等待网络授权的导航无法完成。HTTP(S) 逐请求评审，WebSocket 当前拒绝；共享用户页面只允许观察。
当前宿主的检查范围是 HTTP(S)，不能作为完整网络沙箱；WebTransport 绕过 Electron 请求拦截，完整隔离仍需可撤销的后端代理，见 [桌面架构](../../docs/ash-desktop-architecture.md#71-当前实现)。

`model/list` 的 `ModelCatalogEntry.settings` 返回当前连接和目录生效后的模型请求配置，来源类型为共享 protocol 的 `ModelSettings`。列表不暴露基础提示词正文。新执行使用同一批目录资料绑定模型默认参数和预算，目录刷新只影响后续执行。

`model/list.catalog_scopes` 随缓存行返回当前外部连接的无秘密身份；`identity: null` 表示当前凭证不可用。读取不发起网络发现。`provider/models/updated` 的 authority 必须是订阅的 `accountId` / `organization` / `plan`，或外部连接的 `catalogScope`；外部来源不创建账户，缺少这两类身份的通知解码失败。外部身份变化先发出 `empty` 退役通知，远程刷新结果仅在同一身份仍有效时发布。消费者注册通知后再读取快照，并以请求代次拒绝被通知取代的迟到结果。

`fs/writeBinaryFile` 接收原始字节的 base64，最多 50 MiB。可选 `options.mode` 明确选择
`create`（已有文件包括空文件时拒绝）、`replace`（文件不存在时拒绝）或 `createOrReplace`。
`options.expectedRevision` 对原始字节执行版本校验；校验和发布由文件系统在同一目录锁内完成，
冲突返回 `FileSystemRevisionConflict`，不更改原文件。省略 `options` 的旧调用仍采用粘贴规则：
只允许写入不存在或已有空文件的目标。返回 metadata 和原始字节的 revision，文本保存也可使用该契约。

`options.unlock: true` 是产品宿主或已认证 Web 会话的显式普通覆盖操作，要求已有目标及 `expectedRevision`，
拒绝 `create` 模式，不接受普通 RPC 或 Agent 连接调用。它仍持有 `WriteFiles` 授权，只请求当前用户的文件权限。

`fs/writeFileElevated` 接收连接内唯一 `operationId`、已授权的 `dirId` 或 `sessionDirectory`、
相对路径、原字节 base64 和可选 `expectedRevision`，上限同为 50 MiB。已有文件必须提供
revision；缺少 revision 只允许创建。仅 ProductHost 连接可请求或取消；LocalFileSystem 执行 OS 提权，仍要求 `WriteFiles`。
`fs/writeFileElevated/cancel` 携带同一 operationId 和目录选择，保证执行环境路由一致；
取消仅属于当前连接，取消回执不替代原写入终态。系统授权等待不占用全局串行作用域。
提交前取消返回 `RequestCancelled`，提交后保留成功结果；断线、超时或回执丢失不自动重发。
OS 权限拒绝为 `FileSystemPermissionDenied`，文件只读为 `FileSystemWriteLocked`，两者均与 Ash 目录授权拒绝区分。
管理员拒绝、能力不可用、授权超时、授权程序失败和无法确认写入结果分别为
`FileSystemElevationDenied`、`FileSystemElevationUnavailable`、`FileSystemElevationTimedOut`、
`FileSystemElevationFailed` 和 `FileSystemWriteOutcomeUnknown`。版本冲突仍使用 `FileSystemRevisionConflict`。

`github/session/issues` 列出会话根 Thread 保存的 Issue 身份；
`github/session/issue/attach` 与 `github/session/issue/detach` 接收 `sessionId`、
`reference.repository`（host、owner、name）和正整数 `reference.number`。
主机与仓库名规范化后按身份去重，重复添加和移除幂等，实际变化通过 `session/changed`
通知订阅窗口。不存在的会话拒绝写入；服务不存标题、状态或账号凭据。客户端添加前通过
`github/issue/read` 验证访问，实时状态仍按当前账号读取。移除只取消关联，不向 GitHub
提交关闭或删除操作。关联随根 Thread 删除、恢复和历史迁移；不依赖工作区目录。

`initialize.serverInfo.operatingSystem` 返回当前 App Server 进程的路径平台（`windows`、`mac` 或
`linux`）。未知平台省略该字段。它不表示客户端平台或另行选择的执行环境。Renderer 协议客户端
随连接初始化更新该事实，断线时清除；文件名校验从当前连接读取，不单独缓存。SSH 资源仍遵循
已有 POSIX 路径契约，浏览器文件句柄遵循自身的名称限制。前端 Path Service 接入文件名校验、
资源 OS 查询及服务器绝对路径转 URI；服务器文件夹选择与工作区授权按目标 OS 往返路径，保留 POSIX
文件名中的反斜杠，正确处理 Windows 盘符与 UNC。旧服务器未提供 OS 时，仅按明确的盘符或
UNC 语法转换 Windows 路径，文件夹选择不发送客户端推断的默认路径。
`initialize.serverInfo.userHome` 提供 App Server 所在机器的 OS 用户主目录，无法取得时省略。
它与 `ASH_HOME` 数据根独立；客户端不得通过数据根父目录推算用户主目录。连接关闭时清除该事实。
Path Service 使用目标 OS 解释绝对路径与 `~` 输入，路径标签和服务器目录选择消费当前连接的 home。
Electron 单独提供本机 OS home；Web 文件句柄不推断主机目录，SSH 资源保持已有 POSIX 契约。
Path Service 的资源路径 provider 注册仍没有生产调用方，未扩展该契约。

## 编译与导出

- 队列、通话、协作和任务交付使用各自的 `*-contract` crate；服务端启用执行 feature 时也不改变协议依赖。协议构建不编译这些领域的执行器、SQLite、工具执行、剪贴板或图片处理；默认与服务端 feature 合并后的依赖边界由 `tests/dependency_boundary.rs` 验证。
- 默认构建使用空实现 `JsonSchema` / `TS` 派生，保留属性但不生成实现；握手 hash 由构建脚本从 `.build/protocol/metadata.json` 写入编译常量。
- 单元测试使用真实派生验证契约，`schema_hash` 集成测试校验默认运行时、导出器与生成客户端一致。
- `json-schema` feature 只启用真实 `JsonSchema` 派生，供需要组成自有 schema 的 Rust 消费方使用。
- `export` feature 在 `json-schema` 之上启用 TypeScript 派生和完整导出 API；该模式直接计算 schema hash，不依赖已有 metadata；`generate_protocol` 二进制要求该 feature。`just generate-protocol` 显式启用并同步生成 schema、TypeScript 和协议元数据。
- 导出内容未变化时保留文件时间戳，避免重复触发 Rust 构建；开发监听器先生成协议，再编译服务。
- 前端构建、Rust Just 命令和开发或发布打包先检查共享输入与产物缓存，以及源码匹配的后端包；无匹配产物时调用 Rust 导出器，然后读取 `.build/protocol/metadata.json`。开发和发布包携带 `ash-resources/protocol/` 与源码指纹，前端可通过 `ASH_PROTOCOL_PACKAGE` 或生成器的 `--package-root` 指定包根目录，在没有 Rust 工具链时恢复匹配产物；当前开发包会被自动检查。包内文件摘要、协议 metadata 和当前源码必须同时匹配。直接 Cargo 构建前运行 `just generate-protocol`。Bazel 启用 `export` 从 Rust 计算 hash，不读取 Cargo 本地输出。并发准备由进程锁串行化，失败保留上一次完整产物并在下次重试。
- 其他领域 crate 自己使用的 schema / TypeScript 依赖不受此开关控制。

## 运行基础设施

| Method                                                            | 参数与结果                                                                                      | 行为                                                                                                       |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `diagnostics/read`                                                | 空参数 → `DiagnosticSnapshot`                                                                   | 有界无内容诊断、构建身份和使用计数                                                                         |
| `mcp/server/status`                                               | 空参数 → `McpServerStatusResult`                                                                | 每个服务器的 `httpOrigin` 仅包含 HTTP(S) 协议、主机与端口；stdio 为 `null`，不返回用户信息、路径或查询参数 |
| `feedback/prepare`                                                | HTTPS endpoint → `PreparedFeedback`                                                             | 返回待审阅内容和同时绑定内容/地址的摘要；15 分钟有效                                                       |
| `feedback/upload`                                                 | operationId、digest → 空结果                                                                    | 用户明确确认后调用；仅原 connection 可上传，不自动重试；支持 request cancellation                          |
| `queue/enqueue`                                                   | commandId、Session/Thread、输入、mode、可选模型/推理等级/toolMode、approvalMode → QueuedMessage | 持久接收与相同请求去重；目录和省略时的工具模式由后端选择                                                   |
| `queue/list`                                                      | Session/Thread → messages                                                                       | 返回队列状态和输入；窗口关闭不删除队列                                                                     |
| `queue/cancel`                                                    | Session/Thread、commandId → QueuedMessage                                                       | 取消未交付消息；交付中或已开始使用 Turn 中断                                                               |
| `queue/edit`                                                      | Session/Thread、commandId、expectedRevision、action → QueuedMessage                             | pause、replace、move、send；冲突直接报错                                                                   |
| `extension/items/list`                                            | Session/Thread → items                                                                          | 返回扩展自有文本展示项；校验身份和大小                                                                     |
| `memory/add` / `memory/update` / `memory/delete`                  | commandId、作用域、Memory 身份与 revision → mutation result                                     | 用户显式新增、按 revision 更新或删除；命令可重放，删除立即移除正文                                         |
| `memory/scopes`                                                   | 可选 Thread → scope 标签和 policy                                                               | 返回 Profile、当前关联 Project 与已授权 Dir                                                                |
| `memory/list` / `memory/read` / `memory/search`                   | 精确作用域、分页或 Memory 身份 → 有界结果                                                       | 只允许产品 host；cursor 绑定 catalog revision 和查询                                                       |
| `memory/citation/read`                                            | Memory ID、作用域、revision、UTF-8 范围 → 引用正文                                              | 引用不授予权限；已删除或版本不符明确报错                                                                   |
| `memory/policy/read` / `memory/policy/update`                     | 作用域、commandId、policy revision、automaticRead、modelWrite → 读取与模型保存授权              | 默认关闭；修改与重放沿用 Memory 通知和冲突契约                                                             |
| `memoryDiagnostics/start` / `read` / `submit` / `stop` / `export` | 诊断 Session → report/resource                                                                  | 进程内存诊断，不读取长期 Memory                                                                            |

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

| Method                       | 参数与结果                                                                                          | 行为                                                                                                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `instructions/list`          | 可选 `sessionId` → 指令元数据与 diagnostics                                                         | 草稿省略 Session 时，仅列出用户指令和当前已授权环境目录，不创建 Session，也不读取其他 Session 的目录。发送 instruction 引用时重新校验当前 catalog 与授权。 |
| `instructions/importPreview` | `scope`、`source`、`directory: {sessionId, path}`、`sources: string[]` → digest、items、diagnostics | 预览选定生态和作用范围的指令，sources 为空时发现全部；非空时只接受准确的已发现相对路径。需要目录 ReadFiles 与 BrowseFiles。                                |
| `instructions/import`        | 同一 scope、source、directory、sources 与已审阅 digest → items                                      | 重读来源并检查摘要；需要 WriteFiles，逐文件有条件发布。                                                                                                    |

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

| 接口                 | 参数与结果                                                                  | 行为                                                                      |
| -------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `call/screenSources` | `resourceId` → `sources`                                                    | 返回可用显示器和窗口的 `target`、标题与尺寸；要求已连接且成员可共享。     |
| `call/control`       | `control: {type: "shareScreen", target: {type: "display" 或 "window", id}}` | 按所选来源以 15 fps 采集并发布；来源 ID 在执行时重新验证。                |
| `call/control`       | `control: {type: "stopScreenShare"}`                                        | 停止采集并注销视频轨道，保留通话。                                        |
| `call/screenFrames`  | `resourceId` → `mediaEpoch`、`tracks`、`frames`                             | 拉取最新画面；每个 frame 含 `trackId`、`participantId` 和 base64 `jpeg`。 |

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

| Method                 | 当前协议语义                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `terminal/processInfo` | 按 terminalId/dirId 查询 ready、当前 cwd 和最后成功应用的 rows/cols；当前 cwd 在 macOS/Linux 查询，在无法查询的平台或退出后为 null。 |
| `terminal/write`       | 1–65536 字节 UTF-8 输入，保留现有命令状态检测。                                                                                      |
| `terminal/writeBinary` | base64 包装的 1–65536 个原始字节；编码长度最多 87384，不解码成文本，不推断命令。                                                     |
| `terminal/sendSignal`  | signal 为 interrupt；Unix PTY 中断当前前台进程组，Windows 返回 TerminalUnsupported（-32066）。                                       |
| `terminal/resize`      | 成功应用字符尺寸后更新进程属性；非法尺寸不更新。                                                                                     |

以上查询与控制只允许当前附着 connection，并重新检查目录执行授权；错误连接返回 TerminalNotOwner。
非法 base64、超大输入和未知 signal 返回 InvalidParams。decoder、method map 和 schema 从 Rust 定义生成。
现有分页输出与连接租约没有提供解析后 ACK、进程列表、显式 detach 或跨窗口恢复；
这些操作不能按名称存在或有限缓存推断为已实现。服务进程退出后无法 attach 已退出的 PTY。

## Turn 文件选择提交

`turnChanges/prepareCommit` 按 Session / Thread 接受版本绑定的文件选择和消息，返回固定
`commitId` 与最终目标 Diff；`readCommit` 和 `readCommitFile` 读取同一准备对象。
`turnChanges/commit` 只接受这个 commit ID，不重新组合选择或读取当前 draft。
准备与确认是 Session 独占写，预览读取是共享读。相同 command ID 与参数返回原始持久响应，
改参数返回冲突；目标移动要求重新预览。

Turn summary 新增部分提交状态与 `committedPaths`；状态从精确回执计算，封存证据不被提交改写。
存储单向迁移旧整轮提交，保持原事务身份与冻结消息，详见
[Turn 账本](../../docs/chat-session-inspector.md)。

## 本地 SDK 扩展包安装

`plugin/installLocal` 接受当前已授权目录内的相对包路径；拒绝绝对路径、上级目录段和越界链接。
读取、验证、复制全过程持有该目录的 `ReadFiles` 授权。请求使用 `commandId` 与 `expectedRevision`，
返回包的精确身份、digest 和可重放的命令结果。安装不会启用或授予包权限；分别调用 enable 与 grant。
`plugin/list` 返回该已安装对象的显示名称、权限声明及是否包含编辑器扩展，管理界面据此展示授权内容。
授权撤销、停用和卸载沿用既有 activation generation 和通知；其他客户端的变更会使旧 revision 冲突。

## 市场编辑器扩展执行

`marketplace/editorExtensions` 查询已安装扩展的精确包身份、可执行入口、enabled、granted 和全局 policy revision。
`marketplace/setEditorExtensionPolicy` 提交 installationId、精确 packageDigest、expectedRevision 与
`enable`、`disable`、`grant`、`revoke` 中的一种动作。安装不启用或授权；两个状态分别修改。

只允许产品 host 连接。启用和授权要求当前平台支持隔离且包有合法 JS 入口；停用和撤销允许清除旧状态。
授权绑定包摘要与宿主权限版本，更新不能继承不同包的授权。旧 revision 返回 PluginRevisionConflict；
客户端重新查询，不自动覆盖。提交可能已落盘但回复丢失时，先查询，不自动重放修改。
停用和撤销返回成功前，扩展运行时完成旧调用取消与进程退役。API 兼容性由实际扩展激活验证，入口存在不保证全部代码受支持。

## 编辑器扩展按事件启动

`extensionHost/activate` 只允许产品 host 连接，接受 `{ extensionId, activationGeneration, event }`。
`event` 是 `{ type: "command", command }`、`{ type: "language", languageId }` 或
`{ type: "startupFinished" }`；它表达使用意图，不授予权限。Rust 重新检查包代际、已安装状态、
启用与授权状态，再匹配包声明；不匹配或代际过期时拒绝启动。

Open VSX JS 扩展在等待时以 `dormant` 返回，无 incarnation、输出或 provider registrations。
可选 `activation: { events, commands: [{ command, title }] }` 只携带已验证的清单声明。
命令面板据此展示命令，首次执行等待启动，随后用实际注册 ID 和新 incarnation 发起原有的
`extensionHost/invoke/start`。已激活快照不携带 activation 声明。启动失败返回扩展的失败状态，
不会重放命令；过期或断开连接后的回复不能恢复前端贡献。

支持 `onCommand:<id>`、`onLanguage`、`onLanguage:<id>`、`onStartupFinished` 与立即启动的 `*`。
标准 commands、languages 贡献生成隐式事件。语言来自 TypeScript 编辑器的当前模型，启动完成
事件来自窗口恢复阶段；调度、进程启动和授权检查属于 Rust。其他事件类型、完整 VS Code API
与 Node 模块尚未实现。本地 SDK 和独立可执行扩展维持现有启动方式。

## 内置 Symphony

初始化契约 `symphony.version = 1` 表示当前 profile 提供内置调度域。
所有窗口复用既有连接；不创建 Elixir 服务或第二个 Agent App Server。

| 方法                 | 行为                                                       |
| -------------------- | ---------------------------------------------------------- |
| `symphony/read`      | 工作流与对话监控快照；累计用量和时长直接读取 Core          |
| `symphony/configure` | 导入绝对路径的 `WORKFLOW.md` 并启用派发                    |
| `symphony/submit`    | 创建手动任务；返回对话身份                                 |
| `symphony/control`   | 保存运行、暂停或完成意图；控制执行使用 Core 的持久命令身份 |
| `symphony/enable`    | 启停工作流后续派发；不停止当前对话                         |
| `symphony/messages`  | 当前对话最近的用户与助手消息                               |
| `symphony/changed`   | 无载荷的失效通知；客户端先订阅，再重新读取快照             |

变更方法携带 `commandId`，重复请求核对完整输入指纹。
任务的 Thread 身份跨暂停、恢复与重试保留；调度域不另存 Token 或消息。
错误使用 `SymphonyUnavailable`、`SymphonyNotFound`、`SymphonyConflict`、
`SymphonyInvalid` 和 `SymphonyOperationFailed`，客户端按枚举映射文案。
配置适配、执行生命周期和限制见 [调度域说明](../symphony/README.md)。

## Execution defaults

`config/read.execution` returns the profile's resolved `approvalMode`,
`commandFileAccess` and `commandNetworkAccess`. `config/update.execution` uses the
existing command ID and expected revision contract: an object replaces the three
defaults; `null` resets them; omission preserves them. File access accepts
`readOnly` or `directoryWrite`, and command network access accepts `denied` or
`allowed`. Invalid modes fail before mutation. Command defaults are reloaded for
future prepared commands; existing processes continue. Managed network rules and
host directory capabilities remain separate required authorities.

`session/request` with `request.type = "startTurn"` may omit `approvalMode` to use
the current profile default. An explicit mode overrides it and remains frozen on
the resulting Turn. Queue entries and explicit client choices continue to carry
an approval mode. Workflows without their own approval mode use the same default.
Directory permissions remain editable only through a trusted host connection.
