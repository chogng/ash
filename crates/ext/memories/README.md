# Memories Extension

- 通过 `ContextContributor` 为 Turn 首次模型调用提供有界记忆参考材料；Core 负责低信任层级、预算和重试时重新读取。
- 通过 `ReadOnlyToolContributor` 提供 `memories-scopes`、`memories-search` 与 `memories-read`。
- `memories-save` 使用 `ManagedStateWrite` 契约，只能写宿主授权范围内、用户允许模型保存的记忆。
- `memories-read` 在重新检查任务范围、读取授权、revision 与引用范围后返回完整正文，模型合并时必须保留已有事实并复用标题和 revision。
- 工具说明要求模型提炼已确认的长期事实；不保存凭据、临时进度或未经验证的检索内容。
- 只有当前任务存在已授权的模型保存范围时，才通过 `TurnInputContributor` 提供固定的自动整理说明；每次准备模型输入重新检查授权，不把记忆正文或作用域名称放入指令。
- `MemoryEventSink` 只发布已提交写入的范围与 catalog revision；重放不重复通知。
- `MemoryScopeProvider` 由宿主实现，每次根据可信 Session、Thread 身份解析当前可访问范围；工具参数不能指定任务身份或扩大范围。
- 搜索与引用读取都要求对应作用域开启 Memory 读取；默认关闭，撤销、删除和版本冲突在后续读取中生效。
- `memories-save` 将 Turn 取消令牌传到存储写事务；取消截止点与已提交结果按 [Memory API](../../../docs/ash-app-server-api.md#memory) 处理。
- 依赖 `memories` 的领域契约与 `extension-api` 的扩展契约；不依赖 Core、App Server、产品 UI 或存储实现。SQLite 仅用于集成测试。
- 工具参数和读取边界见 [Memory API](../../../docs/ash-app-server-api.md#memory)；验证使用 `just test ash-memories-extension`。
