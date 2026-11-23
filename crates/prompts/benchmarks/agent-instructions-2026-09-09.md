# Agent 指令 benchmark 与接入记录（2026-09-09）

两批离线测量覆盖角色选择和权限模板接入前后的 Core 请求组装。每批的组内对照生成相同的 `ModelRequest`。测量使用优化测试构建，当天未运行发布构建或真实模型质量评测。

## 环境与版本

| 项目            | 本次取值                                                                                            |
| --------------- | --------------------------------------------------------------------------------------------------- |
| CPU / 内存      | Apple M2 Max，12 个逻辑 CPU，32 GiB                                                                 |
| OS / target     | macOS 26.4.1 (25E253)，aarch64-apple-darwin                                                         |
| Rust            | 1.98.0 (`88d9e12ae178fab0fb5cc050a94da85685d449ea`)                                                 |
| 构建            | 仓库 `test` profile；Core opt-level 1，App Server opt-level s；debug assertions 与 incremental 开启 |
| Git HEAD        | `431dac7188223d6430c7c716bce47a4e06a20d56`，两批各有未提交改动，详见原始记录                        |
| 网络 / 模型调用 | 无 / 0 次                                                                                           |

本轮未同时启动其他构建或测试；机器仍是非独占桌面环境。编译、文件准备与 catalog 加载不计入样本。构建设置来自 [Cargo.toml](../../../Cargo.toml)，不能将结果当作 release 构建性能。

## Core 请求组装（权限模板接入前）

调用真实 `ThreadController::prepare_model_invocation` 与 `ContextAssembler::assemble`。每组先断言平铺对照与组合路径的完整 `ModelRequest` 相等，再预热各 100 次；每个变体采集 1,000 次，交错先后顺序。时间使用 `std::time::Instant`，结果通过 `black_box` 消费。

| 工具数 | Role 正文字节 |     平铺 p50 / p95 / p99 (μs) |      组合 p50 / p95 / p99 (μs) | p50 增量 (μs) | 请求字节 |
| -----: | ------------: | ----------------------------: | -----------------------------: | ------------: | -------: |
|     16 |          1024 |      30.416 / 38.541 / 39.666 |       36.042 / 45.625 / 49.333 |         5.626 |     6251 |
|    128 |          1024 |   229.875 / 275.792 / 317.791 |    251.334 / 302.750 / 351.792 |        21.459 |    27223 |
|    512 |          1024 | 944.500 / 1136.167 / 2191.292 | 1018.250 / 1207.042 / 2253.791 |        73.750 |    99415 |
|    128 |          8192 |   232.500 / 278.875 / 312.792 |    276.000 / 330.542 / 359.292 |        43.500 |    34391 |

差值包含角色片段、Thread 快照数据复制与工具集合过滤，不是字符串拼接的独立成本。请求大小只作字节统计，序列化本身不在计时区间内；不能按固定比例将字节换算成 token。512 工具场景的 p99 明显高于 p95，保留全部样本，不排除慢样本。

fixture 使用内存存储、共享规则、一个用户输入和 provider-managed budget；没有 Skill、长历史、压缩、环境片段或专化指导。磁盘持久化、真实授权 I/O、网络、模型推理、内存分配与峰值 RSS 不在本轮指标内。

## Core 请求组装（权限模板接入后）

两条路径共同使用 AskPermissions 前缀，每组先断言完整 `ModelRequest` 相同。沿用前一批的工具数、Role 长度、采样与分位数方法。内存 fixture 保留共同规则和一个用户输入，省略 Skill、checkpoint、审查历史、环境片段和专化指导。此批只测 Core 组装。

| 工具数 | Role 字节 |     平铺 p50 / p95 / p99 (μs) |      组合 p50 / p95 / p99 (μs) | 请求字节 |
| -----: | --------: | ----------------------------: | -----------------------------: | -------: |
|     16 |      1024 |      31.250 / 39.917 / 46.667 |       36.584 / 46.833 / 61.792 |     7081 |
|    128 |      1024 |   236.250 / 279.833 / 320.625 |    257.709 / 306.583 / 338.709 |    28053 |
|    512 |      1024 | 955.292 / 1109.125 / 1157.208 | 1030.459 / 1189.708 / 1282.083 |   100245 |
|    128 |      8192 |   236.584 / 281.916 / 495.000 |    279.083 / 334.667 / 533.459 |    35221 |

组内 p50 增量为 5.334–75.167 μs，包含角色片段、快照复制和工具过滤。请求比接入前增加 830 字节。前后两批没有随机交错，请求大小差可直接核对，模板的独立耗时需要单独对照。

## 角色与模型指导选择

调用真实预加载角色解析器和 `ModelInstructionCatalog::resolve`。Role 正文为 2,048 字节，工具数单独变化。单目录上限为 64 个 Role，因此 128 个 Role 使用两个准确来源目录，未改变产品限制。模型指导基准登记一个准确模型和共享正文大小的测试资产。

每组预热 100 次，采集 1,000 个样本；每个样本是 10 次调用的平均耗时。下表分位数属于**批次均值**，不能当作单次调用尾延迟。输入克隆、返回值消费与释放在该测量中。

| 选择         | Role 数 | 工具数 | 批次均值 p50 / p95 / p99 (μs) |
| ------------ | ------: | -----: | ----------------------------: |
| 准确模型指导 |       — |      0 |         0.237 / 0.304 / 0.325 |
| Default      |       1 |    128 |        6.895 / 7.804 / 15.212 |
| Exact Role   |       1 |    128 |      29.070 / 34.687 / 62.529 |
| Default      |      16 |    128 |         6.887 / 7.700 / 8.475 |
| Exact Role   |      16 |    128 |      28.837 / 32.187 / 62.200 |
| Default      |     128 |    128 |         6.879 / 8.429 / 8.779 |
| Exact Role   |     128 |    128 |      29.108 / 34.608 / 37.495 |
| Default      |      16 |     16 |         0.920 / 1.008 / 1.204 |
| Exact Role   |      16 |     16 |         4.000 / 4.591 / 5.054 |
| Default      |      16 |    512 |      26.075 / 31.837 / 60.250 |
| Exact Role   |      16 |    512 |    97.129 / 113.533 / 132.979 |

在本轮 fixture 下，准确选择的耗时随工具数量增加；1–128 个 Role 的差异较小。这是当前样本的观察，不证明更大 catalog 或不同正文下的上界。Default 不扫描角色 catalog，仍需复制调用方的工具上限。

## 复现与原始数据

以下是测量当时的命令。当前 checkout 的 App Server benchmark 可使用 `just test ash-app-server-runtime instruction_benchmark -- --ignored --nocapture --test-threads=1`。

```sh
just test ash-core instruction_benchmark -- --ignored --nocapture --test-threads=1
just test ash-app-server instruction_benchmark -- --ignored --nocapture --test-threads=1
```

- 实现：[Core benchmark](../../core/src/context/benchmarks.rs)、[选择 benchmark](../../app-server/src/server/agent_benchmarks.rs)。
- 接入前（UTC 18:44:09.080684–18:44:22.864887）：[样本与环境记录](agent-instructions-2026-09-09.jsonl)，19 组、19,000 个计时样本。相关 tracked diff SHA-256 为 `b5e40f00f35533b510c7cfb3a01eceeb97c452fe7545f6f841b433236e99ccb0`。
- 接入后（UTC 19:17:15.673290–19:17:20.223904）：[样本与源码摘要](shared-prompts-2026-09-09.jsonl)，8,000 个计时样本。相关 tracked diff SHA-256 为 `b2dddedb48571f6d3c9a74607a03069c21d93c4d328c82fcc3f656e58676a3ea`。
- 两份 JSONL 首行记录对应批次的环境与源码摘要。复现历史测量需还原对应工作树。分位数按排序后的零基索引 `floor(p × n)` 计算，两批均保留全部样本，未计算置信区间。
- 发布构建、磁盘、内存、长历史、Skill、高并发、真实模型行为和远端缓存收益超出本次记录范围。[评测方法](../docs/agent-instructions.md#benchmark-与行为评测方法)

仓库改名时，JSONL 的命令和源码路径更新，27,000 个原始计时样本逐项一致。测量原版在 `b2cca2112d` 的 `zeta-rs/docs/benchmarks/` 下。两个版本的文件校验值均为 SHA-256。

| 批次   | 测量原版                                                           | 当前仓库                                                           |
| ------ | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| 接入前 | `0c9a31df48ef92f6ce24ddeded478b8be9cc5873df9920720a9a75e7ad21fdf8` | `4557fa815ec37db604a5239a3452e40913947e1b9f66c28cfbbf2ba4b0dbd19b` |
| 接入后 | `893e812822a3eec4459c66c38e556e1dc5d4ff7eefc8b031361ac204109cbe65` | `0bc77aa10daa61b367e34b019735b4e1c7f30b0f2aeeb69d34272ae38817c035` |

## 实施前静态记录

以下是实施前的历史统计，其中旧路径已退场，不代表当前目录。工作区基线为 `eb9885c445fdd7192c41d757bb2f5e5d7ce954bd` 加已有未提交修改，因此以下记录使用文件内容摘要，不能仅凭提交号复现。统计读取 UTF-8 文件；Role 只统计去除首尾空白后的 `developer_instructions` 正文，与当前 Role 正文归一化一致。

| 资产                                            | 文件字节 | 指令正文字节 | Unicode 字符 |
| ----------------------------------------------- | -------: | -----------: | -----------: |
| `models-manager/templates/instructions/base.md` |     1933 |         1933 |         1933 |
| `agent-roles/assets/builtins/issue.toml`        |     2170 |         1701 |         1701 |
| `agent-roles/assets/builtins/general.toml`      |      371 |          192 |          192 |

```text
base.md sha256:b17c0ad39ee04614337b613f40699c963d016b331ee59827817f8a099b059952
issue.toml sha256:280ea896bba4b7b31d5361d2dcb97ad9a3ad87a04cb17355db4296dcac39f9b3
general.toml sha256:98bed24189700a9d836b2217f32e85f9d3cb3d5da234782d549cdcc00e91597d
```

这三段历史正文均为 ASCII，所以 UTF-8 字节数与字符数相同。数字不包含角色标签、工具 schema、目录规则、Skill、历史或供应商消息包装，不能当作完整请求大小，更不能按固定字节/token 比例换算成实测用量。

## 历史接入与验证

以下为 2026-09-09 的接入记录与实测结果，命令参数、包名与协议版本对应当时的 checkout。

2026-09-09 的根 Role 接入记录使用协议主版本 2、Session/Thread/Turn capability version 4 和历史 schema 15，当时保留 schema 12–14 的读取支持。握手校验协议版本，恢复时使用已保存的角色指令。当前接入见 [App Server 协议](../../app-server-protocol/README.md#agent-模式)。

TUI 的自动 Issue 标签注入和仅服务旧流程的编辑器绑定已退场；首 Turn 直接携带完整 URL。`/pr` 也通过普通 Agent 提交路径执行。浏览刷新编辑类型集中在 `crates/tui/src/config.rs`。

配置文件 schemaVersion 2 移除 Issue 执行偏好，保留浏览刷新设置；SQLite 配置文档版本 10 的支持下界为 7。旧 Issue 数据表不再由生产路径打开，也不在后台删除用户已有数据。

### 通用启动与 Role 接入

本轮主要行为包括：根角色原子创建与重试、Default 不按关键词选角色、子 Agent 不继承父 Role/审查指令、权限上限与 Code Mode 内层过滤、并发预留及完成后释放名额、Skill 缺失拒绝、旧配置迁移、Issue 浏览与普通 Session 启动。测试均使用固定模型响应或本地 fixture，未向真实 Issue/PR 写入内容。

| 验证入口                                                           | 本轮结果                                                                                                       |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `just test ash-core`                                               | 204 项通过；离线 benchmark 默认忽略，另行运行                                                                  |
| `just test ash-app-server agent_`、`review_turn_freezes`           | 36 项 Agent 回归和 1 项审查组合测试通过                                                                        |
| `just test ash-app-server`                                         | 340 项通过、1 项失败、1 项 benchmark 忽略；失败说明见下文                                                      |
| `just test ash-app-server-protocol`                                | 42 项库测试和 3 项生成器测试通过，包含 schema/TypeScript 一致性与旧主版本拒绝                                  |
| `just test ash-protocol`、`ash-models-manager`、`ash-prompts`      | 分别 39、13、7 项通过                                                                                          |
| `just test ash-app-server-client`、`ash-agent-roles`、`ash-github` | 分别 42、5、10 项通过                                                                                          |
| `just test ash-config`、`ash-state`、`ash-history`                 | 分别 57、24、2 项通过                                                                                          |
| `just test ash-tui`                                                | 全量运行中 797 项通过；新增 PR 快照审阅接受后，对应单项复核通过（合计 798 项）；1 项需要独立终端的既有测试忽略 |
| `just test-tui actual_tui_issue_`                                  | 3 项真实 PTY 场景通过：浏览/缓存恢复、缺 Skill 拒绝、刷新配置跨重启                                            |
| `just check ash-app-server`、`ash-tui`、`ash-session`、`ash-exec`  | 正常编译检查通过；本轮最终构建无新增 warning                                                                   |
| 桌面会话适配层独立 TypeScript 检查                                 | 通过；`session/create` 显式传入 Default                                                                        |
| 完整 Renderer TypeScript 检查                                      | 未通过，既有聊天类型与调试模块导出错误仍在                                                                     |
| 文档及格式                                                         | 本地链接有效；修改的 Rust 文件格式检查通过；无待接受快照                                                       |

App Server 完整测试中的 `local::tests::custom_provider_catalog_fetch_is_explicit_and_feeds_model_selection` 在“刷新前不存在该 provider 条目”的断言失败，单独重跑仍失败。本轮未修改 `local.rs` 的模型目录读取实现或该测试，不通过更改其断言来掩盖结果。

后续核对确认该断言已过时：[供应商配置规则](../../../docs/app-server-api.md)明确规定，自定义连接未填写模型 ID 时使用对应 API 类型的内置模型，远端刷新不自动改写配置模型选择。该测试已更新为 `custom_provider_discovery_preserves_configured_model_choices`，检查刷新成功、空响应、认证失败及恢复时完整列表与配置快照均保持不变，并验证显式保存远端模型 ID 后列表才切换。以上历史测试结果保留。

桌面完整类型检查的剩余错误涉及聊天错误码、`referenceCost`、`threadRestored`，以及调试模块对编辑器的失效导入。本轮只更新会话适配层的 Default 参数，没有宣称整个桌面构建或 Playwright 场景已通过。

新快照覆盖 Issue 列表的三种宽度、Open/Closed、启动/失败状态、配置页，以及普通 `/pr` 任务提交；旧分组/工作流面板和对应基线已删除。文本基线保留终端空白，marker 列与焦点样式另有确定性单元断言。

### 初版模型指导

- `just test ash-models-manager`：16 项通过，检查 17 个静态模型的覆盖、准确身份、共享正文、空目录对照和无效条目拒绝。
- `just test ash-app-server agent_`：37 项通过，1 项离线 benchmark 按默认忽略。新增测试让四类模板分别经过 RPC 根会话 → 实际 `spawn_agent` Tool Call → 默认 worker → 模型请求，检查指导、共同规则和权限说明各保留一份。
- `just test ash-app-server review_turn_freezes`：1 项通过；已有自定义目录与根 Role 组合测试随 Agent 回归通过。
- `just check ash-models-manager`、`just check ash-app-server`：正常构建检查通过，无新增 warning。
- 四份资产含末尾换行分别为 GPT 714、Claude 646、Gemini 626、Function Calling 745 字节；每次只选其中一份，字节数不能换算为实测 token 或费用。
- Markdown 本地链接、Rust 格式、编译资源引用和 LF 行尾已核对。本轮没有访问真实模型或改写既有性能原始样本。

### 共享模板补齐

- `just test ash-prompts`：10 项通过，覆盖三种批准模式、资产来源、审查终态和摘要边界转义。
- `just test ash-core`：208 项通过，1 项离线 benchmark 默认忽略。新增真实 ThreadController → ContextPlanner → ModelRequest 流程覆盖批准模式恢复、审查三个终态、checkpoint 覆盖旧 Review，以及接近上限的摘要续接预算。
- `just test ash-app-server agent_session_tests`、`review_turn_freezes`：分别 2、1 项通过，复核真实模型请求接线。
- `just check ash-prompts`、`ash-core`、`ash-app-server`：正常构建检查通过；无新增 warning。
- 模板资源继续由现有 `templates/**` 编译清单覆盖，LF 行尾属性已检查。没有新增协议字段、UI 页面或实时语音执行链路。
