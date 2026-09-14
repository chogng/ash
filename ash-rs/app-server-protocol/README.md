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
| `instructions/import/preview` | User 或当前 Workspace → 来源正文、摘要、目标冲突 | 只读 Claude 已知路径，供用户确认 |
| `instructions/import/apply` | 同一作用域、来源路径与摘要、预览目标 → 目标路径与摘要 | 重读来源并核对目标；仅在缺失或为空时写入 `ASH.md` |
| `instructions/list` | 可选 Session → 指令条目与诊断 | 只列出用户级及该 Session 已授权目录；条目包含加载策略、来源和正文摘要 |

`turn/start` 和 `turn/steer` 的 `instruction` 输入只接受从 catalog 选出的来源、相对路径和
`sha256:` 正文摘要。App Server 接收时校验，模型调用前再次核对；缺失、权限撤销或正文变化均拒绝旧引用。

`memory/changed` 只向产品 host 发布作用域和新 catalog revision；客户端随后重新读取。`queue/changed` 是无内容的失效通知。Config 的 Feature 来源由 `ash-features` 解释。反馈待审阅包在 connection 关闭时释放，持久队列由 profile 后台调度器恢复。
