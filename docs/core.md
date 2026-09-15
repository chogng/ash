# Ash Core

> 本文说明 `ash-core` 的长期职责。领域身份见 [`domain-model.md`](domain-model.md)，事件契约见 [`protocol.md`](protocol.md)。

## 1. 结论

`ash-core` 以 Thread 为恢复、顺序和执行边界。它没有 SessionCoordinator，也不维护独立 Session 状态：同一 `session_id` 下的 Thread 组成一棵会话树，需要树级操作时由 `ThreadController` 枚举和协调这些 Thread。

```text
App Server
          │ typed request
          ▼
ThreadController
  ├── validate command + Thread sequence
  ├── produce ThreadEvent batch
  ├── append through ThreadStore
  ├── reduce committed events
  └── start / steer / cancel Turn execution
          │
          ├── MultiAgentCoordinator
          ├── TurnExecutor
          ├── ModelService
          └── Tool execution ports
```

## 2. 主要职责

| 组件 | 负责 | 不负责 |
| --- | --- | --- |
| `ThreadController` | Thread 创建、fork、rewind、Turn、Item、交互、目标、恢复 | JSON-RPC、SQLite、产品导航状态 |
| Thread reducer | 从有序 `ThreadEvent` 重建确定状态 | I/O、副作用、订阅发送 |
| `MultiAgentCoordinator` | 基于 Thread 拓扑 spawn、message、wait、cancel descendants | Session event saga |
| `TurnExecutor` | 模型循环、工具调度、取消、失败收口 | 持久层实现 |
| Context 组件 | 输入选择、预算、压缩与 checkpoint | Session 级共享可变历史 |

crate 的重点是能力与依赖隔离：Core 依赖 `ash-core-api` 中的宿主契约，不依赖 App Server、SQLite、TUI 或具体产品宿主。

## 3. Thread 与 Session tree

每个 Thread 快照至少包含：

```text
thread_id
session_id
parent_thread_id?
forked_from_id?
sequence
status
turns
```

`session_id` 只回答归属。树级 create、list、archive、stop 或 Agent descendant 操作由 Thread 数据计算，不建立第二份 membership log。

根 Thread 通常同时提供新的 `session_id`；创建同树分支时保留该 ID。需要开启新树的派生可以得到新的 `session_id`，因此 Core 永远读取显式字段。

## 4. 提交与恢复

一次状态改变遵循同一顺序：

1. 读取并恢复 Thread 快照；
2. 校验 `command_id`、`expected_sequence` 和当前状态；
3. 生成完整 `ThreadEventBatch`；
4. 由 `ThreadStore` complete-or-none 提交；
5. 只用已提交事件推进内存状态；
6. 再启动模型、工具或通知等外部副作用。

恢复只枚举 Thread 流并重放 reducer。Session tree 读取等价于按 `session_id` 分组恢复后的 Thread，不需要先恢复 Session。

## 5. Turn 执行上下文

Thread 可以保存默认执行参数，Turn 可以提供明确覆盖：

```text
effective context
├── EnvironmentRef
├── cwd
├── dirs
├── effective grants
├── model
├── approval mode
└── tool mode / tool profile
```

Environment 是执行位置；`cwd`、dirs 与 grants 是该位置内的有效工作范围。Core 不把它们包装成持久 Workspace 实体，也不把目录授权压成 trusted/untrusted。

创建 Turn 时，影响重放语义的选择必须冻结到 Turn 事实中。后续配置变化只能影响新的 Turn。

## 6. 多 Agent

子 Agent 是新的 Thread，不是 Session 内的轻量消息对象。持久子 Thread 通常继承父 Thread 的 `session_id`，并分别记录 `parent_thread_id` 与 `forked_from_id`。

多 Agent 协调只通过 `ThreadController` 创建和操作 Thread。父子消息、等待状态和取消结果都落入相关 Thread 的事件流；不得引入 Session 级 planned/attached 事件补偿链。

## 7. 依赖边界

```text
app-server ──► ash-core ──► ash-core-api
     │                          ▲
     └──────► ash-hooks ─────────┘

ash-core / ash-core-api ──► ash-protocol / ash-thread-store
ash-state ── implements ──► ash-thread-store
```

`ash-core-api` 定义模型调用、Hooks、策略评估、浏览器操作、执行观察、写租约、工作树绑定、
消息 checkpoint 和 Thread 更新契约，以及跨接口使用的 `CoreError`。能力实现直接导入
`core_api`，Core 不提供旧路径转发。策略接口保留版本检查与批准模式的默认语义；对
`ActionPolicyEngine` 的接口适配也由该契约 crate 承担。

`ThreadController`、`TurnExecutor`、归约与恢复仍在 Core。`ToolService`、工具授权凭据及
执行事实继续留在 Core，避免为了拆 crate 而公开原本受限的授权构造方法。
领域值仍由 `protocol` 拥有，存储接口仍由 `thread-store` 拥有；产品客户端继续通过
App Server 接入。契约清单见 [`ash-core-api`](../ash-rs/core-api/README.md)。

新增能力时先判断它属于 Thread 行为、Turn 执行、环境访问还是产品组织。只有 Thread 行为进入 Core；Project 归类、窗口导航和编辑器 Workspace 由产品层拥有。
