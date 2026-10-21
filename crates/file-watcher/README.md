# `ash-file-watcher`

> 本 README 是共享 filesystem invalidation hint 的实现契约。Skill catalog 的扫描、校验与
> snapshot 发布语义由 [`docs/skills.md`](../../docs/skills.md) 维护；Git status 的重新查询、
> revision 与 notification 语义由 [`docs/git.md`](../../docs/git.md) 维护；directory
> `fs/changed` 的 root-relative 投影由
> [`docs/app-server-api.md`](../../docs/app-server-api.md#文件系统) 维护。

`ash-file-watcher` 提供基于 `notify` 的多订阅者路径监听、共享 backend watch ref-count、
缺失路径回退、RAII 注销和异步事件合并。它只报告“可能发生了变化”；消费者必须重新读取并验证
自己拥有的状态，不能把 backend event 当作文件或 catalog 事实。

macOS 默认使用 `notify` 的 FSEvents backend，在当前产品可执行文件的私有
`--ash-native-file-watcher` 子进程内运行。directory watcher 会递归覆盖整棵目录；不能改用
kqueue，因为它会为大量 watched entry 持有 file descriptor，并在大型工作区耗尽进程资源。
当宿主确认 requested/canonical namespace 不同（例如 `/var` 与 `/private/var`）时，可显式选择
`FileWatcherBackend::Polling`。原生 helper 初始化超过 2 秒、一次注册超过 1 秒、进程退出或
注册后的就绪事件无法送达时，该 watcher 记录 warning、终止并回收 helper，将全部现有 scopes
恢复到 200 ms polling，并发送 `RescanRequired` 弥补切换窗口。此恢复按 watcher 实例发生；
不会把所有目录永久改为 polling，也不会静默退化成 noop。Polling 仅对显式内容 scopes 比较
文件内容，缺失目标的 ancestor scopes 只检查 metadata，避免读取不相关兄弟文件。
macOS 的 polling 也运行在私有 `--ash-polling-file-watcher` helper 内：控制线程接受有界的完整 scope
快照并及时确认，内容扫描在独立线程执行，只保留尚未应用的最新快照。首次基线扫描完成后发送
`RescanRequired`，消费者须重读以覆盖注册到基线完成之间的变化；注册成功不表示基线已扫描完。
大目录的内容扫描不能阻塞产品初始化、scope 更新或退出；父进程关闭时终止并回收整个 helper。
合并尚未扫描的快照时保留当前 roots 的重绑标记；另以 inode 和纳秒 mtime 观察注册 root，补足
notify polling 的秒级目录时间比较，覆盖快速删除／重建且时间戳不变的情况。此观察只 stat roots，
不读取 ancestor 的兄弟文件内容。
仅用于原生 inode 恢复的 parent lease 不进入 polling；缺失目标的最近现有 ancestor 仍须监听。
这样切换不会枚举整个工作区父目录或系统临时目录。进程级原生故障会将新实例的探测推迟
30 秒；路径自身的注册失败不触发这个退避，现有健康监听继续运行。

每批根目录增删只提交一次原生 stream 变更。内容／metadata 修改直接投递 hint，不销毁监听；
只有 create、remove、rename 等可能替换 inode 的事件触发重绑。每次原生提交还在父进程拥有的
临时目录创建一个独立探针文件，须在 750 ms 内收到其 mutation；探针不会投影为产品事件，
helper 被终止后也由父进程清理。注册返回成功不等于已经验证事件投递正常。
hermetic Bazel toolchain 必须提供 FSEvents 所需的 `CoreServices` framework 链接边界；
Linux/Windows 继续使用 `notify` 的推荐平台 backend。

## 文件与职责

```text
src/
├── lib.rs                 # public exports、WatchPath 与 FileWatcherEvent
├── ingress.rs             # bounded callback admission、overflow recovery 与通知
├── channel.rs             # bounded pending hints、Receiver、throttle 与 debounce
├── registration.rs        # subscriber registration 与 RAII guard
├── state.rs               # private ref-count 和 per-subscriber state
├── matching.rs            # canonical namespace、missing-path fallback 与 scope matching
├── native.rs              # macOS helper、私有有界 IPC、就绪检测与进程回收
├── watcher.rs             # notify backend、watch reconfiguration 与 subscriber routing
└── file_watcher_tests.rs  # channel、scope、fallback、RAII、overflow 与 live backend tests
```

所有实现模块均为 private；crate 只显式导出 `FileWatcher`、subscriber/registration handle、
receiver wrapper、`WatchPath` 和 `FileWatcherEvent`。
macOS 另导出供 `ash-arg0` 调用的 native／polling helper role 标记与入口；产品须在普通参数解析前 dispatch，
该角色只连接继承的私有 socket，不打开 App Server 或加载产品状态。macOS Cargo 库测试由
`scripts/cargo.py` 准备相同 target／profile 的 `watch_probe` 并通过 `ASH_FILE_WATCHER_TEST_HOST`
传给测试进程，因为 libtest 不分发产品的 arg0 role；Bazel 的 macOS unit target 同样提供该 helper
作为 test runfile。Cargo 覆盖必须是存在的绝对 executable；Bazel 的相对 rootpath 只在
`TEST_SRCDIR`／`TEST_WORKSPACE` 指定的 runfiles 下解析。
正常产品仍使用自身的 arg0 入口，helper 子进程清空环境，不继承该测试覆盖或凭据。

## 公共契约

`FileWatcher::new()` 必须在当前 Tokio runtime 内调用。成功后，一个 OS watcher 被所有逻辑
subscriber 共享：

```text
notify callback
  → bounded ingress / mutation filter / overflow marker
  → Tokio event loop / backend-error escalation
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
| `RescanRequired { watched_paths }` | backend 报错或缓冲预算超限，事件可能丢失                     | 对列出的已注册 roots 做 scoped full rescan |

两种 event 都是 hint。`PathsChanged` 不证明路径仍存在、内容有效或 mutation 已稳定；rename 也可能
产生多个 backend event。`RescanRequired` 会覆盖同一 receiver 中尚未消费的 path-level hints。

`ThrottledWatchReceiver` 在第一次事件后限制最小发送间隔，适合需要持续刷新但限制频率的 manager。
`DebouncedWatchReceiver` 从第一条事件起收集固定窗口，适合一次 burst 后重建 snapshot。两者都保留
shutdown 前已 pending 的事件。去抖窗口复用 receiver 的有界 accumulator，不另建路径历史；
取消一次 `recv()` 不会重置已经开始的窗口或重扫期限。

### 事件风暴的预算与恢复

- Native callback／helper reader 的入口最多保留 1,024 条事件、4,096 条路径和 1 MiB
  路径存储（包括路径容量和向量条目）；access 事件在入口过滤。超限立即释放明细，保留一个
  `RescanRequired`。callback 不等待队列空位，也不执行 filesystem scan／watch／unwatch。
- 每个 subscriber 的路由和待消费路径集合最多保留 4,096 条路径、1 MiB 路径存储；超限转成
  该 subscriber 当前注册 roots 的完整重扫。重扫状态只保存当前 roots 的快照，不累积已注销
  roots 的历史。总开销仍随注册 scopes/subscribers 数量增长，预算不是整个应用或 OS 的内存限额。
- 入口恢复及每个 receiver 的连续全量重扫最短间隔为 1 秒，第一次立即可用。间隔内的新 hint
  合并且不会延后期限；取走 hint 后到来的变化保留为下一次 invalidation，避免丢掉扫描期间的写入。
  错误恢复优先于普通 rescan，不能用 overflow 覆盖掉需要重启／回退的 helper 故障。
- App Server codebase worker 另有 4,096 路径／1 MiB backlog 上限。只有一个执行中的 scan 和一个
  合并的待处理请求；重复 full scan 在上次完成后至少间隔 1 秒，关闭会中断该等待。

参考 [VS Code 的分批与缓冲上限](https://github.com/microsoft/vscode/issues/124723#issuecomment-864908953)
及 [notify 的阻塞回调死锁案例](https://github.com/notify-rs/notify/issues/463)。Ash 的超限策略保留
scoped rescan 语义，不把丢失细粒度事件当作“没有变化”。

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
- `FileWatcher` drop 先关闭私有 socket、终止并 wait helper、join reader，再清理临时探针；
  helper 的独立控制线程在父 socket EOF 时退出整个进程，避免父进程意外退出后留下卡住的
  FSEvents 线程。后台 loop 在 channel 关闭后退出；
- watcher 不持有 catalog snapshot、不执行业务 rescan、不发布产品 update；Polling 的内容
  比较和原生就绪探针仅服务于 invalidation 检测。

注册批次必须完成 backend commit 或显式 polling 恢复后才能返回 guard；两者都失败时回滚该批次
并返回错误。后续 callback 报错仍可能意味着事件丢失，consumer 必须消费 scoped rescan hint。

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
just verify ash-file-watcher --lib
bazel test //crates/file-watcher:file-watcher-unit-tests
```

最小原生对照位于 `examples/watch_probe.rs`。在独立临时目录执行 `native`、`ash`、`poll`
可分辨注册、写入通知及析构阶段；`native-delete` 与 `native-alias-delete` 对照 canonical／alias
目录删除。原生 API 可能不返回，须由外层进程设置 deadline 并终止、wait 超时探针。回归测试
覆盖普通写入不重建、批量提交、helper 不回复／非法回复／父 socket 关闭，以及切换后旧、新
scopes 的真实后续写入，不能只用一次 rescan 证明恢复。

修改 path normalization、recursive mode、missing-target fallback、backend error 或 event
coalescing 时，必须同步检查 `file_watcher_tests.rs`、本 README、
[`docs/skills.md`](../../docs/skills.md) 与 [`docs/git.md`](../../docs/git.md) 的 snapshot
invalidation 语义。接入新 consumer 时应把
其 owner 文档链接回本 README，而不是复制 backend 细节。
