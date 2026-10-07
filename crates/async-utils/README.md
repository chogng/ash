# `ash-async-utils`

> 本 README 解释 cancellation tree 的当前接口与 race semantics。跨 Agent、model、Tool 与 process
> 的 cancellation 演进见
> [`docs/ash-agent-runtime-architecture.md`](../../docs/ash-agent-runtime-architecture.md)。

`ash-async-utils` 默认仅提供依赖 `std` 的 cooperative cancellation。可选 `wait` feature
增加共享截止等待和通知，使用不要求调用方持有 Tokio runtime 的计时器；不拥有任务启动、
业务状态、持久计划、系统信号或进程终止。设计原因与成本边界见
[Agent 时间与等待](../docs/agent-wait.md)。

## 公共契约

| Symbol                         | 职责                                         | 关键语义                                                  |
| ------------------------------ | -------------------------------------------- | --------------------------------------------------------- |
| `CancellationSource<R>`        | 一个 domain 的 cancel authority              | clone 共享同一 domain；drop 不自动 cancel                 |
| `CancellationToken<R>`         | read-only observer 与 child-source factory   | child cancel 不影响 parent/sibling                        |
| `Cancellation<R>`              | effective signal                             | 保留 first winner 的 reason 与 origin ID                  |
| `CancelResult<R>`              | cancel race 结果                             | 区分本次 installed 与 already cancelled                   |
| `Cancelled<R>`                 | 等待 token cancellation 的 future            | drop 时注销 waiter                                        |
| `CancelOnDrop<R>`              | scope-exit cancellation guard                | `disarm` 后不 cancel                                      |
| `Cancelable<F, R>`             | inner future 与 cancellation 的 race wrapper | cancellation 每次 poll 优先检查；获胜时 drop inner future |
| `FutureCancellationExt`        | 所有 Future 的 extension trait               | 只在 drop-at-await 安全时使用                             |
| `wait_until`（`wait` feature） | 等待条件、单调截止时间与取消                 | 取消、就绪条件、截止按此顺序检查                          |
| `Notify`（`wait` feature）     | 业务 owner 的状态变化通知                    | 先 listen 再读状态；通知不保存业务数据                    |

默认 reason 是 `CancellationReason::{Requested, Shutdown, DeadlineExceeded}`。需要 domain-specific
reason 时使用 `CancellationSource::<R>::new_typed()`；`R` 不要求 `Clone`，signal 通过 `Arc` 传播。

## 内部接口地图

| Symbol                             | 可见性            | 当前职责                                            | 方向约束                                            |
| ---------------------------------- | ----------------- | --------------------------------------------------- | --------------------------------------------------- |
| `Node<R>`                          | crate-private     | 一个 cancellation domain 的 ID 与 mutex state       | 不暴露给 runtime 或 protocol                        |
| `State<R>`                         | private           | signal、weak children、waiters、waiter ID allocator | state transition 始终在同一 mutex 下                |
| `Signal<R>`                        | crate-private     | origin + reason                                     | descendants 共享同一 effective signal               |
| `Node::child_of`                   | crate-private     | 原子注册 child 或继承 parent signal                 | child creation 与 parent cancel 不能丢信号          |
| `cancel_tree`                      | crate-private     | iterative propagation、drain waiters/children       | 不递归；先标记整棵可达树，再 wake                   |
| `poll_cancelled`                   | crate-private     | register/refresh waiter waker                       | repoll 必须替换 stale waker                         |
| `remove_waiter`                    | crate-private     | future/drop cleanup                                 | pending future drop 后不能泄漏 waker                |
| `Cancelable::poll`                 | private impl path | cancellation-first race                             | inner poll 中触发 cancel 时，本次 inner output 获胜 |
| `NEXT_CANCELLATION_ID` / `next_id` | private           | process-local unique domain ID                      | overflow panic，不复用 identity                     |

## 调用图与 race 语义

```text
CancellationSource::cancel_with(reason)
├─ Signal { origin: source.id, reason }
├─ tree::cancel_tree(root, signal)
│  ├─ iterative pending stack
│  ├─ first signal per Node wins
│  ├─ inherit effective signal into descendants
│  ├─ drain weak children and waiters
│  └─ wake after reachable nodes are marked
└─ Cancelled | AlreadyCancelled(effective signal)

CancellationToken::cancelled
└─ Cancelled::poll
   └─ token.poll_cancelled
      └─ tree::poll_cancelled → ready signal or registered waiter

future.with_cancellation(token)
└─ Cancelable::poll
   ├─ poll cancellation first
   ├─ cancelled → drop inner, return Err
   └─ active → poll inner, return Ok or Pending
```

重要 race：

- child creation 与 parent cancellation 在 parent mutex 下序列化，因此不会 missed cancellation；
- domain 已有 signal 后，新 child 直接继承 effective signal；
- 两个 canceller 竞争时，每个 Node 的 first observed signal wins；
- inner future 在自己的 `poll` 内触发 cancellation 并同时 Ready，本次 output wins，因为 cancellation
  checkpoint 已经发生；
- waker 在离开 mutex 后调用，避免 wake path 重入锁。

方向偏差：

- 使用 strong child reference：完成的 child tree 会被 parent 永久保活；
- 递归传播：深 Agent tree 可能 stack overflow；
- plain source drop 自动 cancel：clone owner lifecycle 变得不可预测；
- `Cancelable` 尝试异步 cleanup：wrapper 越过 generic Future contract；
- token 可以 cancel 自己：observer/authority capability split 被破坏。

## 使用选择

使用 `with_cancellation` 仅当取消时直接 drop inner future 是安全的。需要 flush、rollback、关闭
protocol 或释放远端 lease 时，把 `CancellationToken` 传入 worker，并在安全点调用 `check()` 或
await `cancelled()`。

取消不能抢占阻塞系统调用、CPU 循环或没有观察令牌的分离任务。截止时间由调用方计时器决定，
再用 `cancel_with(DeadlineExceeded)` 传播。

## 测试与演进

```text
just test ash-async-utils --features wait --lib
bazel test //crates/async-utils:async-utils-unit-tests
```

测试覆盖 non-`Unpin` future、prior cancellation precedence、drop cleanup、first-reason wins、
concurrent child creation、waker replacement、deep iterative propagation 和 RAII guard。

等待测试覆盖截止到期、取消优先、注册后首次 poll 前的通知，以及在没有 Tokio runtime 时由
共享计时器唤醒。Future 释放时撤销计时和通知注册。纯取消消费者不启用 `wait` feature。
