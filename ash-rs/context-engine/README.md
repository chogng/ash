# `ash-context-engine`

> 本文拥有模型无关的上下文预算、输入 token 计量结果和边界判定实现契约。Thread 历史选择、
> checkpoint 与压缩流程的系统语义由 [`docs/core-context.md`](../../docs/core-context.md) 拥有。

`ash-context-engine` 把“模型最多能装多少”和“当前候选请求按什么计数”转换为明确的预算结论。
它允许不同 provider/model 提供精准 tokenizer 或预检结果；没有精准能力时，调用方提供带版本和
保守记账值的估算。响应后的 usage 只用于记账和校准，不能冒充调用前预算。

## 1. 边界与依赖

| 拥有 | 不拥有 |
| --- | --- |
| context window、输出预留、安全余量和压缩阈值的独立类型 | 模型目录、配置覆盖、provider 选择或凭证 |
| 压缩压力线与模型硬窗口的统一计算 | tokenizer 实现、provider 预检网络请求或重试 |
| 精准计数与保守估算的统一结果模型 | Thread 历史选择、Skill 注入或 `ModelRequest` 组装 |
| `Fits`、`NeedsCompaction`、`ExceedsContextWindow` 判定 | checkpoint 生成、压缩模型调用或 durable commit |

本 crate 没有运行时依赖，也不依赖某个 provider SDK。`ash-core`、App Server 或 provider adapter
可以依赖它；它不得反向依赖这些协调与执行层。

本 crate 有意不提供一个假装所有计量都同步的 provider trait。本地 tokenizer 是纯计算，provider
preflight 可能涉及网络、取消和重试，两者的执行生命周期由上层 adapter 拥有；跨边界的通用接口是
不可变 `ContextTokenMeasurement`。只有出现两个真实调用方需要同一种异步/取消端口时，才在对应的
provider 协调层提取执行 trait，预算引擎仍只消费计量结果。

## 2. 公共契约

### 2.1 预算

- `ContextBudget::CoreManaged` 分别接收模型窗口、输出预留、安全余量和压缩阈值。
- `ContextBudget::resolve` 生成 `ContextBudgetLimits`：`maximum_input` 是普通请求触发压缩的压力线，
  `hard_maximum_input` 是扣除输出预留与安全余量后的硬上限。
- `with_input_buffer` 在普通压力线与硬输入上限之间保留空间，既有预留足够时不重复扣除。`for_checkpoint` 用独立输出目标解析硬窗口；两者只计算预算，不选择压缩策略或调用模型。
- `ContextBudget::ProviderManaged` 表示没有可信模型上限。它不是“无限窗口”，调用方不得把它报告为
  已验证可装入。
- 任何没有留下正数输入容量的 Core-managed 配置都返回 `ContextBudgetError`，不会依靠减法饱和后
  继续运行。

### 2.2 token 计量

| 可用能力 | 构造方式 | 预算使用值 | 典型来源 |
| --- | --- | --- | --- |
| provider 调用前预检 | `provider_preflight(revision)` + 独立 accuracy | 精确值或保守值 | OpenAI/Anthropic count API |
| 与所选模型匹配的本地 tokenizer | `local_tokenizer(revision)` + 独立 accuracy | 精确值或保守值 | 本地 tokenizer registry |
| 无精准计数能力 | `ContextTokenMeasurement::estimated` | 保守记账值 | `deterministic-bytes-v1` 等 estimator |

`ContextTokenMeasurement` 必须针对最终候选请求，而不是只数消息正文。调用方负责包含 instructions、
tools、图片和 provider wire envelope 的成本。`LocalTokenizer` 的实现者还必须保证 tokenizer 与所选
模型匹配；revision 变化时不得复用旧计量缓存。

来源和准确度是两个独立维度：OpenAI Responses preflight 按 provider 契约记为 exact；Anthropic
count endpoint 同样来自 provider preflight，但官方只承诺 estimate，因此记为 estimated。估算同时
保存 measured count 和 conservative accounted value；后者是预算策略余量，不宣称数学意义上的硬
上界。`ContextBudgetPlanner` 只用 accounted value 做判定，revision 为空或 accounted value 小于
measured count 都会失败。

### 2.3 判定

```text
model/provider adapter or local estimator
  → ContextTokenMeasurement
  → ContextBudgetPlanner::assess(ContextBudget, measurement)
      → ProviderManaged
      → Fits
      → NeedsCompaction
      → ExceedsContextWindow
```

`NeedsCompaction` 表示请求超过主动压缩压力线、但仍未超过硬窗口；调用方可以先压缩再重建请求。
`ExceedsContextWindow` 表示即使不考虑主动压缩策略，也已经越过模型硬容量，不能直接发送。

## 3. 内部接口地图

| Symbol | 可见性 | 职责 | 漂移信号 |
| --- | --- | --- | --- |
| `ContextBudget::resolve` | public | 校验分配并计算压力线与硬上限 | provider 名称、Thread 或压缩 I/O 进入预算数学 |
| `ContextTokenMeasurement::estimated` | public | 固定来源 revision 与保守记账不变量 | 允许无 revision 或用 measured value 直接判定 |
| `ContextBudgetPlanner::assess` | public | 纯比较 accounted input 与两条边界 | 直接调用 tokenizer、usage API 或修改历史 |
| `planner::subtract` | private | 为诊断值计算无下溢差值 | 承担模型配置或计量策略选择 |

真实调用关系：

```text
model metadata/config
  → ContextBudget::resolve

provider/local tokenizer/estimator adapter
  → ContextTokenMeasurement

ContextBudget + ContextTokenMeasurement
  → ContextBudgetPlanner::assess
  → caller-owned selection / compaction / invocation
```

## 4. 接入与失败语义

调用方按能力选择计量来源，统一优先级是“provider 官方预检、匹配模型的本地整请求计数、Core
保守估算”。本 crate 不规定预检调用频率：本地计数可以每次调用；有额外网络往返的 provider
预检通常由上层只在接近压力线、估算不确定或重试恢复时启用。无论采用哪种节奏，最终计量结果都
进入同一个 `ContextBudgetPlanner`，不会形成 provider 专用预算算法。

usage 属于调用完成后的事实。上层可以用它做成本记录、观测 estimator 偏差或更新校准参数，但不能
用当前响应的 usage 决定已经发出的请求是否安全。若后续引入校准，校准数据必须按 provider、model、
tokenizer/estimator revision 隔离。

本 crate 的错误都是调用前、无副作用错误。它不重试、不访问网络，也不修改 Thread。调用方收到
`NeedsCompaction` 或 `ExceedsContextWindow` 后负责执行对应流程，并在内容变化后重新计量。

## 5. 测试与修改影响

```bash
cargo test -p ash-context-engine
cargo clippy -p ash-context-engine --all-targets -- -D warnings
cargo test -p ash-core context
```

修改预算公式时必须同步检查 App Server 的模型配置映射和 Core planner 边界测试。修改计量不变量时
必须同步检查所有 provider/tokenizer adapter、诊断字段和 estimator revision。新增 provider 能力时
应实现 adapter，不应向本 crate 添加 provider 名称分支。

## 6. 当前状态与扩展点

- **Current**：预算类型已从 `ash-core` 移入本 crate，Core 通过公共 `resolve` 契约消费压力线与硬上限。
- **Current**：精准计数、保守估算和统一判定 value contract 已实现，并由无运行时依赖的单测覆盖。
- **Current**：OpenAI Responses `/responses/input_tokens` 已作为 exact remote preflight 接入；
  Anthropic Messages、Google `countTokens`、Kimi estimate 与 Z.AI tokenizer 已作为 estimated remote
  preflight 接入，并使用 `max(32, ceil(count / 100))` 的保守记账余量。
- **Current**：Core 对本地计数每次执行；remote preflight 只在距压力线 10%/至少 4096 tokens、
  compaction 后复核时执行，计量发现低估后收紧容量并重新规划。
- **Current**：`ash-model-tokenizer` 已提供按完整 `ModelRef` 绑定、双资产 revision/digest 固定、
  `hf-chat-template` 执行、按需下载/磁盘缓存/内存 LRU；Provider runtime 统一消费本地计数。本地结果
  因远端可能追加 envelope 而记为 estimated，并使用 2%/至少 64 tokens 的保守余量。
- **Current limitation**：Hugging Face 公共 `owner/repo` 已支持自动发现；其他 provider/model 仍需
  固定资产清单。无法处理的请求返回 unavailable，Core 仍以 `deterministic-bytes-v1` 作为首轮估算。
- **Current limitation**：usage 校准与计量缓存尚未实现。
- **Extension point**：真实 adapter 落地后，可以增加“何时请求远端预检”的上层策略；该策略不得
  改变本 crate 的预算公式，也不得让 usage 与调用前计量共用同一类型。
