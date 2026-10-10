# `ash-rollout-trace`

- `capture_session_trace` 枚举 Thread 流并按根事件中的 `session_id` 分组，不读取 Session event log。
- `RolloutTrace` 保存 Session tree identity 与各 Thread 的原始有序事件；format version 当前为 `3`，不制造全局顺序。
- Trace 只在内存中返回，不能成为运行时事实源；写文件、脱敏、访问控制和上传由调用方负责。
- 导出所有被引用的嵌套历史前缀；源 Thread 删除后仍能读取保留的历史，文件对象本身不嵌入 trace。
- `ModelResponseEvaluated` 来自 Thread 的持久历史，保留循环动作、理由、停止原因、消息阶段和工具数；关闭详细诊断仍能读取这些决策。
- 完整模型响应的诊断正文保留有序消息及阶段；取消、失败和未完成 attempt 的部分正文也保存收到的消息 ID、内容及已知阶段，并限制正文大小与消息数。诊断不是恢复执行的事实源。

本 crate 实现 `core-api::ExecutionDiagnostics`，由 App Server profile owner 组合；Core 的生产代码不依赖本实现。`TraceReader` 使用 `ThreadHistoryReader` 读取已有历史并核对所属 Session，诊断正文再检查 capture、保存引用与摘要。录制关闭时没有 worker、队列、文件或诊断正文副本；启用后使用有界队列和字节预算，JSON、摘要和磁盘写入在后台执行。

诊断格式为 V2，外层 rollout 仍为 V3。`pendingRecords` 描述尚待写入的已接纳事件；`modelAttemptAccounted` 仅在实际账目提交成功后关联 invocation ID 与历史 sequence。队列丢失、存储不可用和未闭合 attempt 保留覆盖缺口。读取、导出和停止可使用有期限的 flush；普通 Turn 完成不等待诊断落盘。删除 Session 停用旧句柄并异步清理，迟到回调不能重新创建 capture。

资源配额、Rust／TypeScript 分工、扩展边界和验证见[架构说明](../../docs/trace-design.md#已实现的资源和证据边界)。前端通过独立只读服务复用现有连接，按需加载；评测不要求桌面界面存在。

任务效果由[独立评测 runner](../../test/agent-eval/README.md)验收保存的成果；Trace 提供过程证据。
[只读分析层](../../scripts/agent_eval_trace.py)消费导出的 V3 文件，保留指标覆盖、冻结指令选择、
循环决策和观察对应的 Thread／Turn／事件位置，不添加运行时事件或调度状态。
诊断未开启时 attempt 计数未知；丢失记录、缺失或截断正文必须与观察一起保留。
工具错误、模型 attempt 失败和循环停止不直接决定任务是否通过，也不单独证明重试或失败原因。
