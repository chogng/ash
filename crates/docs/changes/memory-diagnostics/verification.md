# 验收记录

本次已完成共享监听核心、三端接入与定向验证。完整 Renderer 构建仍受现有聊天/调试代码错误阻挡；不把组件测试或类型检查当成完整 Workbench 验收。

## 候选与环境

- Git 基线：`d1771edc8a34fb83c7a5cba14b62f8e044e151db`；工作区同时存在 TUI 交互、ChatGPT 账户等并行修改，均保留。
- 对当前全部已修改或未跟踪的 Rust、TypeScript、Cargo 与 JSON 配置，按路径排序计算 `路径 + NUL + 内容（删除为 <deleted>）+ NUL`。共 130 个文件，SHA-256：`ca0ea61e0a824650e89c450477b7611fffa373844ca69f19ab5d8d24cd151db8`。本文及构建输出不参与计算；这不是仅包含本任务的提交指纹。
- 实测环境为 macOS / Apple Silicon。未执行全工作区测试，未宣称 Windows/Linux 实测通过。
- 本次为自查。没有独立审查。

## 实际命令与结果

原始日志保存在 [verification](../../../../.build/desktop/memory-smoke/verification)。测试源文件已进入相应包的正常测试发现范围；前端定向编译配置位于构建输出中。

| 命令或场景                                                                                                  | 结果                 | 覆盖范围                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `just test ash-memory-diagnostics`                                                                          | 13 通过              | 按需采样、连接隔离、重复开始/停止、过期和错误证据、进程重启、缓存预热、有界历史、失联采集器、报告保留期限                                                |
| `just test ash-app-server-client memory_`                                                                   | 3 通过               | TUI/图形端身份、运行时计数、导出、幂等停止；句柄释放后仍存活的连接不保留诊断；清理不掩盖原始错误                                                         |
| `just test zui memory_ -- --include-ignored`                                                                | 2 通过               | 真实 GPU 缓冲创建/释放使计数增加/回归；按需读取及窗口关闭后的采集器释放。硬件测试显式启用，未跳过                                                        |
| `just check zui`、`just check ash-workbench`                                                                | 通过                 | 图形端正常构建配置、渲染器统计接口及产品装配                                                                                                             |
| `just test ash-tui memory_diagnostics_remain_available_during_a_running_turn`                               | 1 通过               | 运行中仍能提交诊断命令；诊断通知和错误不修改对话状态                                                                                                     |
| `just test ash-cli --test tui_real_scenarios actual_tui_records_reads_stops_and_exports_memory_diagnostics` | 1 通过               | 真实 PTY 上开始、重复开始、读取、停止和导出，检查 JSON 状态；没有模型请求                                                                                |
| `just test ash-app-server-protocol schema_fixtures_match_the_generators`                                    | 1 通过               | 生成物一致性；初次完整包测试 37 通过、此项失败，重新生成后只重跑失败项                                                                                   |
| `just generate-protocol`                                                                                    | 通过                 | Rust 协议 fixtures 与 TypeScript 类型、运行时 decoder 同步；两份 types/decoder 按字节相同                                                                |
| 前端定向 `tsc` 与 `node --test …/appServerMemoryDiagnosticsService.test.js`                                 | 编译通过，6 测试通过 | 重复开始、采集中停止、断连、停止后立即开始、释放前的排队请求、采集失败及显式重试；DisposableTracker 无遗留                                               |
| `tsc -p tsconfig.main.json`                                                                                 | 通过                 | Electron Main 采集器及可信 IPC 接线                                                                                                                      |
| `node .build/desktop/memory-smoke/verify.cjs`                                                               | 通过                 | Playwright 驱动真实 Electron，5 轮 DOM 创建/移除后读取 Main/Renderer 指标；没有遗留 debugger attachment 或额外窗口                                       |
| Web 命令验证页                                                                                              | 通过                 | Playwright 点击真实注册的开始/读取/停止命令，检查通知文本；服务为测试替身，不代表真实后端或完整 Workbench 已验收                                         |
| `tsc -p tsconfig.renderer.json --noEmit`                                                                    | 未通过               | 现有 `chat-view.test.ts` 缺 `referenceCost`、`debugBreakpointDecorations.ts` 引用已变更的编辑器接口、`chatService.ts` 事件类型不一致；本轮未改动这些功能 |

前轮另有 App Server 真实 JSON-RPC 的开始、提交、导出及断连测试通过，及 TUI 资源显示 9 项测试通过。普通 CLI 和图形应用均曾完成构建，图形应用曾实际启动；这些事实不代替本轮全部 GUI 交互场景。

## 验收边界

| 要求            | 实现           | 已取得证据与未覆盖部分                                                                                                                                                                |
| --------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-1 统一核心   | 已实现         | 三端采用同一后端契约与分析器；TUI 真实流程、Rust 客户端和 Electron 采集通过。完整 Workbench 尚未通过构建门禁                                                                          |
| AC-2 身份与范围 | 已实现         | PID/启动身份、连接 owner、空 PID、进程内后端去重、主机来源区分及退出处理有覆盖。没有真实远程主机、多平台全面实测                                                                      |
| AC-3 增长判断   | 已实现增长证据 | 人造时间序列验证持续增长、预热、缺口和失联；未实施分配栈/引用路径定位，不自动宣称已确认泄漏                                                                                           |
| AC-4 自身释放   | 已实现         | 缓冲与报告上限、原始期限不被重复停止延长、句柄/窗口/连接释放、失败时停止及晚到结果处理均有定向测试                                                                                    |
| AC-5 各端采集   | 已接入         | TUI 正文单元、Rust UI/任务/窗口/GPU/渲染缓存计数、Electron JS/DOM/监听器/进程指标已接入。驱动显存字节、缓存字节和深度堆证据不支持；完整编辑器开关、所有窗口场景与长时间性能压测未完成 |
| AC-6 报告与缺口 | 已实现         | 版本化 JSON、资源分块释放、权限/能力缺口和中断可观察；只报告已取得的指标，缺失值不填零                                                                                                |

## 修正与清理

- TUI 原 `src/host/process_resources.rs` 及测试迁入 `crates/memory-diagnostics/src`；调用方和文档引用同步更新。
- 诊断输出改走独立的 Host 通知，保留当前对话状态。
- 首次 PTY 断言依赖原始输出中的空格或当前视口；真实报告位于滚动历史。改为输出状态标记与导出 JSON 验证，未修改截图基线或削弱停止/导出行为要求。
- 清理了本轮产生的过期协议增量缓存以恢复磁盘空间，未删除源码、可执行文件或证据。
