# `ash-rollout`

- `LocalStateRepository` 在一个 Profile 下组合 `SqliteThreadStore`、writer lease 和附件存储。
- `recover_threads` 是本地 Core 恢复入口：枚举 Thread 事件流并恢复 `ThreadController`；不构造 Session authority。
- 本 crate 不定义事件、SQLite schema、reducer 或 trace format；这些分别属于 protocol/history、state、core 和 rollout-trace。
- 恢复入口可以注入 `core-api::ExecutionDiagnostics`；具体 Recorder 由 App Server profile owner 共享，本 crate 不依赖 rollout-trace 实现。
