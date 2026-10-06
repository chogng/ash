# `ash-file-watcher`

> 本 README 是共享 filesystem invalidation hint 的实现契约。Skill catalog 的扫描、校验与
> snapshot 发布语义由 [`docs/skills.md`](../../docs/skills.md) 维护；Git status 的重新查询、
> revision 与 notification 语义由 [`docs/git.md`](../../docs/git.md) 维护；directory
> `fs/changed` 的 root-relative 投影由
> [`docs/ash-app-server-api.md`](../../docs/ash-app-server-api.md#文件系统) 维护。

`ash-file-watcher` 提供基于 `notify` 的多订阅者路径监听、共享 backend watch ref-count、
缺失路径回退、RAII 注销和异步事件合并。它只报告“可能发生了变化”；消费者必须重新读取并验证
自己拥有的状态，不能把 backend event 当作文件或 catalog 事实。

macOS 默认使用 `notify` 的 FSEvents backend。directory watcher 会递归覆盖整棵目录；不能改用
kqueue，因为它会为大量 watched entry 持有 file descriptor，并在大型工作区耗尽进程资源。
当宿主确认 requested/canonical namespace 不同（例如 `/var` 与 `/private/var`）时，可显式选择
`FileWatcherBackend::Polling`；该 fallback 只用于 alias root，不是所有目录的默认策略。
hermetic Bazel toolchain 必须提供 FSEvents 所需的 `CoreServices` framework 链接边界；
Linux/Windows 继续使用 `notify` 的推荐平台 backend。

## 文件与职责

```text
src/
├── lib.rs                 # public exports、WatchPath 与 FileWatcherEvent
├── channel.rs             # lossless pending set、Receiver、throttle 与 debounce
├── registration.rs        # subscriber registration 与 RAII guard
├── state.rs               # private ref-count 和 per-subscriber state
├── matching.rs            # canonical namespace、missing-path fallback 与 scope matching
├── watcher.rs             # notify backend、watch reconfiguration 与 subscriber routing
└── file_watcher_tests.rs  # channel、scope、fallback、RAII、overflow 与 live backend tests
```

所有实现模块均为 private；crate 只显式导出 `FileWatcher`、subscriber/registration handle、
receiver wrapper、`WatchPath` 和 `FileWatcherEvent`。

## 公共契约

`FileWatcher::new()` 必须在当前 Tokio runtime 内调用。成功后，一个 OS watcher 被所有逻辑
subscriber 共享：

```text
notify callback
  → Tokio event loop
  → mutation filter / backend-error escalation
  → per-subscriber path matching
  → sorted + deduplicated pending hint
  → Receiver / ThrottledWatchReceiver / DebouncedWatchReceiver
```

`Arc<FileWatcher>::add_subscriber()` 返回独立的 `FileWatcherSubscriber` 和 `Receiver`。
`FileWatcherSubscriber::register_paths()` 接受一组 `WatchPath`，成功时返回
`WatchRegistration`，backend 注册失败时返回 `notify::Error`：

- 同一批次内重复的 exact path + recursive scope 会去重；
- 跨 registration/subscriber 的相同 OS path 通过 `PathWatchCounts` ref-count；
- 任意 recursive consumer 存在时 backend 使用 recursive mode；最后一个 recursive guard
  释放后降级为 non-recursive；
- `WatchRegistration` drop 只撤销该批注册；subscriber drop 撤销其全部注册并关闭 receiver；
- `FileWatcher::noop()` 保留注册/生命周期语义但不连接 OS backend，用于明确的 optional-runtime
  fallback；它不会自行产生事件。
- `FileWatcher::new_with_backend()` 允许 authority owner 显式选择 recommended 或 polling；
  不允许 backend failure 静默变成 noop。

### Event 语义

| Event                              | 含义                                                         | Consumer obligation                        |
| ---------------------------------- | ------------------------------------------------------------ | ------------------------------------------ |
| `PathsChanged { paths }`           | backend 观察到这些 subscriber-visible path 附近发生 mutation | 对受影响 scope 重新扫描并校验              |
| `RescanRequired { watched_paths }` | backend 报错，事件可能丢失                                   | 对列出的已注册 roots 做 scoped full rescan |

两种 event 都是 hint。`PathsChanged` 不证明路径仍存在、内容有效或 mutation 已稳定；rename 也可能
产生多个 backend event。`RescanRequired` 会覆盖同一 receiver 中尚未消费的 path-level hints。

`ThrottledWatchReceiver` 在第一次事件后限制最小发送间隔，适合需要持续刷新但限制频率的 manager。
`DebouncedWatchReceiver` 从第一条事件起收集固定窗口，适合一次 burst 后重建 snapshot。两者都保留
shutdown 前已 pending 的事件。

## Path 与 backend 边界

`matching::actual_watch_path` 为已存在目标保存 subscriber 请求路径，同时使用 canonical path
匹配可能被 OS 重写的 event namespace。缺失目标不会要求 broad recursive ancestor watch：

1. 从最近的现有 directory ancestor 建立 non-recursive watch；
2. ancestor event 只在目标出现/消失时映射回 subscriber 请求路径；
3. 中间 component 出现后，`watcher::apply_actual_watch_move` 把 ref-count 和 backend watch
   移到更近的路径；
4. consumer 最终看到原始请求 namespace，而不是 `/private/var` 等 canonicalization artifact。

Backend 只转发 create、modify 和 remove；access/open 事件被过滤。所有 backend callback error
都按可能丢事件处理，并通过 `watcher::require_rescan` 向每个 subscriber 发送其 own watched roots。

## 失败、并发与关闭

- `FileWatcher::new()` 在 backend 初始化失败或当前线程没有 Tokio runtime 时返回
  `notify::Error`；
- registration failure 同步返回；调用方必须选择显式失败、诊断或可解释的 manual-refresh
  fallback；
- 单个 backend watch/unwatch reconfiguration 失败会写 warning；现有注册状态仍保留，后续
  reconfiguration 可再次尝试；
- state lock 与 backend lock 始终按 state → backend 顺序获取，注册、注销和 watch mode
  reconfiguration 对其他操作呈一致顺序；
- receiver 不使用有界 mpsc 丢弃 path；pending path 存入 `BTreeSet`，因此批次稳定排序并去重；
- `FileWatcher` drop 释放 OS watcher sender，后台 loop 在 channel 关闭后退出；
- watcher 不读取文件、不持有 catalog snapshot、不自动 retry/rescan，也不发布产品 update。

注册时单个 backend `watch()` 失败当前只能记录 warning，不能同步回传给已经返回 guard 的 caller；
需要强一致启动的 manager 必须在首次 full scan 后保留显式 refresh/fallback 路径。这是当前限制，
不能把“registration 已进入 ref-count state”解释为 OS enforcement 已确认。

## 内部接口地图

| Symbol                                         | 拥有                                               | 架构漂移信号                              |
| ---------------------------------------------- | -------------------------------------------------- | ----------------------------------------- |
| `WatchState` / `PathWatchCounts`               | subscriber state 与共享 backend scope ref-count    | 开始保存 consumer snapshot/content        |
| `actual_watch_path` / `changed_path_for_event` | fallback、canonical matching 与请求 namespace 恢复 | 开始解释 catalog 或 directory 业务语义    |
| `FileWatcher::notify_subscribers`              | raw mutation 到 subscriber hint 的 routing         | 直接发布 App Server/product event         |
| `WatchSender` / `PendingEvent`                 | 每个 subscriber 的去重 pending 状态                | 引入 durable queue/replay contract        |
| throttle/debounce wrappers                     | delivery cadence                                   | 决定 manager 的扫描或 snapshot generation |

如果需要 ignore rules、fuzzy index 或文件内容检索，应分别由 consumer、`ash-file-search` 或
`ash-shell-command`/`rg` 负责，不应扩张本 crate。

## 验证与修改影响

```bash
cargo test --manifest-path Cargo.toml -p ash-file-watcher
cargo clippy --manifest-path Cargo.toml -p ash-file-watcher \
  --all-targets --no-deps -- -D warnings
bazel test //ash-rs/file-watcher:file-watcher-unit-tests
```

修改 path normalization、recursive mode、missing-target fallback、backend error 或 event
coalescing 时，必须同步检查 `file_watcher_tests.rs`、本 README、
[`docs/skills.md`](../../docs/skills.md) 与 [`docs/git.md`](../../docs/git.md) 的 snapshot
invalidation 语义。接入新 consumer 时应把
其 owner 文档链接回本 README，而不是复制 backend 细节。
