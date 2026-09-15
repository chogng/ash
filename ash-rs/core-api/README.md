# `ash-core-api`

- 定义 `AgentRuntime` 的完整操作：提交、追加输入、交互恢复、取消、派生和恢复。
- 提供 `ThreadView`、`TurnView`、`SessionView` 只读结果，隐藏命令日志、投递标记和执行器内部状态。
- 定义模型调用、Hooks、策略评估、浏览器操作和执行观察契约。
- 定义写租约、工作树绑定、消息 checkpoint 和 Thread 更新接口。
- 统一接口使用的 `CoreError`，复用现有领域值与存储错误。
- 允许能力实现依赖契约，不引入 `ash-core` 执行代码。

依赖方向为 `ash-core → ash-core-api`、`ash-hooks → ash-core-api`。消费方使用
`core-api` dependency key 和 `core_api` Rust 路径；Core 不重新导出这些契约。
`just dependencies` 检查接口与 Hooks 的生产、构建依赖，禁止直接或间接引入 Core 或 App Server；
同时检查 Agent 请求处理模块，禁止直接访问 Core 实现。

App Server 的 Agent 请求处理依赖 `AgentRuntime`，装配代码创建 Core `Runtime`。
Thread 状态、恢复、执行循环、工具授权构造和调用时机由 `ash-core` 拥有。
策略版本检查与批准模式处理由 Core 的 `decide_turn_action` 统一执行；
策略契约只提供权威决策和可选自动审查能力，不实现权限规则或具体引擎适配。
`ToolService` 与其授权、执行事实仍由 Core 管理；`ThreadStore` 保持在
`ash-thread-store`。产品客户端继续使用 App Server。

完整边界见 [Core 架构](../../docs/core.md#7-依赖边界)。
