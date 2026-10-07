# `ash-rollout-trace`

- `capture_session_trace` 枚举 Thread 流并按根事件中的 `session_id` 分组，不读取 Session event log。
- `RolloutTrace` 保存 Session tree identity 与各 Thread 的原始有序事件；format version 当前为 `3`，不制造全局顺序。
- Trace 只在内存中返回，不能成为运行时事实源；写文件、脱敏、访问控制和上传由调用方负责。
- 导出所有被引用的嵌套历史前缀；源 Thread 删除后仍能读取保留的历史，文件对象本身不嵌入 trace。
- `ModelResponseEvaluated` 来自 Thread 的持久历史，保留循环动作、理由、停止原因、消息阶段和工具数；关闭详细诊断仍能读取这些决策。
- 完整模型响应的诊断正文保留有序消息及阶段；取消、失败和未完成 attempt 的部分正文也保存收到的消息 ID、内容及已知阶段，并限制正文大小与消息数。诊断不是恢复执行的事实源。
