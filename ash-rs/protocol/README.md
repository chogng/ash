# `ash-protocol`

- 定义稳定 ID，以及 Thread、Turn、Item、交互、工具、执行策略、模型调用事实和精确费用字符串等共享领域类型；`Session` 只是按 `session_id` 聚合 Thread 的只读视图。
- `ThreadCommand` 表达意图，`ThreadEvent` 是唯一持久事实，`ThreadUpdate` 服务订阅者；没有 Session command、event、update 或独立 sequence。
- 自动审查因连续拒绝触发停止时，`TurnInterrupted.error` 保存不可重试的 `policyCircuitBreaker` 原因；普通取消不携带错误。子代理交付 `PolicyDenied` 结果，父代理应告知用户停止原因，不得自动恢复被拒工作或换路执行同一目标。
- 本 crate 只拥有共享数据类型及 serde/schema 契约，不拥有 reducer、运行时、数据库或产品 UI。

## 目录表示什么

目录按业务对象组织；只有包含独立契约的文件才拆开。文件名描述其中的数据，不用 `model.rs`
泛指所有业务对象，也不用管理器的名字暗示这里有运行时实现。

| 入口                                                    | 用途与主要文件                                                                                                                                                              |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`thread.rs`](src/thread.rs) / `thread/`                | 一条独立执行分支：`thread.rs` 定义当前状态，`command.rs` 是调用方意图，`event.rs` 是持久事实，`update.rs` 是订阅更新；历史、目标和压缩检查点也归 Thread                     |
| [`turn.rs`](src/turn.rs) / `turn/`                      | 一次已接受的任务：`turn.rs` 定义当前状态，`instructions.rs` 是冻结指令，`execution_kind.rs` 是执行目的，`review_target.rs` 是代码审查目标，`tool_profile.rs` 是冻结工具清单 |
| [`session.rs`](src/session.rs) / `session/`             | 按 Session ID 分组的 Thread 视图：`session.rs` 定义只读快照，`summary.rs` 是状态与活动摘要，`thread_origin.rs` 是分支来源；这里没有 Session 管理器实现                      |
| [`model.rs`](src/model.rs) / `model/`                   | 模型规格、输入输出与调用事实；详细入口见下表                                                                                                                                |
| [`guardian.rs`](src/guardian.rs)                        | Guardian 共享审核数据：动作身份、能力、证据、风险等级、建议及其绑定的审核结果                                                                                               |
| [`interaction.rs`](src/interaction.rs) / `interaction/` | 用户输入、批准、提问和客户端工具；`turn_interaction.rs` 定义待处理交互、期限、取消及投递信封                                                                                |
| [`item.rs`](src/item.rs) / `item/plan.rs`               | 可持久化的对话条目与计划进度；不是供应商请求消息或任务调度器                                                                                                                |
| [`config.rs`](src/config.rs) / `config/`                | `preferences.rs` 定义共享偏好取值，`patch.rs` 区分不更新、清空和替换；不负责配置存储和优先级                                                                                |
| [`ids.rs`](src/ids.rs)                                  | 执行、任务和交互 ID 的声明与公共校验；模型身份单独归 `model/identity.rs`                                                                                                    |

## `models.json` 从哪里定义

[`StaticModelSpec`](../model-provider-info/src/static_model_spec.rs) 才是
[`models.json`](../model-provider-info/models.json) 的解析入口，字段注释进入生成的
[`models.schema.json`](../model-provider-info/models.schema.json)，为编辑器提供字段解释。
协议模块的划分帮助说明含义，但不会自动决定 JSON 的层级和字段命名。

模型规格和参数声明的 JSON 字段使用 `snake_case`：`ModelInfo`、`ModelCapabilities`、
`ModelPreset`、`ModelSettings` 和 `ModelAcceleration` 与静态目录使用相同命名。
模型列表与偏好更新协议也遵循这一约定，前端适配器负责转换为业务类型的驼峰字段。
推理档位等参数值保留各自约定，例如 `extraHigh`；供应商接口按其自身协议编码。

Rust 文件、模块、函数和字段使用 `snake_case`，类型和枚举成员使用 `PascalCase`，
完整规则见 [Rust 命名规范](../../.github/instructions/rust-coding-guidelines.instructions.md#naming-and-json-contracts)。
JSON 命名按完整接口契约推广；当前统一范围是模型声明、目录元数据、模型列表和偏好更新。
模型调用、消息、用量、配置存储及供应商报文按各自契约编码。修改其他接口的 JSON 字段时，
同步调用方、校验、序列化测试、生成产物、文档和受影响的协议或存储版本。

| 编辑内容                     | 类型及阅读入口                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `provider_id`、`model_id`    | `StaticModelSpec` 保存编辑值，`model/identity.rs` 定义准确身份；连接 ID 不属于模型身份                                   |
| 容量、能力、推理选项和默认值 | `StaticModelSpec` 转换成 `model/catalog.rs` 的 `ModelInfo`；档位语义见 `model/reasoning_effort.rs`                       |
| `settings`                   | `model/parameters.rs` 的参数声明与约束；JSON 用 `true / false / null` 表达支持、不支持、未知，协议用 `CapabilitySupport` |
| `model_messages` | `StaticModelSpec` 的基础正文、工具说明、模式与根／子 Agent 指导；每段正文摘要生成版本标识，随选择冻结，不包含实际授权或工具参数 |
| 某次请求的参数与输入         | `model/invocation.rs`、`model/message.rs`；不写入静态模型目录                                                            |
| 上下文检查、用量与费用结果   | `model/context_inspection.rs`、`model/usage.rs`、`model/accounting.rs`；由执行过程产生，不是模型规格                     |

## 模型契约的阅读入口

`src/model.rs` 汇总公开类型；子文件按数据含义组织，而不是把整条调用链放进一个文件。

| 文件                                                             | 定义什么                                        |
| ---------------------------------------------------------------- | ----------------------------------------------- |
| [`model/identity.rs`](src/model/identity.rs)                     | Provider、连接、模型 ID 与准确模型引用          |
| [`model/reasoning_effort.rs`](src/model/reasoning_effort.rs)     | 推理档位请求值及目录中的档位说明                |
| [`model/catalog.rs`](src/model/catalog.rs)                       | 模型规格、能力、访问方式、可用性与目录来源状态  |
| [`model/parameters.rs`](src/model/parameters.rs)                 | 支持的参数、请求默认值、服务等级与加速声明      |
| [`model/message.rs`](src/model/message.rs)                       | 模型输入消息、媒体内容、推理历史与工具调用/结果 |
| [`model/invocation.rs`](src/model/invocation.rs)                 | 一次调用的请求、响应、输出方式和流式增量        |
| [`model/usage.rs`](src/model/usage.rs)                           | 供应商用量、请求估算和累计结果的数据格式        |
| [`model/context_inspection.rs`](src/model/context_inspection.rs) | Core 计算后的上下文分类、来源与预算检查结果     |
| [`model/accounting.rs`](src/model/accounting.rs)                 | 调用事实、计价证据、精确金额和参考成本结果      |

目录中的 `ModelSettings` 是参数声明；某一次调用选定的参数属于 `ModelRequest`。名称和说明可以作为
共享目录数据保留，但协议不选择型号、应用加速偏好或准备供应商请求。

本 crate 保留 ID、字段引用与数据自身的合法性校验，以及序列化、构造和只读访问。改变请求或
累计执行状态的算法归所属领域：图片清晰度处理由 `model-provider` 执行，尺寸与 patch 限制由
`utils/image` 的 `PromptImageDetailLimits` 表达，Core 在附件准备时选择相应限制；token 累计由
Core 的状态归并执行，精确费用累计由 `model-accounting` 计算，Core 负责提交新结果。

## Guardian 在哪里

Guardian 是工具操作执行前的风险审核，不是普通模型生成参数，也不是代码审查 Turn。
本地 Codex 的 `openai_models/guardian.rs` 定义按工具类别划分的审核覆盖策略；
`guardian_v2.rs` 定义分类模型与历史选择的实验配置。它们是 Codex 自己消费的目录约定，
不能因为同样使用模型就直接复制到 Ash 的 `models.json`。

Ash 的共享审核数据统一定义在 `guardian.rs`，Core、审核器、上下文整理和策略引擎直接使用
protocol 的类型。审核数据不包含沙箱实例、规则求值器或执行授权；这些仍由实现模块拥有。
没有新增尚无调用方的模型目录字段。

| 内容                                                     | 归属                                                                                                                 |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 动作和能力身份、审核证据、风险与授权程度、建议及结果绑定 | [`guardian.rs`](src/guardian.rs)；保留原有数据格式与规范化约定                                                       |
| 风险审核模型、响应约束、并发与取消                       | [`guardian-reviewer`](../ext/guardian-reviewer/README.md)，由 [`guardian-v2`](../ext/guardian-v2/README.md) 接入扩展 |
| 沙箱执行上下文、审核建议校验、最终执行决定与精确授权     | [`action-policy`](../action-policy/README.md)；审核模型只提供建议                                                    |
| 人工批准请求和回答                                       | [`interaction/approval.rs`](src/interaction/approval.rs)                                                             |
| 工具执行前持久化的授权事实                               | [`thread/event.rs`](src/thread/event.rs) 的 `ToolExecutionAuthority`，包括 `AutoReviewed`                            |
| 审核模型选择、权限模式和系统约束                         | [Guardian 文档](../../docs/guardian.md)；与主模型的推理档位和生成参数分开                                            |

`turn/review_target.rs` 则表示需要审查的代码变更，与 Guardian 的风险审核没有关系。

审核器的 `src/model_contract.rs` 定义版本化模型提示、严格响应格式与数据转换；它与后端共享协议
分别拥有模型调用格式和领域数据。protocol 不依赖审核器、沙箱或策略引擎。
