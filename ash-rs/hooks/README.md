# `ash-hooks`

> 本 README 负责 Ash 原生声明式 Hook 运行时的实现契约。Core 安全点和执行顺序的跨系统语义见
> [`docs/core.md`](../../docs/core.md)，持久化声明与作用域解析见
> [`docs/config.md`](../../docs/config.md)。

`ash-hooks` 在宿主已经授权的目录中，把不可变 Hook 配置快照转成经过动作策略评估的沙箱
进程。它拥有精确匹配、稳定执行顺序、Ash JSON 输入输出、动作身份、执行限制、运行记录和目录
绑定；不拥有配置持久化、Core 安全点、目录授权、Provider DTO、外部 Hook 方言或批准界面。

## 所有权与依赖方向

| 责任 | Owner | 本 crate 的边界 |
| --- | --- | --- |
| `beforeTool`、`afterTool`、`turnCompleted` 安全点 | `ash-core` | 不决定调用时机 |
| Hooks 类型化请求和服务接口 | `ash-core-api` | 实现 `HookService` |
| `beforeTool` 拒绝后的模型可见工具失败 | `ash-core` | 返回 `BeforeToolHookDecision`，不直接写 Thread |
| `HookId`、matcher、action 与 desired enablement | `ash-config` | 消费完整 `HooksConfig` 快照，不读写配置文件 |
| 匹配、JSON codec、动作评估与沙箱进程 | `ash-hooks` | 唯一原生 Hook 运行时 owner |
| 目录 `ExecuteProcess` capability 与 Authorization | App Server / file-access | 宿主取得 Authorization 后才能调用 `bind_dir` |
| RPC DTO、配置 mutation 与运行状态通知 | App Server protocol / App Server | 当前只组合 runtime，尚未投影 `recent_runs` |

依赖方向是 `ash-hooks → ash-core-api`；`ash-core` 消费相同契约，不得反向
依赖本 crate。Hooks 不依赖 Core 执行实现。`ash-hooks → ash-config` 只消费无运行时状态的声明；有界 `HookRunRecord` 只存在于
进程内，不写回 Config，也不是持久化 Thread 事实。

## 公共契约

`DeclarativeHookRuntime::new` 接收初始 `HooksConfig` 和宿主动作策略。调用方随后可以：

- 使用 `replace_config` 原子替换未来调用读取的声明快照；
- 在取得目录执行 Authorization 后使用 `bind_dir` 安装沙箱进程执行器；
- 使用 `unbind_dir` 立即移除进程执行能力；
- 把 runtime 作为 `Arc<dyn core_api::HookService>` 注入 `TurnExecutor`；
- 使用 `recent_runs` 读取最近 128 条非持久化运行投影。

`replace_config` 不改变正在执行的 invocation：`run_event` 在开始时克隆完整配置快照和当前 process
binding。没有目录 binding 时，事件成功执行为空操作；缺少执行 capability 时不会构造或保留
进程执行器。

## 原生进程协议

每个匹配的 Hook 从 stdin 接收一个不带 Provider 信息的 Ash JSON 对象：

```json
{
  "protocolVersion": 1,
  "hookId": "user:hook:audit",
  "dir": "/canonical/dir",
  "event": {
    "name": "beforeTool",
    "threadId": "thread-7",
    "turnId": "turn-3",
    "toolCallId": "tool-9",
    "toolName": "shell-command"
  }
}
```

`afterTool` 额外携带 `outcome: "succeeded" | "failed"`，但不暴露原始工具输出；`turnCompleted`
只携带 Thread 和 Turn identity。完整 stdin 最大 64 KiB，超过限制时不启动进程。

空 stdout 表示继续，用于兼容既有 Ash Hook。非空 stdout 必须严格匹配以下一种对象：

```json
{"decision":"continue"}
{"decision":"deny","reason":"blocked by repository policy"}
```

只有 `beforeTool` 可以返回 `deny`。Core 将拒绝原因保存为对应 Tool Call 的错误结果，模型可以在同一
Turn 的下一步看到该反馈。`afterTool` 和 `turnCompleted` 已处于提交后的观察点，返回 `deny` 是协议
错误，不能倒转已经发生的结果。

## 内部接口与调用关系

| Symbol | 职责 | 不得承担 |
| --- | --- | --- |
| `DeclarativeHookRuntime::run_event` | 冻结快照、按 `BTreeMap` identity 匹配、协调 policy/process/record | 不读取 mutable Config authority 或安排 Core 安全点 |
| `matcher::matches_event` | 将 Core 类型化 invocation 与 declaration event/tool matcher 对齐 | 不添加隐式 glob/regex 语义 |
| `protocol::encode_input` | 构造并限制 Ash 原生 stdin JSON | 不引用 Provider 或外部 Hook 方言字段 |
| `outcome::parse_output` | 校验退出状态、截断标记和严格 decision JSON | 不决定 Core 如何应用拒绝 |
| `policy::execution_authority` | 构造 review 并把 exact grant 转换成 process authority | 不自行授予权限 |
| `policy::review_request` | 将 Hook ID、program、arguments 与 canonical directory 绑定为动作摘要 | 不执行进程 |
| `process::HookProcessExecutor` | 隔离可测试的目录进程 seam | 不成为公共插件扩展面 |
| `process::NativeHookProcessExecutor` | 使用统一 `CommandExecutor`、原生 sandbox 和固定限制 | 不读取信任配置或放宽策略决定 |
| `records::HookRunLog` | 保留最近 128 条 running/continued/denied/failed 投影 | 不成为 durable authority |

```text
Core typed Hook safe point
└─ HookService::{before_tool,after_tool,turn_completed}
   └─ DeclarativeHookRuntime::run_event
      ├─ matcher::matches_event
      ├─ records::HookRunLog::start
      ├─ policy::execution_authority
      ├─ protocol::encode_input
      ├─ process::HookProcessExecutor::execute
      │  └─ CommandExecutor → native sandbox → process
      ├─ outcome::parse_output
      └─ records::HookRunLog::finish
```

## 安全与失败语义

- 每个动作摘要绑定 Hook ID、完整 argv 和 canonical directory；Authorization 必须再次匹配动作摘要、能力
  集合与策略版本。
- 默认沙箱允许目录读写、拒绝网络，并把 process spawn capability 绑定到声明的 program。
- Windows 按 MXC、账户沙箱顺序选择后端，原样保留动作策略返回的隔离和 ACL 要求；默认严格隔离不能由账户沙箱满足。启动错误不会换后端重跑。
- stdin、stdout 与 stderr 均有 byte 上限；单个进程最长运行 30 秒，captured output 总上限为
  64 KiB。
- 非零退出、截断、非空但无效的 JSON 和空拒绝原因都是执行失败，不会被解释成继续。
- `AskUser` 不会从后台 Hook 打开交互式批准，而是失败关闭；block、revision mismatch 与错误 grant
  同样不能执行。
- 取消在事件开始、每个 Hook 之前和进程执行期间观察。Core 在 durable Turn completion 后忽略
  `turnCompleted` failure；`beforeTool` 和 `afterTool` failure 返回 Tool scheduler。
- `HookDirBindingError` 只表示无法为获准目录构造 sandbox；缺少 Authorization 时不得调用 `bind_dir`。

## 验证与修改影响

```text
just test ash-hooks
just test ash-core
bazel test //ash-rs/hooks:hooks-unit-tests
```

测试覆盖稳定 identity 顺序、精确 event/tool matcher、disabled declaration、取消、动作摘要、Ash JSON
输入、严格 outcome、类型化拒绝、模型可见工具反馈、运行记录和共享 executor stdin。修改事件种类时
同步检查 `ash-core` 安全点、`ash-config` declaration、App Server DTO/schema 与本文档；修改 action
shape、capability、sandbox policy 或 stdin 时同步检查 `ash-action-policy`、`ash-tool-executor` 和权限
文档。

当前只支持 Ash 原生 process action，以及 macOS、Linux 和 Windows 原生 sandbox。并行 Hook、retry、
持久化 execution record、环境变量声明、网络 capability、工具输入改写、`afterTool` 上下文注入和外部
Hook 方言均未实现；增加这些能力必须先定义当前 consumer、durability、policy 与 secret boundary。
