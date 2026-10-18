# Codex utils 与 Ash 的能力对照

Ash 按能力及依赖边界安排实现，不按 Codex 的 crate 名称复制目录。本次对照本地 `../codex/codex-rs/utils` 的 27 个目录，重点检查实际调用链、持久化边界和进程生命周期。

| Codex utils       | Ash 的负责位置                                                                       | 结论                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| absolute-path     | `utils/absolute-path`                                                                | 已有绝对路径、词法规范化和序列化边界；不增加未使用的别名                                                               |
| approval-presets  | `action-policy`、`execpolicy`、客户端权限选择器                                      | 权限由 Ash 的 action、规则和授权契约决定，不复制 Codex 预设值                                                          |
| audio             | `utils/audio`、`attachments`、`core`、`ash-api`                                      | 新增容器校验、时长估算、普通会话附件及模型编码；详见下节                                                               |
| cache             | `utils/cache`                                                                        | 修复普通线程和单线程异步运行时不能可靠复用缓存的问题；同步初始化共享互斥锁                                             |
| cargo-bin         | `utils/cargo-bin`、`test-binary-support`、`install-context`                          | Cargo/Bazel 测试程序、资源与脚本夹具由轻量测试库定位；helper 角色和产品安装发现保留各自职责                            |
| cli               | `utils/cli`、`ash-cli`、`config`                                                     | 通用解析退出码与命令格式化共享；Ash 产品继续负责参数定义、命令行为与配置                                               |
| elapsed           | `utils/elapsed`                                                                      | 已有时间累计能力                                                                                                       |
| fuzzy-match       | `crates/tui/src/widgets/list_selection/matcher.rs`                                   | 当前列表搜索已有前缀、子串和模糊匹配；不新增空的公共封装                                                               |
| git-discovery     | `git/src/repository.rs`、`git/src/client.rs`                                         | 已有工作树/元数据发现和有超时、输出限制的 Git 子进程；与上游可选元数据探测的契约不同                                   |
| home-dir          | `utils/home-dir`、`home`                                                             | 使用 Ash home 及显式路径规则                                                                                           |
| image             | `utils/image`、`attachments`                                                         | 已有格式、大小、尺寸校验，持久引用及按模型限制缩放                                                                     |
| json-to-toml      | `utils/json-to-toml`                                                                 | 已有转换能力；不扩张接口                                                                                               |
| oss               | `ollama`、`models-manager`、模型提供商配置                                           | 已有服务探测、安装列表、下载进度、取消；其他兼容服务通过提供商配置接入                                                 |
| output-truncation | `utils/output-truncation`、`tools/src/output.rs`、`core/src/context/input_limits.rs` | 文本预算与媒体内容分别处理；补正极大字节数的向上取整                                                                   |
| path-uri          | `utils/path-uri`                                                                     | 补充不透明 URI 判断、字节解码、深度、包含/重叠及安全子路径拼接；保持路径约定隔离                                       |
| path-utils        | `utils/path-utils`、`install-context`                                                | 补正符号链接循环、相对目标、原子写权限保留；可信程序发现仍由 install-context 负责                                      |
| plugins           | `core-plugins`、`external-agent-migration`                                           | Ash 清单与外部生态导入各自负责；不把另一产品的清单变成通用协议                                                         |
| process           | `utils/process`、`code-mode`、`app-server-daemon`、`app-server-test-client`          | 普通后台命令统一 Windows 无控制台策略；stdio 和生命周期由调用方管理，特殊启动留在所属模块                              |
| pty               | `utils/pty`、`windows-sandbox`                                                       | 已补 Unix 取消/回收；补 Windows 客户端生命周期、创建句柄释放和系统 ConPTY 加载                                         |
| readiness         | `mcp/src/session.rs` 等连接状态拥有者                                                | 初始化完成后才暴露可用会话；当前没有需要独立 readiness 标志的调用方                                                    |
| redacted-string   | `secrets/src/value.rs`                                                               | `SecretValue` 隐藏调试内容并在释放时清零，不提供隐式序列化                                                             |
| rustls-provider   | `http-client/src/outbound_network.rs`、`websocket-client`                            | TLS 配置明确选择加密实现，WebSocket 复用该配置                                                                         |
| sandbox-summary   | `sandboxing`、`action-policy`、客户端展示                                            | 沙箱能力和授权结果使用 Ash 的类型；客户端负责文案                                                                      |
| sleep-inhibitor   | `utils/sleep-inhibitor`、`core`、`app-server`                                        | 已接入活跃 Agent 执行，按进程共享抑制资源并随执行结束释放                                                              |
| stream-parser     | `utils/stream-parser`                                                                | 已有增量解析和隐藏片段处理                                                                                             |
| string            | `utils/string`、`utils/output-truncation` 及字符串所属领域                           | UTF-8 截断、首尾计划、token 换算、JSON 写入和本地链接位置已接通；指标标签清洗及四条业务指标链路已接通；UUID 提取未新增 |
| template          | `utils/template`                                                                     | 已有模板展开能力                                                                                                       |

## String 能力对照

基线为本地 `../codex/codex-rs/utils/string` 的公开接口。下表区分共享字符串机制、领域预算和实际消费链路，不能仅凭目录存在判断能力已接通。

| Codex 接口                                                                       | Ash 对应能力及生产调用方                                                                              | 契约差异                                                                                                                                            |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `take_bytes_at_char_boundary`                                                    | `utils/string`；skills、Core、TUI、trace、testing 等调用                                              | 同为无分配的 UTF-8 前缀切片                                                                                                                         |
| `approx_token_count`、`approx_bytes_for_tokens`、`approx_tokens_from_byte_count` | `utils/string`；工具输出通过原模块重导出，Core planner、compaction 和 App Server MCP 工具目录直接使用 | 都按四字节估算；Ash 先换算再饱和到领域计数，避免大输入被低估                                                                                        |
| `truncate_middle_chars`                                                          | `utils/output-truncation::truncate_text(Bytes)` → `string::plan_middle_truncation`                    | Ash 的提示也计入硬字节预算                                                                                                                          |
| `truncate_middle_with_token_budget`                                              | `truncate_text(ApproximateTokens)` 及 `formatted_truncate_text`                                       | Ash 用字节上限约束完整输出；原始估算由警告头报告                                                                                                    |
| `TextTruncation`、`plan_token_truncation`                                        | `string::TextTruncation`、`plan_middle_truncation`；工具输出和 Core 上下文裁剪                        | Ash 先把预算换算为字节；计划保留源字节坐标和提示，调用方也可用于带注释内容                                                                          |
| `truncate_middle_with_marker`                                                    | `utils/string`；TUI 终端输出首尾预览                                                                  | 完整结果包含提示仍不超预算；提示放不下时保留原文前缀                                                                                                |
| `to_ascii_json_string`                                                           | `utils/string`；JS 扩展 CommonJS 引导代码中的配置、路径、源码字面量                                   | 非 ASCII 字符转为 UTF-16 JSON 转义，运行时恢复原值                                                                                                  |
| `to_json_string_bounded`                                                         | `utils/string`；trace payload 和 event 写入                                                           | 序列化期间拒绝超限，失败不返回部分 JSON；event 直接按自身上限限制                                                                                   |
| `normalize_markdown_hash_location_suffix`                                        | `utils/string`；TUI Markdown 本地链接的可复制目标显示                                                 | 校验非空数字行列；不改写网页锚点，不新增本地文件执行入口                                                                                            |
| `find_uuids`                                                                     | 尚未确认任意文本提取的生产需求                                                                        | Codex 当前全仓只有定义和单元测试；引入提交也未接业务调用。Ash 已有 UUID 生成和严格校验，不能以使用领域 ID 为由判定不需要 UUID；文本提取是另一项契约 |
| `sanitize_metric_tag_value`                                                      | `utils/string` → `diagnostics::Metrics` → MCP、Skill、Guardian、Windows 沙箱                          | 兼容 Codex ASCII/256 字节规则；生产 SDK 按实例聚合并限制标签组合数，通过诊断 RPC、反馈预览及沙箱管理入口消费                                        |

### UUID 与指标调用链复核

UUID 生成、外部 UUID 校验和从任意文本提取 UUID 是不同契约。Ash 的 `src/ash/base/common/uuid.ts` 已有生成和整串校验，Session 创建等生产代码正在使用；`browserView` 也校验带 UUID 的完整 target ID。Codex 的 `find_uuids` 只匹配十六进制分组形状，不校验 UUID 版本、变体或文本边界，不能替代这些校验。当前检索 Codex 全仓和 Ash 的 Rust/TypeScript 源码，未发现对应的任意文本提取消费链路；Codex 引入提交 `764ac9449f`（`feat: add uuid helper (#12500)`）也只增加工具和测试。这不足以推断 Ash 缺少某项会话、日志或恢复功能。

指标清洗有明确的上游业务消费者；Ash 已将对应指标接到生产调用链：

| Codex 生产链路                                                         | 标签与用途                                                            | Ash 已有业务及缺口                                                                                                                                                              |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core/src/mcp_tool_call/telemetry.rs` → `emit_mcp_call_metrics`        | server、tool、connector、error_code；调用数、耗时、请求/工具/审批错误 | `ash-mcp::McpRuntime::call_tool` 记录 server/tool/connector、次数、耗时及工具结果/传输/未开始/无效结果/取消分类，MCP runtime 更新共享后端 meter                                 |
| `ext/skills/src/tools/mod.rs`、`ext/skills/src/telemetry.rs`           | skill、plugin_id、model_slug；注入次数及使用插件的 turn 耗时          | `ext/skills::SkillRuntime` 记录显式及自动/模型选择激活的次数、失败和耗时，含会话来源及目录刷新路径；不把重复加载 frozen instructions 计为新激活                                 |
| `ext/guardian-reviewer/src/reporting.rs` → `metrics.rs`                | 审查模型/推理强度等；结果、耗时、首 token 耗时及 token 用量           | 审查池从排队、重试到 worker 终态计一次，区分决策、取消、超时及模型/校验错误；App Server 按冻结模型的真实传输方式桥接，provider adapter 记录真实流首 token 和已报告的 token 用量 |
| `core/src/windows_sandbox.rs`、`windows-sandbox-rs/src/setup_error.rs` | originator、模式、错误码及先脱敏再清洗的错误信息；安装成功/失败及耗时 | 服务的认证后 provisioning dispatch 记录 setup/update/remove 的次数、失败和耗时；`ash-windows-sandbox metrics` 读取服务生命周期内的累计值，不采集原始错误信息                    |
| `otel/src/metrics/client.rs`、`otel/src/events/session_telemetry.rs`   | OS/版本、originator、service_name 等动态标签                          | Ash 使用已有 build identity 及业务选定的模型/工具元数据，不新增全局调用来源或网络 collector                                                                                     |

生产 meter 由 `diagnostics::Metrics` 持有 `SdkMeterProvider` 和累计 `ManualReader`，与 `otel/src/provider.rs` 的 trace 共同进入 `DiagnosticSnapshot`。SDK 是聚合状态的唯一拥有者，每个 instrument 最多保留 128 组标签，溢出测量聚合到 SDK 的 overflow 时间序列。`diagnostics/read` 与反馈预览读取同一份累计快照；不依赖 `mock` feature，不自动发送到外部 collector。独立 Windows 服务通过管理管道读取自己的 meter，只有常量标签，不携带账户、审批摘要或运行器路径。

Codex 的 ASCII 白名单由其 `otel/src/metrics/validation.rs` 明确执行，不是所有 OpenTelemetry 属性的通用限制。`sanitize_metric_tag_value` 也不负责限制标签基数或保护隐私：Guardian 单独限制可归因的 MCP 来源，沙箱错误单独先脱敏。因此不能把任意路径、UUID、用户文本直接清洗后当作指标标签；Ash 的允许维度、基数上限和脱敏策略仍须由观测边界负责。

## CLI 与测试程序工具

`utils/cargo-bin` 通过调用点的 `CARGO_BIN_EXE_*` 定位已声明的测试程序，通过 `find_resource!` 捕获调用方 manifest 路径；Bazel 使用目标提供的 runfile 路径及 data。可执行脚本写入与复制在 Linux 的独立子进程内完成，避免并行测试 fork 时继承尚未关闭的写入描述符。CLI/PTY 夹具已接入这套定位与资源加载。

`utils/cli` 共享 Clap 的帮助、版本、参数错误退出路径，以及恢复命令的参数格式化。产品参数、执行模式与配置语义仍由 `ash-cli` 和 `config` 负责。未引入没有 Ash 调用方的 Codex 配置别名、权限枚举或恢复参数。

这次补齐没有证明 `just build-code` 提速；参数库独立编译实验已撤回。构建对照与验证范围记录在 [构建文档](../../docs/build.md#历史测量与适用范围)。

## 普通会话音频

- `utils/audio` 校验 WAV、MP3、M4A、WebM、Ogg，最多 16 MiB、一个音轨、一小时；时长从容器包读取。
- 图片和音频使用 `ash-attachment-store` 的同一个 `AttachmentStore`。先保存字节，再把摘要、格式、大小、时长组成的音频引用写入会话。
- 上传、Turn 接收、steer、历史恢复、上下文组装及工具结果沿各自已有入口处理音频；无效内容在持久事件之前拒绝。
- 模型调用只把请求副本中的引用转换为音频 data URL，上下文按时长估算，不按 base64 字符数计费或裁剪。
- Chat Completions 接受用户消息中的 WAV/MP3；ChatGPT Responses 使用 `input_audio.audio_url`。其他端点或角色不支持时明确报错。
- 客户端能够读取并展示音频记录。TUI 队列恢复和重新提交保留附件引用；这次没有新增录音或播放器界面。
- [附件协议](../app-server-protocol/README.md#图片与音频附件)负责上传参数和结果；[附件服务](../attachments/README.md)负责媒体及引用校验；[附件存储](../attachment-store/README.md)负责文件和摘要校验。

## 实现差异与验证边界

- Codex Git discovery 为可选元数据查询共享并限制后台文件系统探测。Ash `open_repository` 是需要完整错误与取消结果的 Git 操作，并未实现同目录请求合并；两者不能仅因名字相似而互换。
- `path-uri`、`json-to-toml` 保留现有公开工具契约，当前没有为增加使用量而新增产品依赖。
- GUI 主题选择已迁入产品配置，`theme` 不再写入 Desktop 配置。符号链接和原子写的回归测试留在 `utils/path-utils`，不恢复已删除的主题配置模块。
- Windows 新增生命周期测试已加入所属包；在 macOS 上交叉编译不代表 Windows 运行验证。新系统 API 的实际 EOF、后代输入和终止行为仍需相应 Windows 主机执行。
- 独立工具库、生成类型或实时语音存在，均不能证明普通会话音频附件已经接通。音频链路的行为由上传到模型调用、文件重开、历史恢复及请求编码测试覆盖。

## 本轮验证

| 范围                      | 结果                                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 15 个后端及工具包         | 567 项测试通过，2 项按原配置忽略；主题合并后另跑主题及路径库，32 项通过                                             |
| 音频链路                  | 上传 RPC、文件重开、历史恢复、模型编码及 TUI 音频场景通过                                                           |
| 原有客户端行为            | 图片流程和附件上传 10 项、TUI 请求/队列/附件/回退 20 项通过                                                         |
| Rust 构建                 | 受影响包的正常构建及禁止编译警告检查通过；桌面程序构建、隔离工作区启动通过                                          |
| 平台条件                  | Windows PTY/沙箱测试目标及警告检查、Linux PTY/路径测试目标交叉编译通过；未执行 Windows 运行测试                     |
| 依赖和 Bazel              | `just dependencies`、音频和缓存的 Bazel 测试通过                                                                    |
| 前端                      | 生成协议、严格类型检查、音频历史 DOM 测试、Electron 构建通过                                                        |
| Electron 与真实后端       | 隔离 Ash home 的窗口启动、后端数据库创建场景通过                                                                    |
| 浏览器及 Electron UI 冒烟 | Session Inspector 能打开和关闭；Escape 后焦点未回到按钮，场景仍失败。已补打开聊天栏的前置步骤，焦点实现未在本次修改 |
