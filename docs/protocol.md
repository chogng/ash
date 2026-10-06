# Ash 协议模型

> 本文说明共享领域协议的长期边界。概念命名以 [`domain-model.md`](domain-model.md) 为准，App Server 的 JSON-RPC 方法以 [`ash-app-server-api.md`](ash-app-server-api.md) 为准。

## 1. 唯一事实源

对话只保留一条持久事实链：

```text
ThreadCommand
    │ Core 接受并执行
    ▼
ThreadEvent
    │ ash-history 包装稳定存储元数据
    ▼
StoredEvent
    │ ash-thread-store 校验原子追加
    ▼
ash-state / SQLite
```

`ThreadEvent` 保存 Thread、Turn、Item、交互、目标和分支事实。Thread 自己拥有 sequence；任何写入都必须针对一个明确的 Thread 检查 `expected_sequence`。

Session 没有 command、event、update、store 或 sequence。`Session` 只是查询端按 `Thread.session_id` 得到的树视图：

```text
get_session(S1) = all Threads where thread.session_id == S1
```

因此不能把多个 Thread 的 sequence 取最大值后伪装成 Session sequence，也不能用 Session sequence 并发控制某个 Thread。

## 2. 身份

| 字段               | 含义                        | 约束                                    |
| ------------------ | --------------------------- | --------------------------------------- |
| `agent_id`         | 长期 Agent 身份             | 可跨任务绑定多个 Thread，不共享执行状态 |
| `session_id`       | Thread tree 的共同分组身份  | 保存在每个 Thread 上                    |
| `thread_id`        | 一条具体分支的地址          | 持久化、恢复和执行边界                  |
| `parent_thread_id` | 拓扑父 Thread               | 不替代 `session_id`                     |
| `forked_from_id`   | 内容从哪个 Thread 派生      | 与拓扑父关系分别表达                    |
| `turn_id`          | Thread 内的一次执行周期     | 随 Thread 事件保存                      |
| `item_id`          | Turn 内的具体内容或工具活动 | 随 Thread 事件保存                      |

根 Thread 常见 `thread_id == session_id`，但调用方不得依赖这个关系推断归属；是否同树只看显式 `session_id`。

Agent 身份与云端认证分开。历史版本 16 起的 `ThreadCreated` 记录 `agent_id` 和来源；当前 Agent 记录、绑定、事件与目录记录随首次 Thread 同事务提交。普通 fork、消息恢复、rewind 和 replacement 保留 AgentId，当前普通委托创建独立 AgentId。删除任务只删除所属 Thread，Agent 身份继续保留。目标 [Agent Team](../ash-rs/docs/agent-teams.md) 要求成员可先于 Thread 获得 AgentId，并在后续任务中明确复用该身份；这不改变已创建 Thread 的身份或来源。

历史版本 12–15 的各个 Thread 在迁移时获得独立的 `legacy-agent:<thread_id>`；已有 fork 不追溯合并身份。迁移保存可验证的来源锚点，保留原事件字节；迁移后的新 fork 延续源 AgentId。

Project 是可选的长期组织关系，不参与上述身份、顺序或恢复。Environment、目录和授权也不是对话身份的一部分。

## 3. Command、Event 与 Update

| 类型            | 用途                                         | 是否持久化                               |
| --------------- | -------------------------------------------- | ---------------------------------------- |
| `ThreadCommand` | 调用方请求改变一个 Thread                    | command receipt 随已接受写入保存         |
| `ThreadEvent`   | 已发生且可重放的领域事实                     | 是                                       |
| `ThreadUpdate`  | 面向订阅客户端的 committed 或 transient 变化 | committed 内容来自事件；transient 不保存 |

Command 使用稳定 `command_id` 实现幂等。相同 `command_id` 与相同 payload 可以返回已有结果；相同 ID 与不同 payload 必须明确报错。

Event 只描述领域事实，不携带数据库行号。`StoredEvent` 才增加 event ID、时间戳、schema version、sequence 与 receipt。Store 不解释业务，只校验完整性和原子提交。

Update 不能成为第二事实源。连接断开后，客户端先读取 Thread 快照，再用 `after_sequence` 订阅缺口；临时输出只用于当前连接。

## 4. App Server 的 Session 接口

`session/read`、`session/list` 和 `session/subscribe` 提供树级读取便利，但返回的是派生视图。`session/request` 中：

- Create、fork、rewind、archive 和 stop 请求使用 `session_id` 确定分组；
- start、steer、interrupt、resolve 等 Thread 写入把 `expected_sequence` 放在具体请求分支内；
- model、approval mode 和 current Thread 不保存为 Session 字段。model 由执行配置选择，approval mode 在创建 Turn 时冻结，current Thread 属于产品导航状态。

Session 订阅没有 Session update gap。它返回当前树视图、各 Thread 快照、各自的 committed gap 和 Agent tree；后续变化继续通过 Thread update 通知。

## 5. 所有权

| crate                     | 负责什么                                            |
| ------------------------- | --------------------------------------------------- |
| `ash-protocol`            | 共享领域类型、稳定 ID、serde/schema                 |
| `ash-history`             | `ThreadEvent` 的持久记录格式                        |
| `ash-agent-graph-store`   | Agent 身份、Thread 绑定和委托关系读取契约           |
| `ash-thread-store`        | Thread 流读取、Session 成员查询、原子追加和冲突校验 |
| `ash-core`                | 命令执行、reducer、恢复与运行状态                   |
| `ash-state`               | SQLite 实现与迁移                                   |
| `ash-app-server-protocol` | JSON-RPC DTO、方法注册和生成 schema                 |

## 6. 消息恢复点与共享历史

| 内容                | 保存什么                                      | 恢复时怎么用                     |
| ------------------- | --------------------------------------------- | -------------------------------- |
| `MessageCheckpoint` | 原消息的 Thread、sequence、前后边界和文件版本 | 在选定消息前或后创建执行分支     |
| `HistoryPrefixRef`  | 原事件前缀的摘要和来源位置                    | 共享原记录；分支只追加自己的事件 |
| `ContextCheckpoint` | 覆盖指定 Items 的压缩摘要                     | 仅用于模型输入，不替代消息恢复点 |
| Rollout trace       | Thread 事件和完整的被引用前缀集合             | 导出可独立读取的对话事实         |

历史版本 17 的新分支用 `ThreadCreated` 与 `HistoryPrefixBound` 固定来源。原 event ID、Thread ID、sequence 和记录字节保持不变；父分支继续执行不改变已有前缀。第一段未结束的执行保留已记录消息，并标为 Interrupted；未配对的 Tool Call 附加确定性的中断结果，不继承工具执行资格。中断结果的生成属于历史版本 17 的重放规则，不能无版本修改其文本或身份。

消息恢复保留 AgentId、Session 和冻结配置，在新目录还原文件。原路线继续保留；服务端停止恢复操作开始时仍在运行的源 Turn 及其委托后代，之后提交到源路线的新消息不会被带入新分支。外部系统已经发生的副作用不属于文件恢复范围。

文件捕获按 Thread 绑定到其工作目录 owner；同一 Profile 的多个目录不能互相覆盖捕获服务。Git 恢复点固定仓库相对路径、tree、目标 commit 和私有引用；旧分支目录清理后仍可通过原始源目录重建。非 Git 目录、写工具运行期间的消息或捕获失败会记录明确的不可用原因。旧历史没有逐消息文件证据时不补造恢复点；已有 Turn 级 rewind 入口仍按其原证据恢复。

SQLite event-store 版本 7 按内容保存一次原始记录，通过 Thread 和前缀引用关联。分支、前缀和 Agent 绑定原子提交；损坏或缺失的前缀明确失败。删除最后一个引用后才回收原记录与 Git pin；Git 清理失败保留待办，重启继续处理。压缩不会触发原始历史删除。

## 7. 修改检查

修改协议时必须确认：

- 新事实是否确实属于某个 Thread；
- 是否误建了 Session 的可写状态或全局 sequence；
- fork 后的 `session_id`、父关系和来源关系是否分别明确；
- durable 与 transient 是否仍能清楚区分；
- Rust 类型、JSON schema、TypeScript 生成物、测试 fixture 和文档是否同步。
