# Trace roadmap

Trace 已能读取和跟随 Agent 的持久执行历史。本路线在现有能力上，优先完成 **具体 Turn 定位 → 模型与工具关系 → 一致导出 → 离线复查**，让一次失败从会话入口一直查到原始证据。本文沿根目录 `TODO.md` 的 `.md` 扩展名使用 `trace-todo.md`，原内容完整保留在后半部分。接手时主树 `TODO.md` 含未提交内容，已只读保全；本任务未删除或覆盖。交付前只读核对，主树现文件与保全文字节一致。

初始源码核对基线：2026-10-08，父任务确认当时已发布的 `main` 提交 `e05e17e93`。交付分支随后跟进已先集成 SCM / Search 的 `main` `5db5dfcec`，Trace 的后端事实未在本批扩展。下文“现有”表示该基线源码已具备；已有能力与本轮改动分开列出，实际运行结果见验证摘要。

## Trace 现有能力

| 已有能力            | 当前行为与证据入口                                                                                                                                                                                                                                                                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 共享入口和页面      | Workbench 的 `ash.agentTrace.open` 接收 Session ID，Sessions 的 `sessions.trace.open` 取当前 Session、切换布局后调用它；两端共用 [AgentTraceEditor](src/ash/workbench/contrib/trace/browser/agentTraceEditor.ts)、[共享命令](src/ash/workbench/contrib/trace/browser/trace.contribution.ts) 和 [Sessions 入口](src/ash/sessions/contrib/trace/browser/trace.contribution.ts)。 |
| 唯一历史来源与分页  | [ThreadStore](crates/thread-store/src/store.rs) 拥有持久事实；[rollout v3 分页](crates/rollout-trace/src/page.rs) 按 Thread 独立游标读有界范围，带上引用的历史前缀。页面合并分页，不触发执行。                                                                                                                                                                                 |
| 正式只读 RPC        | [Session operations](crates/app-server/src/server/session_operations.rs) 已提供 `session/trace/read`、`session/trace/diagnostics/read`、`session/trace/payload/read`、`session/trace/graph/read`；前端通过 [Chat 领域契约](src/ash/workbench/services/chat/common/agentTrace.ts) 消费。                                                                                        |
| 历史与实时查阅      | Thread / Turn 层级、子 Thread、全文筛选、仅错误、JSON 详情、键盘导航、中文和无障碍帮助已存在；订阅补齐 read/subscribe 间隙，隐藏或关闭停止后续读取并释放订阅，迟到响应不覆盖新输入。                                                                                                                                                                                           |
| 模型诊断与正文      | [记录器](crates/rollout-trace/src/recorder.rs) 和 [诊断契约](crates/rollout-trace/src/diagnostics.rs) 保存主循环、压缩与工具辅助模型的 attempt、语义请求/响应、失败、取消和部分输出；正文按需读取，未采集/省略/不可用有状态。请求属于 ModelService 边界，provider 传输字节与逐 chunk 采集尚未实现。                                                                            |
| 工具与子 agent 关系 | [关系归纳器](crates/rollout-trace/src/reducer.rs) 已生成模型请求工具、工具结果、Code Mode、终端、运行时调用、消息交付、委派与父子 Thread 的边；页面可沿已有 `eventKey` 跳转，缺失证据有 warnings。                                                                                                                                                                             |
| 导入、导出和评测    | rollout v3 JSON 导入/导出已保留未知字段、前缀、诊断与关系；显示筛选不裁剪导出。文件上限 64 MiB。CLI/评测沿产品执行路径保存任务结果，见 [评测说明](test/agent-eval/README.md)、[使用说明](docs/chat-session-inspector.md)、[真实 smoke 源码](test/smoke/areas/sessions/trace.spec.ts)。                                                                                         |

另一项 [TraceEditor](src/ash/workbench/contrib/trace/browser/traceEditor.ts) 负责 OTel/OTLP/WebSocket span viewer。它与此处的 Agent 执行 Trace 有不同数据来源和用途；本路线以 ThreadStore 与诊断捕获为依据。

## 预计演进能力

| 阶段              | 用户完成的事情                                                                                                      | 复用与边界                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| P1 具体 Turn 定位 | 从指定 Session / Thread / Turn / event 打开 Trace，确认选中的是哪次执行；分页晚到、目标缺失和切换输入都有明确结果。 | 扩展共享前端打开参数与 URI，复用现有读取和订阅；业务历史仍归 ThreadStore。第一批完成打开、定位、详情、重开及回归验证的闭环。 |
| P2 模型与工具关系 | 从选中 Turn 找到实际模型请求、模型工具调用、工具结果与子 agent，区分并行、嵌套、消息交付和结果依赖。                | 先复用现有图与身份键；只把明确记录的因果关系连起来。新增字段或关系语义由既有 Core/Rust/protocol 所有者维护。                 |
| P3 一致导出       | 运行仍在继续时导出一次有明确边界的捕获；历史、诊断、正文与关系属于同一范围，导出期间保持单次操作。                  | 固定点击时已加载范围，按捕获内事件身份与因果证据限制关系并记录遗漏；这不代表后端跨存储事务快照。正文读取失败标为不完整。     |
| P4 离线复查       | 无连接时导入、定位、查正文和关系，重新导出后证据仍可读；连续选择文件时最后一次选择生效。                            | 保持 rollout v3 兼容与字段保留；限制大文件和不完整证据。长历史使用有界 DOM 和缓存搜索文本，避免每次渲染反复序列化大记录。    |

### 逐项核实，不能先承诺的能力

| 信息                | 当前证据与待核实项                                                                                                                                                                                                                                                                                                                                                                                               | 演进验收条件                                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 上下文与参数        | 已记录 Core 请求、附件转换后的语义请求和历史前缀；具体每项参数、工具定义、压缩前后输入以已保存 payload 为准。                                                                                                                                                                                                                                                                                                    | 核对实际请求字段、来源、时间与模型选择；缺失正文明确提示；不从当前配置回填历史参数。                    |
| token 与费用        | 页面显示 invocation 中存在的 usage 与耗时；[计费契约](crates/protocol/src/model/accounting.rs) 已保存费率版本和 complete/partial/unpriced 参考费用，[实际记录入口](crates/core/src/thread_controller/execution.rs) 在主循环成功响应后写入。失败 attempt 不保证有计费记录；provider 用量缺失和真实计费场景仍待验收。                                                                                              | 分开显示已报告、缺失和估算；只有有明确价格来源、版本和计费规则时才展示费用估算。                        |
| 权限等待            | [审批交互契约](crates/protocol/src/interaction/turn_interaction.rs) 已通过 requestId/itemId 保存请求、答复、取消及可选 deadline；[工具授权记录](crates/protocol/src/thread/event.rs) 的 ApprovedOnce 关联 requestId。当前 UI 尚未展示等待区间；一般工具交互不设置 deadline，真实等待/超时场景仍待验收。                                                                                                          | 逐项核对请求、决策、等待时间与执行结果；未存储的间隔不根据界面停顿推断。                                |
| 重试、超时、取消    | attempt 失败/取消/部分输出已记录，[真实 loop 回归源码](crates/core/src/turn/diagnostic_trace_tests.rs) 覆盖失败重试与流式取消；超时来源、重试归组和等待预算的全链路覆盖待核实。                                                                                                                                                                                                                                  | 同一 Turn 内区分 attempt、取消源、超时预算、终止状态与部分证据；缺少因果键时标为未知。                  |
| 并行子 agent 与依赖 | 现有 graph 有父子 Thread、委派、消息交付、嵌套调用；[子任务 coordinator](crates/core/src/multi_agent/coordinator.rs) 实际保存结果 produced/received 与 join 的冻结目标、satisfiedBy。后端 graph 尚无返回/join 边；本轮页面已按 origin、委派标识、结果 digest 与冻结 join 成员派生返回/汇合导航。下一次模型的消费关系要求已加载 Core input 中出现同一 call ID。跨 Thread 没有统一时间顺序，完整并行区间仍缺证据。 | 用真实多子 agent 场景验证身份、顺序、交付与结果依赖；不能把时间相近视为依赖。                           |
| 副作用与恢复位置    | 评测已支持单 Git 仓库、完整 UTF-8 普通文件结果封存，见 [执行说明](docs/exec.md)；外部副作用、幂等性与可恢复位置未建立通用契约。                                                                                                                                                                                                                                                                                  | 只提供有证据的恢复位置和前置条件；复查、结果还原与重新执行分别标注。任意安全重放不在承诺范围。          |
| 敏感信息            | 语义请求、路径、工具参数和结果可能包含秘密；现有记录上限不是分享脱敏机制。                                                                                                                                                                                                                                                                                                                                       | 先核实已有脱敏规则，再提供分享前预览、密钥/个人路径处理和遗漏说明；内部原始证据与分享产物的变换可追踪。 |

## 可执行 TODO 与验收标准

所有新工作先用相应单测或真实 Playwright 场景复现，再改所有者实现。Web 与 Electron 使用同一共享编辑器契约；源码检查和历史日志不能替代本轮运行验证。

### P1：打开指定执行并确认定位（第一批）

- [x] 在共享 Trace 命令保留 Session ID 字符串兼容，增加结构化 Session / Thread / Turn / event 定位；URI 保存定位身份，重开得到同一目标。
- [x] 页面逐页寻找目标；命中后选中并展示详情，自动滚动到目标；晚到分页不将选择重置为第一行。
- [x] 目标缺失/参数无效有可翻译状态；错误/全文筛选不能悄悄把定位目标换成其他事件。
- [x] 覆盖重开同 Session 不同 Turn、子 Thread、诊断 event、目标缺失、切换输入和关闭后的迟到响应；更新中文与无障碍说明。
- [x] 验收：共享命令和现有 Sessions 入口仍可用；指定 Thread / Turn / event 的选中身份、详情和重开一致；定向单测、Renderer/smoke typecheck、正常 Renderer/Web 构建，以及 Web/Electron Playwright 行为断言通过。

### P2：查一条模型—工具—子 agent 证据链

- [x] 按已保存 Thread 前缀在 Turn 中排列模型 attempt 的诊断阶段，保留各 Thread 独立 sequence；共享执行树显示轻量层级线。
- [x] 查看模型请求 → 工具 call/result → 下一次模型输入；消费关系要求已加载 Core input 的 call ID 与同 Thread / Turn 的已保存结果匹配。
- [x] 按已保存委派标识、子 Thread origin、结果 digest 和 join 身份/冻结目标展示子任务返回与汇合；保留现有 Code Mode、终端和消息交付关系。
- [x] 已按源码逐项核实上下文、用量、权限、重试、取消与并行事实；页面说明用量/loop 缺 attempt 外键、重复调用不能直接标成 retry、未加载正文时消费关系未知。
- [x] 受控本地模型经真实 App Server 验证成功、shell 工具、两个并行子任务返回/汇合、正文按需阅读、关系跳转、关闭重开与离线复查；模型 fixture 边界明确，未使用付费账户。
- [ ] 完成失败重试、带部分输出的流式取消、真实审批等待/超时与带价格来源的用量验收；缺少记录或身份外键时由现有 Core/Rust/protocol 所有者协调补齐。

### P3：运行中的一致导出

- [x] 复现导出等待 payload 时 `render()` 重新启用按钮的竞态；导出进行中由页面单一状态拥有按钮生命周期，切换/隐藏/关闭使旧结果失效。
- [x] 复现旧 capture 与随后全量 `graph/read` 的范围不一致；明确导出边界并验证所有图引用位于该边界或有明确缺失说明。
- [ ] 验收：导出中追加 Turn/诊断事件不会混入另一时刻的关系；快速点击只产生一个下载；正文读取失败、64 MiB 超限与输入切换均有确定结果；筛选仍只影响显示。

### P4：可靠离线复查与长历史

- [x] 复现连续导入 A/B 的完成顺序竞态；最后选择的文件生效，即使 A 后完成或后失败。
- [x] 20,000 事件运行验证有界 DOM、搜索缓存、按需正文与关闭后的 model/editor 释放；证据全集仍由编辑器持有。
- [ ] 补齐同机旧版相同数据集的时间基线，量化整体性能变化；当前结果不能用于宣称整体提速。
- [ ] 分享脱敏先定义实际覆盖规则、预览和遗漏标记；原始证据保持可追溯。
- [ ] 验收：断开连接后，导入 → P1 定位 → P2 正文/关系 → 重导出仍可复查；未知字段、前缀与不完整状态保留；A/B 导入乱序回归通过；大记录性能结果有同机前后数据。

## 验证摘要（2026-10-08）

独立 worktree 使用 `trace-todo.md`，原 `.md` 扩展名与 36,201 字节历史全文保留；本任务未改动接手时含未提交内容的主树 `TODO.md`；交付前现文件与保全文字节一致。本轮已经完成 P1 定位、P2 保存证据导航、P3 导出边界修复和 P4 可靠导入/离线复查的第一批闭环。正式 Web 与 Electron 各自一次通过 8 个场景，完整模型/工具/并行子任务调用链使用明确标注的本地 HTTP 模型 fixture。审批等待/超时、失败重试归组、带部分输出的流式取消、费用与分享脱敏继续保留验收项。

### Storage 基线集成复核

已审批的模型/工具闭环与正文恢复候选无冲突跟进 `main` `e4d668f37`。本次源码检查点为 `657016924`；Trace 源码、测试与诊断协议相对上一检查点未变。Storage 改动涉及 Electron 主进程启动、flush 与 close，因此重新执行正常 Desktop 准备和真实 Electron Trace 八场景，均一次通过。Trace 与 Storage 定向单测共 83 项 / 9 文件通过；两种本树运行包的源码摘要、文件哈希和协议契约仍匹配。新日志无新增 warning，仅既有 Playwright NO_COLOR / FORCE_COLOR 提示。

[本次退出记录](.build/trace-validation/storage-main-loop-state.json)、[83 项单测](.build/trace-validation/storage-main-loop-unit.log)、[正常 Desktop 准备](.build/trace-validation/storage-main-loop-desktop-prepare.log)、[Electron 八场景](.build/trace-validation/storage-main-loop-electron-eight.log)、[包契约](.build/trace-validation/storage-main-loop-package-contract.json)。此前 `86ac6c9cf` 上的 Trace 68 项单测、headless 2/2 与 Renderer 编译见 [轻量复核](.build/trace-validation/latest-main-86ac-state.json)。完整 Web 8/8 继续保留其 `5db5dfcec` 基线，不冒充本次重复运行。受控本地 HTTP 模型 fixture、原 TODO 字节保全、Library v4 + 独立复审 delta 和后续未验收范围均保持原边界。

### 审查修复与已发布 main 复验

独立审查发现：Input 正文读取中隐藏 Trace，旧读取完成被 revision 丢弃；重新显示同一事件时，旧渲染身份却阻止重读。[编辑器](src/ash/workbench/contrib/trace/browser/agentTraceEditor.ts) 现只失效尚未完成读取的渲染状态，保留已加载正文与阅读位置；请求身份防止迟到旧读取清理新读取。[两个新回归](src/ash/workbench/contrib/trace/test/browser/agentTraceEditor.test.ts) 覆盖旧读取在恢复前/后完成，两种顺序都先红（只有一次 read）后绿（恰好第二次 read），再次隐藏/显示已加载正文不增加读取或重置位置。

分支无冲突跟进已发布 `main` `5db5dfcec`，保留原 TODO 全文与既有共享 UI 迁移。当前基线的受影响检查已全部通过，实际执行源码检查点为 `f2a54bc57`；后续仅更新本节文档。最终退出记录为 [当前验证状态](.build/trace-validation/published-main-visibility-state.json)。前一次新增整窗截图驱动改变了 Sessions 分隔条几何，导致关闭按钮被拦截；已校正为保留窗口尺寸、对实际 Trace 区域截图，原行为断言与 45 秒超时不变。旧运行的失败和因新 main 发布而中断的记录继续保留。

| 当前基线检查        | 实际结果                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 隐藏/恢复正文       | 两个新回归先红后绿；恢复恰好第二次 read，已加载正文不重读且位置保留。[红](.build/trace-validation/visibility-red.log)、[绿](.build/trace-validation/visibility-green.log)。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 定向单测与共享组件  | 68 项 / 8 文件通过；headless 2/2，包含四主题宽窄与长历史。[单测](.build/trace-validation/published-main-visibility-unit.log)、[组件](.build/trace-validation/published-main-visibility-headless.log)。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 真实 Web / Electron | 每端一次 8/8，正常 full Web 构建/后端准备和正常 Desktop 后端/完整前端/smoke 编译均通过。[Web](.build/trace-validation/published-main-visibility-web-eight.log)、[Electron](.build/trace-validation/published-main-visibility-electron-eight.log)。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 类型、规范与包      | renderer 类型检查和 hygiene 通过；两种本树新包的 sourceDigest、完整文件哈希和 protocol major 7 / schemaHash `2e9c381d…` 匹配。[包契约](.build/trace-validation/published-main-visibility-package-contract.json)。SCM 的共享协议来自已发布 main，本批未扩展协议。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 代表图与复审 delta  | [深色完整窗口](.build/trace-validation/published-main-visibility-web-results/areas-sessions-trace-flow--6289c-turns-and-offline-reopening-browser-app-server/ash-dark-wide.png) 展示下一次模型输入与 shell / spawn 结果和后续 wait_agent；[浅色 Trace 区域](.build/trace-validation/published-main-visibility-web-results/areas-sessions-trace-flow--6289c-turns-and-offline-reopening-browser-app-server/ash-light-narrow.png) 展示请求与两份返回共同满足 join。已查看真实像素；明确 fixture 标签属于测试证据注释，不属于产品界面。两图更新既有 Library 身份；[7,862 字节最小复审 delta](.build/trace-handoff/reviewed/trace-visibility-review.delta.patch) 可应用到原 Library v4 和 rebased 源码。[保存回执](.build/trace-handoff/reviewed/trace-review-library.json)。完整补丁 v4 未重新上传。 |

本批重开验收范围是 Trace 编辑器/窗口和离线导入。**App Server 停止重启后的磁盘恢复仍未验收**。重试归组、审批 deadline、带部分输出的流式取消、费用、分享脱敏和旧版同机时间基线继续列为后续验收项。

以下受控执行检查点保存 Library v4 对应的原运行范围；上述审查修复的最新结果单独记录。

### 当前受控模型与真实执行闭环检查点

[导航模型](src/ash/workbench/contrib/trace/browser/agentTraceModel.ts) 只派生查看关系，原始捕获和正文仍归 [共享编辑器](src/ash/workbench/contrib/trace/browser/agentTraceEditor.ts)，持久事实仍归 ThreadStore。模型诊断阶段以同一 attempt 的请求前缀作为展示锚点；它不建立完成阶段与并发持久事件的精确交错顺序，也不建立跨 Thread 全局顺序。call ID 按 Thread / Turn 限定；子任务返回核对委派、子 Thread origin 与结果 digest；join 只连接同父 Thread 的明确 join 身份及冻结目标。消费关系要求已加载 Core input 中的同一调用标识；缺少正文或身份证据时保持未知。没有新增 Core、Rust 或协议契约。

长正文复用只读编辑器的 Find；切换正文关闭旧搜索并回到开头。迟到正文可以更新派生关系，不能覆盖当前选中的正文；该竞态已先红后绿复现。[关系单测](src/ash/workbench/contrib/trace/test/browser/agentTraceModel.test.ts) 覆盖跨父 Thread、不同 digest、重复调用标识、另一 Turn 和结果晚于请求等拒绝条件。

| 检查                     | 当前实际结果与边界                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 正常 Web 与 Desktop 入口 | 正常 full Web 构建、smoke 编译和本树 Web 后端准备通过；正常 Desktop 后端准备、完整前端构建和 smoke 编译通过。Desktop 第一次准备因 exec-server 连接中断退出，保留中断状态；确认原进程结束后正常重跑 exit 0。CARGO_BUILD_JOBS=1，未复用其它树产物。                                                                                                                                                                                                    |
| Trace 单测               | 8 个文件共 66 项通过，包含定位、导入导出、生命周期、保存关系与迟到正文。[退出记录](.build/trace-validation/flow-current-state.json)、[日志](.build/trace-validation/flow-current-unit.log)。                                                                                                                                                                                                                                                         |
| 真实双端八场景           | Web 8/8 一次通过，Electron 8/8 一次通过；每端包含六项既有 Trace 回归与两项受控模型的真实 App Server 调用链。[Web](.build/trace-validation/flow-current-web-eight.log)、[Electron](.build/trace-validation/flow-desktop-electron-eight.log)、[Desktop 退出记录](.build/trace-validation/flow-desktop-state.json)。                                                                                                                                    |
| 完整执行链               | [真实流程源码](test/smoke/areas/sessions/trace-flow.spec.ts) 经过正常 initialize 和正式 Session operations。父任务三次模型调用、真实 shell 结果、两个实际并行子任务各一次调用、两份返回与汇合、下一次模型输入包含工具结果、关系跳转、关闭重开、15 份正文导出与离线复查均有断言。每份捕获包含 3 个 Thread、56 个持久事件、15 个诊断事件和 15 份正文。                                                                                                 |
| 错误与取消               | 真实本地模型请求失败与另一 Thread 的取消并行，保存 modelAttemptFailed / modelAttemptCancelled 与终止状态，错误筛选和重开通过。失败详情按公开契约显示“model request was invalid”。该场景没有覆盖 retry、审批 deadline 或取消前的流式部分正文。                                                                                                                                                                                                        |
| 组件、主题与长历史       | headless 2/2，通过四主题宽窄、键盘、布局、只读正文和关闭释放；20,000 事件仅挂载 29 行，本轮导入约 333 ms、筛选约 79 ms，关闭后 model/editor 均为 0。[测量](.build/trace-validation/flow-current-headless-evidence/long-history-measurements.json)、[截图附件](.build/trace-validation/flow-current-headless-evidence/attachments.json)。已查看深色宽屏和浅色窄屏截图。来源是共享组件与离线 fixture，不属于 Electron 主题截图；没有旧版同机时间基线。 |
| 包与协议                 | 两种 runtime 包的当前 sourceDigest、完整文件哈希、protocol major 7/schemaHash 均匹配。[包契约](.build/trace-validation/flow-current-package-contract.json)。                                                                                                                                                                                                                                                                                         |

模型 fixture 只提供本地 HTTP Responses 响应；Core、工具、子任务执行、持久化、诊断记录和 renderer RPC 使用产品路径，未接入付费账户或私密会话。旧的导入 fixture 继续作为 UI 回归，不能替代真实调用链。Electron 的菜单 popup、下载路径和重启使用既有进程内驱动 hook；本轮没有验收系统菜单或全局剪贴板。构建和单测未出现新增 warning；Playwright 仅有既有 NO_COLOR/FORCE_COLOR 提示。

以下历史检查点保留当时验证范围，当前结论以本节为准。

以下表格保留 UI 改造前 `cac4c2f8c` 范围的验证；新版结果见下节及界面路线，旧图不能代替新版 Electron 验收。

| 检查                 | 实际结果                                                                                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 文档链接与原文保全   | 新增源码和说明链接均存在；原 `TODO.md` 的 36,201 字节完整保留。                                                                                                                                        |
| 协议与构建输入       | 当前源码的协议、扩展、语言与其他编译资源生成通过。                                                                                                                                                     |
| 定位、命令与页面单测 | 最终定向 Trace 六个文件共 51 项通过；包含 Session 参数兼容、URI 身份、分页定位、切换/关闭、注册命令和真实中文词条。                                                                                    |
| 导入与导出回归       | 页面 21 项通过；A/B 乱序完成及失败、导出中刷新/隐藏/关闭/切换、单次下载、正文失败和捕获内模型/嵌套工具关系保留均有断言。                                                                               |
| 正常构建             | Renderer typecheck、正常 Desktop/Web 构建与 smoke/scenario 编译通过。                                                                                                                                  |
| Web / Electron UI    | 每端 5 项 UI 场景通过；包含 Sessions 入口、中文/无障碍、子 Thread、模型正文/关系跳转、筛选后的完整导出和离线重导入。使用隔离 profile 和合成证据 fixture。每端另 1 项真实持久历史场景跳过，不计入通过。 |
| 真实界面证据         | Web 录制的 6 步离线回查全部通过；保存实际截图和约 14 秒原始短视频。截图不作为测试判定依据。                                                                                                            |
| 旧后端准备记录       | 当时 Sherpa ONNX SDK 校验失败；后续官方重试、正常 Desktop/Web 后端准备和真实 Web 持久场景已通过，见下节。                                                                                              |
| 变更格式             | 仓库 TypeScript 格式检查与 `git diff --check` 通过。                                                                                                                                                   |

### 界面与长历史落实

采用共享 ObjectTree / SplitView / TabList / ToolBar / List / InputBox / IconLabel / ScrollableElement / 只读 CodeEditorWidget。
[界面路线](trace-ui-todo.md) 保留已核实的官方参考、数据边界、布局和分阶段验收。
导航模型只派生身份、摘要和缓存搜索文本；原始捕获、正文和导出仍归编辑器。
旧界面红测已复现 2,000 个事件全部挂载与缺少详情页签；当前六个 Trace 测试文件共 57 项通过，Renderer/集成/smoke 类型与修改文件格式检查通过。新增导出身份冲突回归先失败、修复后通过，图范围同时校验记录来源、Thread 与 Turn。更新到 main `77fcedc89` 后，修复共享控件宿主导致的详情零高度；正常 Desktop/Web 前端构建和独立 headless 两项通过，实际覆盖四主题宽窄、20,000 事件与关闭资源释放。真实 Web App Server 场景后续已通过；新版 Electron 仍排队，不能引用改造前的截图当作通过。

### 后端与真实 Web 阶段检查点（c6d6db1ef）

正常 `prepare:backend` / `prepare:backend:web` 两阶段均 exit 0，发布本树包；Sherpa 与 LiveKit 的官方锁定归档校验通过，未更换来源或跳过校验。更新到 `c6d6db1ef` 后，两种包的 sourceDigest、全部文件哈希和 protocol major 7 / schemaHash 只读复核均匹配；此次 main 更新未改变包输入。未复用其它树的 Cargo/runtime/protocol。

真实 Web 首轮 2 项通过、4 项失败。修复 Sessions 缺少 IModelService 的窗口装配及概览/Raw 断言后先重跑失败场景；剩余两个 has 定位器错误包含祖先容器，修正相对作用域后通过。六个场景已分别通过；真实持久场景完成实际 initialize、历史 Turn 精确定位、真实 shell 新 Turn 实时增量、子 Thread 层级，以及关闭后重开定位最新 Turn。该 smoke 在本次 main rebase 前运行；最新基线的正常 Desktop/Web 前端构建、smoke 编译、57 项 / 6 文件单测、hygiene、8 文件格式检查全部通过。

证据：[后端退出码](.build/trace-validation/backend-prepare-state.json)、[当时包契约](.build/trace-validation/c6d6db1ef-package-contract-check.json)、[最后两项真实 Web 复跑](.build/trace-validation/ui-selector-retry-production-web.log)、[最新前端检查](.build/trace-validation/frontend-check-state.json)。首轮及第一次复跑的失败日志也保留在 `.build/trace-validation/production-web-first-failure-*` 和 `production-web-selector-failure-*`。

阶段交接时无 Trace 自有 Cargo、监督器或 App Server；其它 Cargo 属于 `ash-external-conflict` 树，未干预。新版 Electron/前台仍排队；当时六项 Web 尚未在 rebase 后整批重跑；后续整组结果见下节，新版双端整体验收仍未完成。Sessions skill 所列 `valid-layers-check` 在当前 package.json 不存在，新增装配导入按已有层级检查，未把缺失命令记为通过。

### 最新 main 的整组 Web 复验（bf5bcdfc6）

无冲突 rebase 到 `bf5bcdfc6` 后，正常 `test:smoke:browser:full test/smoke/areas/sessions/trace.spec.ts` 一次完成 6 项 / 0 failed；其中 5 项验证导入/离线证据与真实 Workbench/Sessions 组件，1 项使用正式 App Server 的持久历史和真实 shell Turns。覆盖 initialize、历史定位、实时增量、子 Thread 与重开。入口同时完成正常 full Web 构建、smoke 类型编译与本树 Web 后端准备，CARGO_BUILD_JOBS=2；六文件 57 项单测随后通过。此次 main 格式变更改变包输入，Web 包已重新发布并通过最新 sourceDigest、全部文件哈希和协议校验。

证据：[整组退出记录](.build/trace-validation/web-six-current-main-state.json)、[六项 Web 日志](.build/trace-validation/current-main-web-six.log)、[57 项单测](.build/trace-validation/current-main-unit.log)、[当前 Web 包契约](.build/trace-validation/package-contract-check.json)。Web buildId 为 `sha256:671956060da4dcf28bfb4656fa60d58b8f8d0eb67b0c713f5c572d80660dd2f4`。前阶段两种包的核验保存在 [旧基线包记录](.build/trace-validation/c6d6db1ef-package-contract-check.json)，不能当作本次 Desktop 包已刷新。

代表截图已逐张查看并保存 Library：深色宽屏 `libfile_97f4600bf6e081919e47a6ccb37f868d`，浅色窄屏 `libfile_a93c0e82ab4881918944e25a8abf8c14`。它们来自 headless Chromium 的真实共享 Trace 组件与离线 fixture，展示前阶段的四主题宽窄验证，不属于 Electron 或完整产品会话截图。

新版前台/Electron 仍按 Browser → AgentHost → Trace 队列；本次 Desktop 包准备及 Electron 验收尚未运行。分享脱敏、真实模型失败重试/取消/多子 agent 链路和同机旧版相同数据集的性能基线仍在路线内，不因 Web 六项通过而标为完成。

轻量复验：hygiene 通过（263 CSS、0 errors / 0 design suggestions；设计 token 2 项），8 文件格式通过；当前无 Cargo 或 Trace 自有服务，见 [记录](.build/trace-validation/current-main-light-checks.json)。

### 分享脱敏的下一步边界

- [ ] 先清点语义请求、工具参数/结果、路径、错误、graph label 与未知字段的真实敏感来源；覆盖范围不等同文件上限。
- [ ] 对捕获副本提供显式的字段规则和分享预览；原始记录与本地查阅保持原值，未知 schema 未覆盖时明确提示。
- [ ] 删除或替换 payload 时同步处理引用、digest、byteLength 与不完整状态，记录变换规则版本和遗漏；不将已变换证据标为原始捕获。
- [ ] 验收使用测试密钥、个人路径和嵌套工具内容；预览与下载一致，重新导入仍可查缺失状态和合法关系。
- [ ] 在明确验证脱敏覆盖前不宣称产物可安全分享；不提供任意执行的安全重放承诺。

### Desktop 与真实 Electron 复验（e05e17e93）

本树保全旧分支后，无冲突 rebase 到父任务确认的 `e05e17e93`，没有修改主树或复用其它 worktree 的 Cargo、runtime、protocol。正常 `pretest:smoke:desktop` 完成本树 Desktop 后端包刷新、完整前端构建及 smoke 编译；CARGO_BUILD_JOBS=1，Rust 增量编译 22.17 秒。两种 runtime 包的最新 sourceDigest、完整文件哈希及 protocol major 7/schemaHash 均通过核验。

Electron 首轮六场景中两项通过，四项因 Trace smoke helper 用 DOM 定位 Desktop 系统菜单而失败；其中一项同时记录测试关闭超时，修复后未复现。改用现有 Menus 测试驱动并在中文重启后更新 application 句柄，保留原有菜单启用状态、动作结果、完整导出与中文断言；四个失败场景复跑全部通过（24.7 秒），相同四个正式 Web 场景随后通过（31.2 秒）。没有追加生产代码、图语义或共享 Core/Rust/protocol 变更。

首轮通过的真实持久 Electron 场景使用正式 App Server initialize、历史 shell Turns、Session 当前 Turn 精确定位、真实新 Turn 实时增量、fork Thread 层级和关闭重开最新 Turn。另五项的模型/loop/离线证据使用导入 fixture；不能当作真实 provider 模型调用、失败重试、审批等待或 AgentSpawn 返回汇合已验收。Menus 驱动拦截进程内 Menu.popup，下载路径及重启确认也由测试 hook 控制，以上不计为真实 OS 菜单/系统对话框验收。

本轮 Electron 与 AgentHost 的独立应用确实并行，Trace 只有一个 worker，每测独立 profile/user-data/HOME/ASH_HOME/workspace，输出及日志独立；本树准备、测试、包核验顺序执行。Trace spec 不含系统 clipboard、CUA 或窗口激活断言；没有新增需要全局资源独占的场景。新增测试修改的 smoke 编译与单文件格式检查通过；没有为本轮测试驱动修改重跑此前六文件 57 项单测。仅有既有 FORCE_COLOR/NO_COLOR Playwright 警告，正常构建没有新 warning。

证据：[Desktop 首轮阶段与退出码](.build/trace-validation/e05-desktop-state.json)、[Electron 首轮日志](.build/trace-validation/e05-desktop-electron-six.log)、[修复后分阶段退出码](.build/trace-validation/e05-menu-retry-state.json)、[Electron 四项复跑](.build/trace-validation/e05-menu-retry-electron-four.log)、[Web 四项复跑](.build/trace-validation/e05-menu-retry-web-four.log)、[最新双 runtime 包核验](.build/trace-validation/e05-both-package-contract.json)。首轮失败的 DOM、trace 与诊断保留在 `.build/trace-validation/e05-electron-results`，复跑使用单独的 `e05-electron-menu-retry-results` 和 `e05-web-menu-retry-results`，不覆盖失败证据。任务提交保持本地，push 仍由父任务串行协调。

---

以下为原 `TODO.md` 全文（包括当时的完成标记、验证记录与边界），用于保留历史依据；其中旧日志与结论不代表本轮已复验。

# Agent Trace 与评测 TODO

目标：在 Ash 中打开当前会话的执行 Trace，回看历史并跟随运行；使用同一条产品执行路径运行可复现任务，独立验收结果，并将评测产物与 Trace 关联。

## 1. 核对与数据契约

- [x] 核对现有 Thread 历史、rollout-trace、模型调用记录、OTel 和前端会话装配；复用唯一事实来源。
- [x] 提供会话 Trace 的正式读取接口，保留 Thread 内事件顺序、子 agent 关系、输入输出、工具结果、用量和结束原因。
- [x] 明确可回看的信息与缺失信息；不把当前上下文或估算值伪装成历史模型请求。
- [x] 同步协议生成物、运行时 decoder、接口说明和契约测试。

## 2. 当前会话 Trace 界面

- [x] 在命令面板和会话操作中提供“查看执行 Trace”，直接打开当前会话。
- [x] 展示会话／Thread／Turn 执行层级、模型调用、工具调用及结果、压缩、失败、取消和结束状态。
- [x] 支持历史读取、运行时刷新、错误筛选、详情查看和导出；明确空状态、数据缺失和加载错误。
- [x] 复用前端领域接口，后端拥有历史事实；界面关闭、隐藏和会话切换释放订阅并忽略过期读取。
- [x] 接入 NLS、中文词条、键盘操作、主题和无障碍帮助。
- [x] 使用 Playwright 验证 Web 与 Electron 的真实入口、历史／实时行为、导出和关闭后重新打开；单测验证订阅释放与过期响应。

## 3. 可复现任务评测

- [x] 复用产品无界面执行入口，固定每次任务的初始文件、指令、模型和执行预算。
- [x] 建立首批明确可验收的任务 fixtures，并说明从真实失败扩充任务集的步骤。
- [x] 独立 verifier 检查最终文件和测试结果，区分执行完成、任务通过、失败与超时。
- [x] 支持重复运行和基线比较，保存结果、改动、运行配置与会话 Trace。
- [x] 允许 Trace 界面打开评测导出的 Trace；评测报告提供对应产物路径。
- [x] 验证 runner／verifier 的失败与超时行为，并通过产品真实执行路径完成端到端验证。

## 4. 交付验证

- [x] 运行受影响 Rust 包验证、生成协议检查、前端 typecheck／build 和行为测试；下表逐项记录结果。
- [x] 更新能力所属文档及使用命令，记录真实验证结果和仍有的限制。
- [x] 核对工作区差异，保留用户已有改动，完成后逐项更新本 TODO。

用例不固定模型的搜索顺序或答案措辞；以最终产物和独立验收为主。脚本化模型用例验证 loop 契约，真实模型用例评估任务效果，两者分别报告。

## 5. Codex 对照后补齐诊断能力

现有 crate 新增诊断记录、payload 读取和关系归纳：记录器只保存执行证据，归纳器只生成可重建的查看结果。
Core 在调用边界记录；ThreadStore 继续拥有业务历史；App Server 只提供领域读取接口；前端通过 Chat 领域接口消费。

- [x] 以可关闭的本地采集记录主循环、压缩与工具内辅助模型的每次请求，包括开始、完成、失败、重试和取消；保存中断前的部分输出，记录失败不影响执行。
- [x] 保存实际传给模型服务的语义请求快照及响应，明确其与 provider HTTP／WebSocket 字节的区别；大 payload 单独存储，详情按需读取。
- [x] 复用已有工具、code cell、终端和 agent 消息标识生成关联图；界面可以从事件找到关联调用与原始证据。
- [x] 用 ThreadStore 的有界范围读取完成历史分页，复用领域分页逻辑，避免每页全量捕获历史。
- [x] Trace 导出／导入、CLI 和评测产物保留诊断证据与关联，覆盖读取边界、重试、失败、部分响应、取消和双端 UI。
- [x] 同步生成协议、中文词条、能力文档和本次验证记录。

## 6. Workbench 共享执行 Trace

打开 Trace → Workbench 公共命令 → `AgentTraceEditor` → `IChatService` → 既有只读协议。
Sessions 入口只取当前会话身份并切换 Code 布局；捕获、DOM、刷新与订阅仍由同一个编辑器拥有，隐藏或关闭时释放。
本批只调整用户已确认的 Ash 专属 Trace：迁移页面、CSS 与测试到 `workbench/contrib/trace`，扩展该贡献的已有注册入口，
在 `common/trace.ts` 声明公共命令，迁移 Sessions 调用点，并在共享 Chat 服务传递 `session/changed`。
`sessions.common.main.ts`、`workbench.common.main.ts` 负责各自装载；测试、词条与使用文档同步，既有 OTel 页面保持原有职责。

- [x] 将执行 Trace 页面、命令、无障碍注册和测试归属 Workbench；Sessions 复用同一个 editor。
- [x] 通过共享会话变化发现子 Thread，保持隐藏、恢复和关闭后的订阅生命周期。
- [x] 验证普通 Workbench 与 Sessions 的真实命令入口、中文、导入及实时读取，覆盖 Web 和 Electron。
- [x] 同步文档、词条与调用点，完成受影响 typecheck、正常构建、层级与差异检查。

## 已实现的入口与契约

- Workbench 命令 `ash.agentTrace.open`（“开发人员：打开执行 Trace”）及共享 editor；命令可传入 Session ID，否则打开可导入的页面。
- Sessions 命令 `sessions.trace.open`（“查看执行 Trace”）及会话工具栏只负责当前会话和布局，再调用共享命令；没有当前会话时仍可导入保存的 Trace。
- `session/trace/read` 读取既有 rollout v3，使用各 Thread 的独立游标分页；读取不会触发模型或工具执行。
- 在既有 `ash-rollout-trace` 中增加可选记录器与关系归纳器；`session/trace/diagnostics/read`、`payload/read` 和 `graph/read` 提供独立诊断分页、按需正文与关系读取。
- 在 App Server 启动前设置 `ASH_ROLLOUT_TRACE_ROOT=/absolute/local/directory` 开启正文记录；共享后端需要重启，未启用时仍可查看持久历史。
- `ash exec --model provider/model --timeout-seconds N --trace-output PATH --changes-output PATH` 固定模型、预算并导出历史与该 Turn 的封存文件结果。
- [评测 runner 与用例说明](test/agent-eval/README.md)：三个种子任务、独立 verifier、重复运行、基线比较及报告。
- [执行入口文档](docs/exec.md)、[Trace 界面说明](docs/chat-session-inspector.md)、[读取协议](docs/ash-app-server-api.md)。

## 验证记录（2026-10-07）

下列记录分别对应各批验证；初版发现的较宽范围回归及其修复结果见[较宽范围回归修复](#较宽范围回归修复)。
日志保存在本地忽略目录 [.build/agent-eval/validation/](.build/agent-eval/validation/)。

### Workbench 共享页面验证

| 验证                                 | 实际结果                                                                                                                   | 证据                                                                                                                                                                           |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Renderer 与 smoke typecheck          | 通过；中文词条无缺失，Trace 词条统一由共享 Chat 目录维护，移除原 Sessions 中的重复声明                                     | [Renderer](.build/agent-eval/validation/ash-agent-trace-shared-renderer-typecheck-v2.log)、[smoke](.build/agent-eval/validation/ash-agent-trace-shared-smoke-typecheck-v2.log) |
| Trace 页面、领域解析与 OTel 定向单测 | 13 项通过；共享页面不注册 Sessions 服务仍能创建、发现子 Thread，并保持关闭／隐藏／迟到响应的覆盖                           | [日志](.build/agent-eval/validation/ash-agent-trace-shared-unit-v2.log)                                                                                                        |
| 层级与 Sessions 装配单测             | 17 项通过；包含 Workbench 不依赖 Sessions、服务不依赖贡献、Chat 启动与 Sessions Part                                       | [日志](.build/agent-eval/validation/ash-agent-trace-shared-assembly-unit.log)                                                                                                  |
| 正常桌面 Renderer 与完整 Web build   | 两者通过，未出现源码编译 warning                                                                                           | [桌面](.build/agent-eval/validation/ash-agent-trace-shared-renderer-build.log)、[Web](.build/agent-eval/validation/ash-agent-trace-shared-web-build.log)                       |
| Web Playwright                       | 普通 Workbench、导入导出及实时历史 3 项通过；中文新增测试误用了关闭按钮译名，依据 DOM 改为公共关闭命令后，该项定向重跑通过 | [首轮](.build/agent-eval/validation/ash-agent-trace-shared-web-smoke.log)、[中文重跑](.build/agent-eval/validation/ash-agent-trace-shared-web-chinese-smoke.log)               |
| Electron Playwright                  | 4 项全部通过；覆盖普通 Workbench 与 Sessions 复用、中文、请求证据、键盘／无障碍、真实 Turn 与子 Thread、关闭重开           | [日志](.build/agent-eval/validation/ash-agent-trace-shared-electron-smoke.log)                                                                                                 |
| 文档与工作区检查                     | 使用文档的 5 个本地引用及 `git diff --check` 通过；原有 OTel 页面、后端与无关用户改动保留                                  | 本 TODO 与工作区差异                                                                                                                                                           |

### 本次诊断补齐

| 验证                                                                            | 实际结果                                                                                                                                                                                         | 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `just dependencies`、生成协议与协议 TypeScript typecheck                        | 通过；未新增 crate，内部依赖与生成物同步                                                                                                                                                         | [依赖](.build/agent-eval/validation/ash-agent-trace-fix-dependencies.log)、[生成](.build/agent-eval/validation/ash-agent-trace-fix-generate-protocol.log)、[typecheck](.build/agent-eval/validation/ash-agent-trace-fix-protocol-typecheck.log)                                                                                                                                                                                                                                                     |
| `just verify ash-rollout-trace`、`ash-thread-store`、`ash-state`、`ash-rollout` | 通过；Trace 8 项、ThreadStore 2 项、State 94 项且 1 忽略、rollout 5 项；包含中断正文、重开、损坏正文、符号链接、前缀闭包、SQLite 范围与图关系                                                    | [Trace](.build/agent-eval/validation/ash-agent-trace-fix-rollout-trace-verify.log)、[ThreadStore](.build/agent-eval/validation/ash-agent-trace-fix-thread-store-verify.log)、[State](.build/agent-eval/validation/ash-agent-trace-fix-state-verify.log)、[rollout](.build/agent-eval/validation/ash-agent-trace-fix-rollout-verify.log)                                                                                                                                                             |
| `just verify ash-app-server-protocol`、`ash-app-server-client`                  | 通过；协议 98 项 unit、2 项依赖、1 项 metadata，客户端 40 项；均完成 check 与零 warning 检查                                                                                                     | [协议](.build/agent-eval/validation/ash-agent-trace-fix-protocol-verify.log)、[客户端](.build/agent-eval/validation/ash-agent-trace-fix-client-verify.log)                                                                                                                                                                                                                                                                                                                                          |
| Core Turn、压缩与工具内辅助模型调用链                                           | Turn 101 项通过，补充压缩验证 1 项、诊断链路 4 项通过；实际失败重试、流式取消、诊断存储失败均由真实 loop 覆盖；辅助模型通过真实 mailbox 复用冻结的附件服务，避免重复转换与重复记录               | [Turn](.build/agent-eval/validation/ash-agent-trace-fix-core-turn-tests.log)、[压缩](.build/agent-eval/validation/ash-agent-trace-fix-compaction.log)、[诊断链路](.build/agent-eval/validation/ash-agent-trace-fix-core-diagnostics-complete.log)                                                                                                                                                                                                                                                   |
| App Server `session_trace` 与 CLI `exec::tests`                                 | 2 项与 7 项通过；验证正式诊断 RPC、只读行为、错误 capture／游标、正文与模型服务输入一致、跨页前缀累计                                                                                            | [App Server](.build/agent-eval/validation/ash-agent-trace-fix-server-tests.log)、[CLI](.build/agent-eval/validation/ash-agent-trace-fix-cli-exec-tests.log)                                                                                                                                                                                                                                                                                                                                         |
| Renderer、smoke typecheck、中文词条与 Trace 单测                                | 通过；中文无缺失；8 项单测覆盖正文延迟读取、关闭后迟到响应、隐藏恢复、独立诊断游标与前缀合并                                                                                                     | [Renderer](.build/agent-eval/validation/ash-agent-trace-fix-renderer-typecheck.log)、[smoke](.build/agent-eval/validation/ash-agent-trace-fix-smoke-typecheck.log)、[单测](.build/agent-eval/validation/ash-agent-trace-fix-unit.log)                                                                                                                                                                                                                                                               |
| `just test-python scripts`                                                      | 104 项测试，103 通过、1 项显式产品测试默认跳过                                                                                                                                                   | [日志](.build/agent-eval/validation/ash-agent-trace-fix-python.log)                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 显式真实产品链路评测                                                            | 3 个任务全部通过；HTTP 拒绝为 failed，1 秒超时为 timedOut 且保留部分响应，一次 HTTP 失败后重试成功；导出包含请求、响应与执行关系                                                                 | [日志](.build/agent-eval/validation/ash-agent-trace-fix-product.log)、[任务报告](.build/agent-eval/product-smoke-fix-v2/report.md)、[拒绝](.build/agent-eval/product-smoke-fix-v2-reject/report.md)、[超时](.build/agent-eval/product-smoke-fix-v2-hang/report.md)、[重试](.build/agent-eval/product-smoke-fix-v2-retry/report.md)                                                                                                                                                                  |
| Playwright Web 与 Electron，使用真实产品评测 Trace                              | 双端各 3 项通过；验证正文、关联键盘跳转、完整导出、中文、无障碍、实时 Turn／子 Thread 与关闭重开。Electron 首轮因旧主进程引用旧页面路径失败；正常重建 host 后同组测试通过                        | [Web](.build/agent-eval/validation/ash-agent-trace-fix-web-smoke.log)、[Electron](.build/agent-eval/validation/ash-agent-trace-fix-electron-smoke-v2.log)、[首轮诊断](.build/agent-eval/validation/ash-agent-trace-fix-electron-smoke.log)、[host build](.build/agent-eval/validation/ash-agent-trace-fix-host-build.log)                                                                                                                                                                           |
| 正常构建与 warning 检查                                                         | CLI、App Server 运行包、桌面 Renderer／host 和完整 Web build 通过；Core 与 CLI 的受影响 test targets 完成零编译 warning 检查。Playwright 的 NO_COLOR／FORCE_COLOR 环境提示不属于源码编译 warning | [CLI build](.build/agent-eval/validation/ash-agent-trace-fix-cli-build-final.log)、[运行包](.build/agent-eval/validation/ash-agent-trace-fix-backend-final.log)、[Renderer](.build/agent-eval/validation/ash-agent-trace-fix-renderer-build.log)、[Web](.build/agent-eval/validation/ash-agent-trace-fix-web-build.log)、[Core warning](.build/agent-eval/validation/ash-agent-trace-fix-core-warnings-final.log)、[CLI warning](.build/agent-eval/validation/ash-agent-trace-fix-cli-warnings.log) |
| 文档与差异检查                                                                  | 新增本地文档链接、受影响 Rust 文件格式与 `git diff --check` 通过；保留用户已有 integration 测试与技能改动                                                                                        | 本 TODO 与工作区差异                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

### 初版功能验证

| 验证                                                                                                           | 实际结果                                                                                                                          | 证据                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `just dependencies`                                                                                            | 通过；锁文件和内部依赖边同步                                                                                                      | [日志](.build/agent-eval/validation/ash-agent-trace-dependencies.log)                                                                                                                                                                                                                                                                                                                  |
| `just verify ash-app-server-protocol`、`ash-app-server-client`、`ash-exec`                                     | 三包的 check、test、零 warning 检查通过；包含生成物一致性及模型选择传递                                                           | [协议](.build/agent-eval/validation/ash-agent-trace-ash-app-server-protocol-verify.log)、[客户端](.build/agent-eval/validation/ash-agent-trace-ash-app-server-client-verify.log)、[Exec](.build/agent-eval/validation/ash-agent-trace-exec-verify.log)                                                                                                                                 |
| App Server Trace 集成测试                                                                                      | 1 项通过；真实 Turn、fork、分页、错误游标、增量历史及只读行为                                                                     | [日志](.build/agent-eval/validation/ash-agent-trace-rust-trace-test.log)                                                                                                                                                                                                                                                                                                               |
| CLI、Core、Core API、App Server 的 check 与零 warning 检查                                                     | 通过；全包测试的失败另列                                                                                                          | [check](.build/agent-eval/validation/ash-agent-trace-rust-check.log)、[CLI](.build/agent-eval/validation/ash-agent-trace-cli-warnings.log)、[Core](.build/agent-eval/validation/ash-agent-trace-core-warnings.log)、[Core API](.build/agent-eval/validation/ash-agent-trace-core-api-warnings.log)、[App Server](.build/agent-eval/validation/ash-agent-trace-app-server-warnings.log) |
| `just build-code`、桌面 Renderer build、完整 Web build                                                         | 正常构建通过                                                                                                                      | [CLI](.build/agent-eval/validation/ash-agent-trace-cli-build.log)、[桌面](.build/agent-eval/validation/ash-agent-trace-desktop-build.log)、[Web](.build/agent-eval/validation/ash-agent-trace-web-build.log)                                                                                                                                                                           |
| Renderer、协议、smoke TypeScript typecheck                                                                     | 通过；中文词条无缺失                                                                                                              | [Renderer](.build/agent-eval/validation/ash-agent-trace-renderer-typecheck.log)、[协议](.build/agent-eval/validation/ash-agent-trace-protocol-typecheck.log)、[smoke](.build/agent-eval/validation/ash-agent-trace-smoke-typecheck.log)                                                                                                                                                |
| `pnpm test:unit --runGlob '**/{agentTrace,traceEditor}.test.js'`                                               | 5 项通过；游标、原始字段保留、订阅间隙、隐藏恢复和过期响应                                                                        | [日志](.build/agent-eval/validation/ash-agent-trace-unit.log)                                                                                                                                                                                                                                                                                                                          |
| `just test-python scripts`                                                                                     | 104 项测试，103 通过、1 项显式产品测试默认跳过；包含重复运行、基线兼容、超时、错误结果还原和 verifier 拒绝错误解                  | [日志](.build/agent-eval/validation/ash-agent-trace-python.log)                                                                                                                                                                                                                                                                                                                        |
| `test_agent_eval_product.py`，显式提供构建好的 CLI 与后端                                                      | 真实产品路径的 3 个任务全部通过独立验收；模型拒绝返回 `failed`，1 秒预算返回 `timedOut`；均保存 Trace 和结果、清理各自后端        | [日志](.build/agent-eval/validation/ash-agent-trace-product-eval-final.log)、[成功报告](.build/agent-eval/product-smoke-final/report.md)、[拒绝报告](.build/agent-eval/product-smoke-final-reject/report.md)、[超时报告](.build/agent-eval/product-smoke-final-hang/report.md)                                                                                                         |
| Playwright `browser-app-server` / `electron-app-server`，`test/smoke/areas/sessions/trace.spec.ts --workers=1` | Web 与 Electron 各 3 项通过；真实评测 Trace 导入、原始详情／完整导出、中文入口／帮助、无障碍层级、实时 Turn／子 Thread 与关闭重开 | [Web](.build/agent-eval/validation/ash-agent-trace-web-smoke.log)、[Electron](.build/agent-eval/validation/ash-agent-trace-electron-smoke.log)                                                                                                                                                                                                                                         |
| 文档新增链接、格式及差异检查                                                                                   | 通过；没有改动用户的浏览器 integration 测试或技能文件，没有接受无关 TUI 快照                                                      | 本 TODO 与工作区差异                                                                                                                                                                                                                                                                                                                                                                   |

## 较宽范围回归修复

初版验证发现的四类失败已逐项修复；下表保存新的完整结果，原失败日志仍保留在验证目录。

- [x] Core 断言实际共享 prompt 内容，不再依赖旧标题；保留 root／worker 职责隔离和能力断言。
- [x] App Server 的目录限制与权限撤销测试明确保留应用工具，仍验证文件权限、执行服务移除和运行任务中断。
- [x] TUI 完整配置校验接受两项已移除的鼠标设置，在下一次终端设置保存时删除；未知字段和无效值继续拒绝。
- [x] 同步当前按键、焦点、状态面板和完整文本快照；为需要显示模式的场景显式启用对应状态栏项。
- [x] Issue PTY 使用真实 CLI／App Server，脚本只模拟 SSH 桥接与 GitHub HTTP；验证搜索、失败后的缓存、重新打开及创建前依赖检查。
- [x] 修复租约测试清理前未解锁的死锁；快照等待识别四种语言的剪贴板提示，并等待首页临时提示消失。
- [x] 补齐当前模型目录的 `retirement` fixture 字段，以及被全局 `output/` 规则误忽略的两份 inline 输出基线。
- [x] Core API 通过 Cargo metadata 显式选择 Core 的消费方测试；零通过用例仍使验证失败。
- [x] 同步依赖、Bazel 测试源清单、构建说明和 TUI 说明；修正验证工具的 Python lint／格式问题。

| 验证                                                 | 实际结果                                                                                                                        | 证据                                                                                                                                                                                                                                                              |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `just verify ash-core`                               | 295 通过、2 忽略；check、test、零 warning 检查通过                                                                              | [日志](.build/agent-eval/validation/fix-core-verify.log)                                                                                                                                                                                                          |
| `just verify ash-app-server`                         | 全部测试目标合计 637 通过、3 忽略；check、test、零 warning 检查通过                                                             | [日志](.build/agent-eval/validation/fix-app-server-verify.log)                                                                                                                                                                                                    |
| `just verify ash-core-api`                           | API check 与零 warning 检查通过；实际运行消费方 Core 的 295 项通过用例，2 项忽略                                                | [日志](.build/agent-eval/validation/fix-core-api-verify.log)                                                                                                                                                                                                      |
| TUI 全包测试与 all-targets 零 warning 编译检查       | 1361 通过、1 忽略；所有步骤通过；两份遗漏的基线按真实 App 输出审阅后纳入版本管理                                                | [测试](.build/agent-eval/validation/fix-tui-unit-pass4.log)、[check 与 warning](.build/agent-eval/validation/fix-tui-warnings.log)                                                                                                                                |
| CLI unit、check、零 warning 检查与 `just build-code` | 40 项 unit 通过；所有步骤通过；正常 `dev-small` 构建无编译 warning                                                              | [unit](.build/agent-eval/validation/fix-cli-unit.log)、[check](.build/agent-eval/validation/fix-cli-check.log)、[warning](.build/agent-eval/validation/fix-cli-warnings-final.log)、[正常构建](.build/agent-eval/validation/fix-build-code.log)                   |
| `just test-tui`                                      | 49 项全部通过；逐份审阅并接受基线后完整重跑成功，没有 `.snap.new`；中文公告场景同时验证了剪贴板提示等待修复                     | [最终重跑](.build/agent-eval/validation/fix-tui-complete.log)                                                                                                                                                                                                     |
| Python 工具、依赖和格式                              | 107 项测试，106 通过、1 项显式产品测试默认跳过；依赖检查、Python lint／格式检查、受影响 Rust 文件格式和 `git diff --check` 通过 | [测试](.build/agent-eval/validation/fix-python-scripts-complete.log)、[依赖](.build/agent-eval/validation/fix-dependencies.log)、[lint](.build/agent-eval/validation/fix-python-lint-final.log)、[格式](.build/agent-eval/validation/fix-python-format-final.log) |

## 当前边界

- Trace 只展示已经保存的执行事实。本地诊断缺省关闭；启用后保存 Core 与附件转换后的 ModelService 语义请求、响应和终止前部分输出。provider HTTP／WebSocket 字节、逐个 stream chunk 与其他内部模型服务尚不采集；缺失用量不会估算补齐。
- 正文每项最多 8 MiB，每个本地捕获最多 128 MiB／32,000 条事件；省略和存储不可用明确标记。运行时读取一次环境开关，目录清理由设置该目录的调用方负责。
- Trace 导出包含全部已加载事件及可读取的诊断正文，筛选只影响显示；目前全量保存在编辑器内存中，导入／导出限制为 64 MiB。
- 已发出的只读 RPC 无单独取消接口；关闭或隐藏编辑器后释放订阅、停止后续读取，并忽略其迟到响应。
- 评测结果还原支持单 Git 仓库、完整 UTF-8 普通文件；二进制、截断内容、符号链接、多仓库或未封存结果会明确失败。
- 产品 smoke 使用本地脚本化模型和三个手写种子任务。真实模型对比、真实失败任务集和效果基线尚未建立，不能据此给模型排名；使用说明提供扩充与运行方法。
