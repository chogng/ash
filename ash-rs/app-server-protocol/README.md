# `ash-app-server-protocol`

- 定义 App Server 的 JSON-RPC 请求、结果、通知、错误、方法注册、启动记录、序列化作用域，以及带稳定操作 ID 的领域取消契约；不拥有运行时、连接或存储。
- Session API 只提供按 `session_id` 聚合的 Agent tree；Project 使用独立 revision 和命令回执，不复制 Thread 状态。
- Rust DTO 与方法注册表是唯一协议来源；修改后必须从仓库根运行 `just generate-protocol`，并提交 JSON Schema、三张 TypeScript 方法映射与运行时解码器。

## 运行基础设施

| Method | 参数与结果 | 行为 |
| --- | --- | --- |
| `diagnostics/read` | 空参数 → `DiagnosticSnapshot` | 有界无内容诊断、构建身份和使用计数 |
| `feedback/prepare` | HTTPS endpoint → `PreparedFeedback` | 返回待审阅内容和同时绑定内容/地址的摘要；15 分钟有效 |
| `feedback/upload` | operationId、digest → 空结果 | 用户明确确认后调用；仅原 connection 可上传，不自动重试；支持 request cancellation |
| `queue/enqueue` | commandId、Session/Thread、输入、toolMode、approvalMode → QueuedMessage | 持久接收与相同请求去重；目录由后端选择 |
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
