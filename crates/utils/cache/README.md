# ash-utils-cache

- `BlockingLruCache` 提供有容量上限的进程内 LRU；同步方法在普通线程及 Tokio 单线程、多线程运行时中读写同一份缓存。
- 工厂函数和 `with_mut` 在同步锁内执行；回调不能重入缓存或等待异步工作。
- `sha1_digest` 为内容缓存键生成固定长度摘要；它只负责键计算，不负责持久化、过期策略或业务缓存所有权。
- 实现和独立测试位于 `src/lib.rs`、`src/cache_tests.rs`；修改锁定、淘汰或摘要语义后运行 `just test ash-utils-cache`。
