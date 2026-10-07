# `ash-rollout-trace`

- `capture_session_trace` 枚举 Thread 流并按根事件中的 `session_id` 分组，不读取 Session event log。
- `RolloutTrace` 保存 Session tree identity 与各 Thread 的原始有序事件；format version 当前为 `3`，不制造全局顺序。
- Trace 只在内存中返回，不能成为运行时事实源；写文件、脱敏、访问控制和上传由调用方负责。
- 导出所有被引用的嵌套历史前缀；源 Thread 删除后仍能读取保留的历史，文件对象本身不嵌入 trace。
