# `ash-protocol`

- 定义稳定 ID，以及 Thread、Turn、Item、交互、工具、执行策略、模型调用事实和精确费用字符串等共享领域类型；`Session` 只是按 `session_id` 聚合 Thread 的只读视图。
- `ThreadCommand` 表达意图，`ThreadEvent` 是唯一持久事实，`ThreadUpdate` 服务订阅者；没有 Session command、event、update 或独立 sequence。
- 自动审查因连续拒绝触发停止时，`TurnInterrupted.error` 保存不可重试的 `policyCircuitBreaker` 原因；普通取消不携带错误。子代理交付 `PolicyDenied` 结果，父代理应告知用户停止原因，不得自动恢复被拒工作或换路执行同一目标。
- 本 crate 只拥有共享数据类型及 serde/schema 契约，不拥有 reducer、运行时、数据库或产品 UI。

## 模型契约的阅读入口

`src/model.rs` 汇总公开类型；子文件按数据含义组织，而不是把整条调用链放进一个文件。

| 文件 | 定义什么 |
| --- | --- |
| [`model/identity.rs`](src/model/identity.rs) | Provider、连接、模型 ID 与准确模型引用 |
| [`model/reasoning_effort.rs`](src/model/reasoning_effort.rs) | 推理档位请求值及目录中的档位说明 |
| [`model/catalog.rs`](src/model/catalog.rs) | 模型规格、能力、访问方式、可用性与目录来源状态 |
| [`model/settings.rs`](src/model/settings.rs) | 支持的参数、请求默认值、服务等级与加速声明 |
| [`model/message.rs`](src/model/message.rs) | 模型输入消息、媒体内容、推理历史与工具调用/结果 |
| [`model/invocation.rs`](src/model/invocation.rs) | 一次调用的请求、响应、输出方式和流式增量 |
| [`model/usage.rs`](src/model/usage.rs) | 供应商用量、请求估算和累计结果的数据格式 |
| [`model/context.rs`](src/model/context.rs) | Core 计算后的上下文分类、来源与预算检查结果 |
| [`model/accounting.rs`](src/model/accounting.rs) | 调用事实、计价证据、精确金额和参考成本结果 |

目录中的 `ModelSettings` 是参数声明；某一次调用选定的参数属于 `ModelRequest`。名称和说明可以作为
共享目录数据保留，但协议不选择型号、应用加速偏好或准备供应商请求。

本 crate 保留 ID、字段引用与数据自身的合法性校验，以及序列化、构造和只读访问。改变请求或
累计执行状态的算法归所属领域：图片清晰度处理由 `model-provider` 执行，尺寸与 patch 限制由
`utils/image` 的 `PromptImageDetailLimits` 表达，Core 在附件准备时选择相应限制；token 累计由
Core 的状态归并执行，精确费用累计由 `model-accounting` 计算，Core 负责提交新结果。
