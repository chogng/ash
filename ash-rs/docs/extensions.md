# Agent 扩展

Agent 能力由 `ext/` 中的 crate 拥有；Core 提交 Thread/Turn 事实并执行工具，App Server 组合扩展和转换产品协议。扩展不能自行签发执行授权。

## 职责

| 目录 | 当前职责 |
| --- | --- |
| `ext/extension-api` | 按身份注册贡献、提示与上下文、续跑、工具与 MCP 生命周期、审核接口、Session/Thread/Turn 临时状态 |
| `ext/agent` | 根 Agent 与子 Agent 的角色选择、能力范围、工具定义、启动和等待编排 |
| `ext/agent-message-board` | 同一 Agent 树共享的频道、讨论、回复、订阅、持久化与当前 Turn 通知 |
| `ext/workflows` | `/team`、`/develop` 的命令、阶段、版本、接受、失效与恢复；通过 Core 启动专用角色 |
| `ext/goal` | Goal 工具、目标提示、续跑条件与重启恢复；通过 Core 的原子入口创建 Turn |
| `ext/queue` | 消息持久化、FIFO、领取租约、交付结果、空闲唤醒与队列展示 |
| `ext/guardian-reviewer` | 严格审核协议、结果绑定、并发上限、异步任务、超时、取消和暂时性失败重试 |
| `ext/guardian-v2` | 配置解析、隔离的模型适配、审核扩展安装；模型没有工具调用能力 |
| `ext/history-notes` | 当前 Thread 的历史检索与读取，以及可跨重启保存的任务笔记 |
| `ext/image-generation` | 图片生成与编辑、服务调用、Thread 内图片引用和原子文件发布 |
| `ext/git-attribution` | 按宿主策略贡献 Git 提交署名和 PR 说明；不授权提交、推送或创建 PR |
| `ext/sleep` | 模型侧计时等待，复用运行时的截止与取消机制 |
| `ext/items` | 文本、搜索来源、图片路径和等待结果的结构化数据与边界校验 |
| `ext/connectors` | 外部账号连接、认证、目录与声明加载；通过所属执行环境的文件接口读取声明 |
| `ext/mcp` | MCP 会话、工具、生命周期，以及 Marketplace Connector/MCP 的绑定与调用租约 |
| `ext/skills`、`ext/memories`、`ext/web-search` | Skill 激活、记忆访问和网络搜索；搜索同时发布结构化来源 |

- crate 用于隔离能力与依赖；目录对齐不要求把所有底层存储、协议或执行库移入扩展。
- Core 通过通用续跑接口请求后续工作，扩展只返回已由 Thread owner 接受的 Turn；执行仍由 Core 启动。
- 续跑使用稳定命令身份，恢复和重复通知不会重复创建 Turn；审核 Turn 不参与 Goal 续跑。
- 工具开始、结果和线程生命周期通知来自已提交事件；回调不得重新进入 Thread 提交锁。
- MCP 启动、目录变化和结束经扩展接口通知；会话关闭和工具调用仍由 MCP owner 管理。
- 同名贡献在原注册位置替换；重新组合 registry 保留同一份临时扩展状态。
- 临时状态按 Session、Thread、Turn 隔离；Turn 结束、Thread 归档和 Session 删除会清理对应范围。
- `extension/items/list` 保留 `title`、`body`、`status`，通过 `content.type` 区分 `text`、`webSearch`、`image`、`sleep`。最近结果最多保留 64 项，不替代 Thread 的持久历史。

时间、等待的工具参数、成本边界及 Codex 对照统一维护在 [Agent 时间与等待](agent-wait.md)。

## 已收回的实现

| 旧路径 | 当前归属 |
| --- | --- |
| `ext/clock` | `ext/sleep` 的 `sleep` 工具；后台命令和子任务使用各自的完成条件 |
| `ash-rs/connectors` | `ext/connectors` |
| `ash-rs/queue` | `ext/queue`，包括原 App Server `QueueExtension` |
| `ash-rs/auto-review` | `ext/guardian-reviewer` |
| `app-server/src/review.rs` | 模型适配归 `ext/guardian-v2`；授权模式判断归 `core/src/turn_policy.rs` |
| `app-server/src/server/goal_tool.rs`、Core Goal 提示与续跑策略 | `ext/goal` |
| `app-server/src/server/multi_agent_tools.rs`、角色选择逻辑 | `ext/agent`；App Server 仅获取已授权目录快照 |
| `app-server/src/marketplace_connector_runtime.rs` | `ext/mcp/marketplace`；Connector 声明解析归 `ext/connectors/declaration.rs` |

## Agent 共享讨论板

App Server 默认注册 `board_read` 与 `board_write`。同一 Session 内的根 Agent 和它逐层委托的成员共享讨论板；独立根 Thread、新分叉和其他 Session 各自隔离。调用方 Session、Thread、Turn 来自宿主，模型不能指定。成员参数使用 `spawn_agent` 返回的 Thread ID；`topic` 为消息板根帖的整数 ID。

| 工具与 action | 参数与行为 |
| --- | --- |
| `board_read: channels` | 列出频道；可用 `query` 搜索频道名 |
| `board_read: topics` | `channel` 必填；列出根帖预览和回复数 |
| `board_read: posts` | 可组合 `channel`、`topic`、`author`、`query`；按话题读取时包含根帖和回复 |
| `board_read: unread` | 分页列出当前 Agent 在各频道尚未确认的帖子预览；可用 `post` 读取全文 |
| `board_read: post` | `id` 必填；`offset` 默认 0，`chars` 默认 1000、最多 4000，按 Unicode 字符读取 |
| `board_write: create_channel` | `channel` 必填；创建频道并订阅该频道的新话题 |
| `board_write: post` | `channel`、`text` 必填；省略 `topic` 创建话题，指定根帖 ID 则回复；`notify` 可额外通知成员 |
| `board_write: subscription` | `channel`、`state` 必填，状态为 `on` 或 `off`；指定 `topic` 则修改话题订阅；每个 Agent 只能修改自己的订阅 |
| `board_write: acknowledge` | `through` 必填；确认自己已读完该帖子 ID 及以前收到的通知，不影响其他 Agent |

- 列表按创建序号倒序，接受 `limit` 和 `cursor`；默认 20 项、最多 50 项，返回 `items` 和 `next_cursor`。游标绑定讨论板、操作和筛选条件；未读列表还绑定当前 Agent。游标按最后返回项的序号推进；新增消息不改变后续页的位置。刷新时省略游标。
- 列表中的正文预览最多 200 字符，包含 `total_chars`；完整读取返回 `text`、`total_chars` 和 `next_offset`，读完时偏移为 null。每份成功结果最多 8000 字节，包含 JSON 转义和元数据；缩短页面时同步返回实际继续位置。
- 搜索使用 Unicode 大小写折叠后的子串，查询最多 2048 字节。频道名为 1–128 字节且不含首尾空白或控制字符；正文非空白、最多 65536 字节；显式收件人最多 256 个。
- 读取贡献与写入贡献分开注册，写入走现有 `ManagedStateWrite` 授权。频道创建、发帖和订阅修改都在同一事务中保存操作凭据；同一 Thread、Turn 与 operation 重试返回原结果，参数变化则报错。Code Mode 同一外层调用内的不同 operation 分别记录。
- 频道订阅通知新话题，话题订阅通知回复。发帖默认订阅该话题；显式退订后再次发帖不会恢复订阅，只有成员自己设置 `state: on` 才会恢复。其他 Agent 不能开启、关闭或恢复成员的订阅。`notify` 不改变订阅，也不能绕过对应频道或话题的显式退订。收件人去重并排除作者，跨树成员在写入前被拒绝。
- 发帖与收件人的未读记录在同一事务中保存。空闲 Agent 不会因帖子启动；下次运行时会自动看到未读总数、最新帖子 ID 和最多 8 条最新预览。未读记录跨回合和进程重启保留，超过预览数量的帖子仍可用 `board_read` 查看；读取后调用 `acknowledge` 确认。退订会清除对应频道或话题尚未确认的通知；重新订阅只接收之后的新帖。通知作为带来源的 Agent 消息提供，不与目录规则或其他指令合并。
- `created_at` 为宿主时钟的 Unix 毫秒数；未配置时钟时使用系统 UTC，配置时钟失败则写入失败。排序使用持久化序号，因此不受时钟回拨影响。
- 持久会话使用 profile 的 `state.sqlite3`，临时会话使用内存。归档保留讨论；删除 Session 在事务中清理频道、帖子、订阅、退订状态、未读记录和操作凭据，同时关闭该 Session 的讨论板，旧调用不能重新创建内容。
- 不存在的频道或消息、无效话题、重复频道、游标不匹配、越界参数和操作冲突均报告错误。数据库故障不重建或清空已有数据。

团队模式可用频道组织工作，用话题共享发现、阻塞、接口决定和验证证据。开发流程可按工作与阶段组织频道，报告中引用相应产物版本。讨论板不负责分工状态、阶段转换、权限授予或验收；模式入口状态见 [Agent 树](../../docs/core-multi-agent.md#31-团队共享讨论) 与 [Develop 设计](../../docs/develop.md#9-team-的位置)。

## 历史与任务笔记

- `history_list` 返回条目身份和分页位置，`history_read` 按条目身份读取，`history_search` 返回匹配条目和摘要。
- `notes_list`、`notes_read`、`notes_search` 读取当前 Thread 的任务笔记；`notes_write` 使用 `expected_revision`，`0` 表示创建。
- 读取正文使用字符偏移 `offset`，每页最多 16000 字符，并返回 `next_offset`；写入只返回路径和新 revision。
- 笔记路径是虚拟相对路径，不访问工作目录；单条最多 1 MB，每个 Thread 最多 128 条、合计 8 MB。
- 持久会话的笔记存入 profile 的 `state.sqlite3`，临时会话仅保存于内存；均与 Session 删除同步清理；它们不替代需要用户授权的长期 Memory。
- Session、Thread、Turn 身份来自宿主调用上下文，工具参数不能选择其他任务。

## 图片服务与署名策略

宿主可使用 `LocalAppServerOptions::with_image_generation_backend` 和 `with_git_attribution` 注入实现，也可通过现有 `--product-services` 文件配置：

```json
{
  "schemaVersion": 2,
  "imageGeneration": {
    "serviceName": "company-images",
    "endpoint": "https://images.example.com/generate",
    "credentialReference": "company-image-token"
  },
  "gitAttribution": {
    "coAuthor": "Agent <agent@example.com>",
    "pullRequestNotice": "Assisted by Agent"
  }
}
```

- 图片 endpoint 必须是无用户名和密码的 HTTPS URL。`credentialReference` 可省略；提供时从 profile SecretStore 读取 Bearer 凭据，产品配置不保存明文凭据。
- JSON 图片服务接收 `{ "prompt": "...", "reference_images": ["data:image/png;base64,..."] }`，返回 `{ "mime_type": "image/png", "base64": "...", "revised_prompt": "..." }`。
- `imagegen` 接受提示和最多五张参考图片；参考值是当前 Thread 的 `attachment:<item-id>` 或工具已返回的 `saved_path`。
- 当前 Thread 的已上传图片身份会进入模型输入；读取经原有附件服务校验。工具不能使用其他 Thread 的附件，也不能读取任意磁盘路径。
- 生成图片通过解码和大小限制后原子写入 profile 的 `generated-images/`；文件名由 Thread 范围与内容摘要生成。
- 图片调用需要原有审批链批准确切服务、网络、凭据及产物目录；远端生成不自动重试。观察到取消后不发布新文件。
- 未配置图片服务时不注册 `imagegen`；未配置署名策略时不添加署名指令。此处提供可配置的服务适配，不绑定其他产品的内部服务。

## 审核与验证

- 默认最多四个并发审核，共享隔离的模型运行时；单次任务的等待、执行和重试合计最多 90 秒。
- 仅明确标记为暂时性服务失败的请求重试，最多三次；无效 JSON、拒绝、权限扩大和取消不重试为批准。
- 超时、关闭或任务释放会取消并回收审核线程；审核结果必须绑定原 action digest 和 policy revision。
- Core 的 `decide_turn_action` 和 `ActionPolicyEngine` 保留最终授权权；`TurnActionPolicy` 组合宿主策略、隔离控制策略与审核能力，审核扩展只返回建议。
- 验证覆盖 Goal 续跑与恢复、Agent 角色选择、队列恢复、审核取消和重试、笔记重启与冲突、图片隔离和解码、真实 Turn 中的工具调用与审批，以及协议生成与客户端类型检查。
