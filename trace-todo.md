# Trace roadmap

Trace 已能读取和跟随 Agent 的持久执行历史。本路线在现有能力上，优先完成 **具体 Turn 定位 → 模型与工具关系 → 一致导出 → 离线复查**，让一次失败从会话入口一直查到原始证据。本文是根目录 `TODO.md` 的改名与扩充；原内容完整保留在后半部分。

源码核对基线：2026-10-08，本地 `main` 的 `deb624dd6`（包含 `2cc6ab4`）。下文“现有”表示源码已具备；本轮尚未重跑历史验证，旧验证日志位于原工作区忽略目录，独立 worktree 不携带这些日志。

## Trace 现有能力

| 已有能力 | 当前行为与证据入口 |
| --- | --- |
| 共享入口和页面 | Workbench 的 `ash.agentTrace.open` 接收 Session ID，Sessions 的 `sessions.trace.open` 取当前 Session、切换布局后调用它；两端共用 [AgentTraceEditor](src/ash/workbench/contrib/trace/browser/agentTraceEditor.ts)、[共享命令](src/ash/workbench/contrib/trace/browser/trace.contribution.ts) 和 [Sessions 入口](src/ash/sessions/contrib/trace/browser/trace.contribution.ts)。 |
| 唯一历史来源与分页 | [ThreadStore](crates/thread-store/src/store.rs) 拥有持久事实；[rollout v3 分页](crates/rollout-trace/src/page.rs) 按 Thread 独立游标读有界范围，带上引用的历史前缀。页面合并分页，不触发执行。 |
| 正式只读 RPC | [Session operations](crates/app-server/src/server/session_operations.rs) 已提供 `session/trace/read`、`session/trace/diagnostics/read`、`session/trace/payload/read`、`session/trace/graph/read`；前端通过 [Chat 领域契约](src/ash/workbench/services/chat/common/agentTrace.ts) 消费。 |
| 历史与实时查阅 | Thread / Turn 层级、子 Thread、全文筛选、仅错误、JSON 详情、键盘导航、中文和无障碍帮助已存在；订阅补齐 read/subscribe 间隙，隐藏或关闭停止后续读取并释放订阅，迟到响应不覆盖新输入。 |
| 模型诊断与正文 | [记录器](crates/rollout-trace/src/recorder.rs) 和 [诊断契约](crates/rollout-trace/src/diagnostics.rs) 保存主循环、压缩与工具辅助模型的 attempt、语义请求/响应、失败、取消和部分输出；正文按需读取，未采集/省略/不可用有状态。请求属于 ModelService 边界，provider 传输字节与逐 chunk 采集尚未实现。 |
| 工具与子 agent 关系 | [关系归纳器](crates/rollout-trace/src/reducer.rs) 已生成模型请求工具、工具结果、Code Mode、终端、运行时调用、消息交付、委派与父子 Thread 的边；页面可沿已有 `eventKey` 跳转，缺失证据有 warnings。 |
| 导入、导出和评测 | rollout v3 JSON 导入/导出已保留未知字段、前缀、诊断与关系；显示筛选不裁剪导出。文件上限 64 MiB。CLI/评测沿产品执行路径保存任务结果，见 [评测说明](test/agent-eval/README.md)、[使用说明](docs/chat-session-inspector.md)、[真实 smoke 源码](test/smoke/areas/sessions/trace.spec.ts)。 |

另一项 [TraceEditor](src/ash/workbench/contrib/trace/browser/traceEditor.ts) 负责 OTel/OTLP/WebSocket span viewer。它与此处的 Agent 执行 Trace 有不同数据来源和用途；本路线以 ThreadStore 与诊断捕获为依据。

## 预计演进能力

| 阶段 | 用户完成的事情 | 复用与边界 |
| --- | --- | --- |
| P1 具体 Turn 定位 | 从指定 Session / Thread / Turn / event 打开 Trace，确认选中的是哪次执行；分页晚到、目标缺失和切换输入都有明确结果。 | 扩展共享前端打开参数与 URI，复用现有读取和订阅；业务历史仍归 ThreadStore。第一批完成打开、定位、详情、重开及回归验证的闭环。 |
| P2 模型与工具关系 | 从选中 Turn 找到实际模型请求、模型工具调用、工具结果与子 agent，区分并行、嵌套、消息交付和结果依赖。 | 先复用现有图与身份键；只把明确记录的因果关系连起来。补字段或关系语义前由父任务协调 Core/Rust/protocol 所有者。 |
| P3 一致导出 | 运行仍在继续时导出一次有明确边界的捕获；历史、诊断、正文与关系属于同一范围，导出期间保持单次操作。 | 先复现边界问题；决定按已加载范围裁剪关系还是由后端提供一致捕获契约。正文读取失败标为不完整，不能伪装为完整导出。 |
| P4 离线复查 | 无连接时导入、定位、查正文和关系，重新导出后证据仍可读；连续选择文件时最后一次选择生效。 | 保持 rollout v3 兼容与字段保留；限制大文件和不完整证据。长历史使用有界 DOM 和缓存搜索文本，避免每次渲染反复序列化大记录。 |

### 逐项核实，不能先承诺的能力

| 信息 | 当前证据与待核实项 | 演进验收条件 |
| --- | --- | --- |
| 上下文与参数 | 已记录 Core 请求、附件转换后的语义请求和历史前缀；具体每项参数、工具定义、压缩前后输入以已保存 payload 为准。 | 核对实际请求字段、来源、时间与模型选择；缺失正文明确提示；不从当前配置回填历史参数。 |
| token 与费用 | 页面已显示 invocation 中存在的 input/output token；[usage 聚合](crates/core/src/model_usage.rs) 保留部分报告和未知 invocation。费用来源、历史价格和完整 cache/reasoning 用量尚未核实。 | 分开显示已报告、缺失和估算；只有有明确价格来源、版本和计费规则时才展示费用估算。 |
| 权限等待 | [审批交互契约](crates/protocol/src/interaction/turn_interaction.rs) 存在；当前诊断事件集合主要覆盖模型 attempt，等待起止与决策是否持久关联到 Trace 尚未核实。 | 逐项核对请求、决策、等待时间与执行结果；未存储的间隔不根据界面停顿推断。 |
| 重试、超时、取消 | attempt 失败/取消/部分输出已记录，[真实 loop 回归源码](crates/core/src/turn/diagnostic_trace_tests.rs) 覆盖失败重试与流式取消；超时来源、重试归组和等待预算的全链路覆盖待核实。 | 同一 Turn 内区分 attempt、取消源、超时预算、终止状态与部分证据；缺少因果键时标为未知。 |
| 并行子 agent 与依赖 | 现有 graph 有父子 Thread、委派、消息交付、嵌套调用；依赖/等待关系与并行区间的完整持久证据尚未核实。 | 用真实多子 agent 场景验证身份、顺序、交付与结果依赖；不能把时间相近视为依赖。 |
| 副作用与恢复位置 | 评测已支持单 Git 仓库、完整 UTF-8 普通文件结果封存，见 [执行说明](docs/exec.md)；外部副作用、幂等性与可恢复位置未建立通用契约。 | 只提供有证据的恢复位置和前置条件；复查、结果还原与重新执行分别标注。任意安全重放不在承诺范围。 |
| 敏感信息 | 语义请求、路径、工具参数和结果可能包含秘密；现有记录上限不是分享脱敏机制。 | 先核实已有脱敏规则，再提供分享前预览、密钥/个人路径处理和遗漏说明；内部原始证据与分享产物的变换可追踪。 |

## 可执行 TODO 与验收标准

所有新工作先用相应单测或真实 Playwright 场景复现，再改所有者实现。Web 与 Electron 使用同一共享编辑器契约；源码检查和历史日志不能替代本轮运行验证。

### P1：打开指定执行并确认定位（第一批）

- [ ] 在共享 Trace 命令保留 Session ID 字符串兼容，增加结构化 Session / Thread / Turn / event 定位；URI 保存定位身份，重开得到同一目标。
- [ ] 页面逐页寻找目标；命中后选中并展示详情，自动滚动到目标；晚到分页不将选择重置为第一行。
- [ ] 目标缺失/参数无效有可翻译状态；错误/全文筛选不能悄悄把定位目标换成其他事件。
- [ ] 覆盖重开同 Session 不同 Turn、子 Thread、诊断 event、目标缺失、切换输入和关闭后的迟到响应；更新中文与无障碍说明。
- [ ] 验收：共享命令和现有 Sessions 入口仍可用；指定 Thread / Turn / event 的选中身份、详情和重开一致；定向单测、Renderer/smoke typecheck、正常 Renderer/Web 构建，以及 Web/Electron Playwright 行为断言通过。重型验证先排父任务队列。

### P2：查一条模型—工具—子 agent 证据链

- [ ] 从 P1 选中 Turn 查看模型 attempt → 请求/响应 → 工具 call/result → 子 Thread；保留现有 Code Mode、终端和消息交付关系。
- [ ] 核实上表中的上下文、用量、权限、重试、取消与并行证据，逐项记录“有来源 / 缺失 / 尚未验证”；需要新记录的项交给其现有所有者。
- [ ] 验收：真实成功、失败重试、流式取消、多子 agent 场景的跳转均指向已保存事件；正文按需读；缺少证据时出现明确说明；图 warnings 可查看，禁止编造因果关系。

### P3：运行中的一致导出

- [ ] 复现导出等待 payload 时 `render()` 重新启用按钮的竞态；导出进行中由页面单一状态拥有按钮生命周期，切换/隐藏/关闭使旧结果失效。
- [ ] 复现旧 capture 与随后全量 `graph/read` 的范围不一致；明确导出边界并验证所有图引用位于该边界或有明确缺失说明。
- [ ] 验收：导出中追加 Turn/诊断事件不会混入另一时刻的关系；快速点击只产生一个下载；正文读取失败、64 MiB 超限与输入切换均有确定结果；筛选仍只影响显示。

### P4：可靠离线复查与长历史

- [ ] 复现连续导入 A/B 的完成顺序竞态；最后选择的文件生效，即使 A 后完成或后失败。
- [ ] 以大记录/长历史量化 DOM 数量、输入筛选耗时和详情序列化开销，再实现有界渲染与搜索缓存；证据全集与显示窗口分开由现有页面持有。
- [ ] 分享脱敏先定义实际覆盖规则、预览和遗漏标记；原始证据保持可追溯。
- [ ] 验收：断开连接后，导入 → P1 定位 → P2 正文/关系 → 重导出仍可复查；未知字段、前缀与不完整状态保留；A/B 导入乱序回归通过；大记录性能结果有同机前后数据。

## 本轮交付与验证

- 文档：`TODO.md` → `trace-todo.md`，保留 `.md` 扩展名和全部原文；主树原文件未改动。
- 工作树：`/Volumes/1t/ash-trace-20261008`，分支 `codex/trace-roadmap-20261008`；后续 Trace 工作持续在这里完成，避免与 Search/SCM/Output/Preferences/Notifications 重叠。
- 文档预览提交：`b475f982a`，仅包含改名与路线图，未 push。
- 当前实现状态：P1 的前端实现和回归用例已写入本树，完整运行验收尚未完成；P1 验收复选框保持未完成。共享 Core/Rust/protocol 扩展先协调，Cargo/runtime/protocol 不跨树复用，push 由父任务串行放行。

### P1 本轮检查（2026-10-08）

| 检查 | 实际结果 |
| --- | --- |
| 文档链接与原文保全 | 18 个新增本地链接存在；原 `TODO.md` 的 36,201 字节完整保留。文档改名已单独提交，原主树未改动。 |
| JavaScript 依赖与前端清单 | `pnpm install --frozen-lockfile --offline` 与 `pnpm run prepare:extensions` 完成；使用本树生成的清单，没有跨树复用协议或运行包。 |
| 定向 common 层编译 | `pnpm exec tsc -p .build/trace-validation/tsconfig.location.json` 通过，配置继承仓库 `tsconfig.common.json`；不代表完整 Renderer 编译通过。 |
| 定位契约单测 | 已编译的 `trace.test.js` 通过 18 项；覆盖旧 Session 参数、URI 编码和身份保存、无效定位与仓库中文词条。 |
| Sessions 注册命令 | 现有 unit runner 实际执行的 3 项通过；覆盖子 Thread 最近 Turn、缺少 Turn 与无当前 Session。该次命令整体失败，另两个文件未能启动。 |
| 完整单测编译与页面/Workbench 命令单测 | 完整编译因独立树缺少 `.build/protocol` 及其他生成物失败；受影响 Trace 文件没有报出新增类型错误。清单补齐后，页面与 Workbench 命令测试仍因缺少生成协议模块而未执行。见本树 [.build/trace-validation/](.build/trace-validation/)。 |
| 变更格式 | 仓库 `format:ts` 检查全部 11 个相关 TypeScript 文件通过；`git diff --check` 通过。 |
| 正常构建与双端 Playwright | Renderer/Web 构建、Web/Electron Trace smoke 尚未运行；需要先由父任务排队准备本树协议和运行包。本轮没有重新引用历史通过结果。 |


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
