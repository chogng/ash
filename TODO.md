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

下列“通过”只对应该项验证；更宽的回归失败在下一节列出，没有宣称所有回归已通过。
日志保存在本地忽略目录 [.build/agent-eval/validation/](.build/agent-eval/validation/)。

### Workbench 共享页面验证

| 验证 | 实际结果 | 证据 |
| --- | --- | --- |
| Renderer 与 smoke typecheck | 通过；中文词条无缺失，Trace 词条统一由共享 Chat 目录维护，移除原 Sessions 中的重复声明 | [Renderer](.build/agent-eval/validation/ash-agent-trace-shared-renderer-typecheck-v2.log)、[smoke](.build/agent-eval/validation/ash-agent-trace-shared-smoke-typecheck-v2.log) |
| Trace 页面、领域解析与 OTel 定向单测 | 13 项通过；共享页面不注册 Sessions 服务仍能创建、发现子 Thread，并保持关闭／隐藏／迟到响应的覆盖 | [日志](.build/agent-eval/validation/ash-agent-trace-shared-unit-v2.log) |
| 层级与 Sessions 装配单测 | 17 项通过；包含 Workbench 不依赖 Sessions、服务不依赖贡献、Chat 启动与 Sessions Part | [日志](.build/agent-eval/validation/ash-agent-trace-shared-assembly-unit.log) |
| 正常桌面 Renderer 与完整 Web build | 两者通过，未出现源码编译 warning | [桌面](.build/agent-eval/validation/ash-agent-trace-shared-renderer-build.log)、[Web](.build/agent-eval/validation/ash-agent-trace-shared-web-build.log) |
| Web Playwright | 普通 Workbench、导入导出及实时历史 3 项通过；中文新增测试误用了关闭按钮译名，依据 DOM 改为公共关闭命令后，该项定向重跑通过 | [首轮](.build/agent-eval/validation/ash-agent-trace-shared-web-smoke.log)、[中文重跑](.build/agent-eval/validation/ash-agent-trace-shared-web-chinese-smoke.log) |
| Electron Playwright | 4 项全部通过；覆盖普通 Workbench 与 Sessions 复用、中文、请求证据、键盘／无障碍、真实 Turn 与子 Thread、关闭重开 | [日志](.build/agent-eval/validation/ash-agent-trace-shared-electron-smoke.log) |
| 文档与工作区检查 | 使用文档的 5 个本地引用及 `git diff --check` 通过；原有 OTel 页面、后端与无关用户改动保留 | 本 TODO 与工作区差异 |

### 本次诊断补齐

| 验证 | 实际结果 | 证据 |
| --- | --- | --- |
| `just dependencies`、生成协议与协议 TypeScript typecheck | 通过；未新增 crate，内部依赖与生成物同步 | [依赖](.build/agent-eval/validation/ash-agent-trace-fix-dependencies.log)、[生成](.build/agent-eval/validation/ash-agent-trace-fix-generate-protocol.log)、[typecheck](.build/agent-eval/validation/ash-agent-trace-fix-protocol-typecheck.log) |
| `just verify ash-rollout-trace`、`ash-thread-store`、`ash-state`、`ash-rollout` | 通过；Trace 8 项、ThreadStore 2 项、State 94 项且 1 忽略、rollout 5 项；包含中断正文、重开、损坏正文、符号链接、前缀闭包、SQLite 范围与图关系 | [Trace](.build/agent-eval/validation/ash-agent-trace-fix-rollout-trace-verify.log)、[ThreadStore](.build/agent-eval/validation/ash-agent-trace-fix-thread-store-verify.log)、[State](.build/agent-eval/validation/ash-agent-trace-fix-state-verify.log)、[rollout](.build/agent-eval/validation/ash-agent-trace-fix-rollout-verify.log) |
| `just verify ash-app-server-protocol`、`ash-app-server-client` | 通过；协议 98 项 unit、2 项依赖、1 项 metadata，客户端 40 项；均完成 check 与零 warning 检查 | [协议](.build/agent-eval/validation/ash-agent-trace-fix-protocol-verify.log)、[客户端](.build/agent-eval/validation/ash-agent-trace-fix-client-verify.log) |
| Core Turn、压缩与工具内辅助模型调用链 | Turn 101 项通过，补充压缩验证 1 项、诊断链路 4 项通过；实际失败重试、流式取消、诊断存储失败均由真实 loop 覆盖；辅助模型通过真实 mailbox 复用冻结的附件服务，避免重复转换与重复记录 | [Turn](.build/agent-eval/validation/ash-agent-trace-fix-core-turn-tests.log)、[压缩](.build/agent-eval/validation/ash-agent-trace-fix-compaction.log)、[诊断链路](.build/agent-eval/validation/ash-agent-trace-fix-core-diagnostics-complete.log) |
| App Server `session_trace` 与 CLI `exec::tests` | 2 项与 7 项通过；验证正式诊断 RPC、只读行为、错误 capture／游标、正文与模型服务输入一致、跨页前缀累计 | [App Server](.build/agent-eval/validation/ash-agent-trace-fix-server-tests.log)、[CLI](.build/agent-eval/validation/ash-agent-trace-fix-cli-exec-tests.log) |
| Renderer、smoke typecheck、中文词条与 Trace 单测 | 通过；中文无缺失；8 项单测覆盖正文延迟读取、关闭后迟到响应、隐藏恢复、独立诊断游标与前缀合并 | [Renderer](.build/agent-eval/validation/ash-agent-trace-fix-renderer-typecheck.log)、[smoke](.build/agent-eval/validation/ash-agent-trace-fix-smoke-typecheck.log)、[单测](.build/agent-eval/validation/ash-agent-trace-fix-unit.log) |
| `just test-python scripts` | 104 项测试，103 通过、1 项显式产品测试默认跳过 | [日志](.build/agent-eval/validation/ash-agent-trace-fix-python.log) |
| 显式真实产品链路评测 | 3 个任务全部通过；HTTP 拒绝为 failed，1 秒超时为 timedOut 且保留部分响应，一次 HTTP 失败后重试成功；导出包含请求、响应与执行关系 | [日志](.build/agent-eval/validation/ash-agent-trace-fix-product.log)、[任务报告](.build/agent-eval/product-smoke-fix-v2/report.md)、[拒绝](.build/agent-eval/product-smoke-fix-v2-reject/report.md)、[超时](.build/agent-eval/product-smoke-fix-v2-hang/report.md)、[重试](.build/agent-eval/product-smoke-fix-v2-retry/report.md) |
| Playwright Web 与 Electron，使用真实产品评测 Trace | 双端各 3 项通过；验证正文、关联键盘跳转、完整导出、中文、无障碍、实时 Turn／子 Thread 与关闭重开。Electron 首轮因旧主进程引用旧页面路径失败；正常重建 host 后同组测试通过 | [Web](.build/agent-eval/validation/ash-agent-trace-fix-web-smoke.log)、[Electron](.build/agent-eval/validation/ash-agent-trace-fix-electron-smoke-v2.log)、[首轮诊断](.build/agent-eval/validation/ash-agent-trace-fix-electron-smoke.log)、[host build](.build/agent-eval/validation/ash-agent-trace-fix-host-build.log) |
| 正常构建与 warning 检查 | CLI、App Server 运行包、桌面 Renderer／host 和完整 Web build 通过；Core 与 CLI 的受影响 test targets 完成零编译 warning 检查。Playwright 的 NO_COLOR／FORCE_COLOR 环境提示不属于源码编译 warning | [CLI build](.build/agent-eval/validation/ash-agent-trace-fix-cli-build-final.log)、[运行包](.build/agent-eval/validation/ash-agent-trace-fix-backend-final.log)、[Renderer](.build/agent-eval/validation/ash-agent-trace-fix-renderer-build.log)、[Web](.build/agent-eval/validation/ash-agent-trace-fix-web-build.log)、[Core warning](.build/agent-eval/validation/ash-agent-trace-fix-core-warnings-final.log)、[CLI warning](.build/agent-eval/validation/ash-agent-trace-fix-cli-warnings.log) |
| 文档与差异检查 | 新增本地文档链接、受影响 Rust 文件格式与 `git diff --check` 通过；保留用户已有 integration 测试与技能改动 | 本 TODO 与工作区差异 |

### 初版功能验证

| 验证 | 实际结果 | 证据 |
| --- | --- | --- |
| `just dependencies` | 通过；锁文件和内部依赖边同步 | [日志](.build/agent-eval/validation/ash-agent-trace-dependencies.log) |
| `just verify ash-app-server-protocol`、`ash-app-server-client`、`ash-exec` | 三包的 check、test、零 warning 检查通过；包含生成物一致性及模型选择传递 | [协议](.build/agent-eval/validation/ash-agent-trace-ash-app-server-protocol-verify.log)、[客户端](.build/agent-eval/validation/ash-agent-trace-ash-app-server-client-verify.log)、[Exec](.build/agent-eval/validation/ash-agent-trace-exec-verify.log) |
| App Server Trace 集成测试 | 1 项通过；真实 Turn、fork、分页、错误游标、增量历史及只读行为 | [日志](.build/agent-eval/validation/ash-agent-trace-rust-trace-test.log) |
| CLI、Core、Core API、App Server 的 check 与零 warning 检查 | 通过；全包测试的失败另列 | [check](.build/agent-eval/validation/ash-agent-trace-rust-check.log)、[CLI](.build/agent-eval/validation/ash-agent-trace-cli-warnings.log)、[Core](.build/agent-eval/validation/ash-agent-trace-core-warnings.log)、[Core API](.build/agent-eval/validation/ash-agent-trace-core-api-warnings.log)、[App Server](.build/agent-eval/validation/ash-agent-trace-app-server-warnings.log) |
| `just build-code`、桌面 Renderer build、完整 Web build | 正常构建通过 | [CLI](.build/agent-eval/validation/ash-agent-trace-cli-build.log)、[桌面](.build/agent-eval/validation/ash-agent-trace-desktop-build.log)、[Web](.build/agent-eval/validation/ash-agent-trace-web-build.log) |
| Renderer、协议、smoke TypeScript typecheck | 通过；中文词条无缺失 | [Renderer](.build/agent-eval/validation/ash-agent-trace-renderer-typecheck.log)、[协议](.build/agent-eval/validation/ash-agent-trace-protocol-typecheck.log)、[smoke](.build/agent-eval/validation/ash-agent-trace-smoke-typecheck.log) |
| `pnpm test:unit --runGlob '**/{agentTrace,traceEditor}.test.js'` | 5 项通过；游标、原始字段保留、订阅间隙、隐藏恢复和过期响应 | [日志](.build/agent-eval/validation/ash-agent-trace-unit.log) |
| `just test-python scripts` | 104 项测试，103 通过、1 项显式产品测试默认跳过；包含重复运行、基线兼容、超时、错误结果还原和 verifier 拒绝错误解 | [日志](.build/agent-eval/validation/ash-agent-trace-python.log) |
| `test_agent_eval_product.py`，显式提供构建好的 CLI 与后端 | 真实产品路径的 3 个任务全部通过独立验收；模型拒绝返回 `failed`，1 秒预算返回 `timedOut`；均保存 Trace 和结果、清理各自后端 | [日志](.build/agent-eval/validation/ash-agent-trace-product-eval-final.log)、[成功报告](.build/agent-eval/product-smoke-final/report.md)、[拒绝报告](.build/agent-eval/product-smoke-final-reject/report.md)、[超时报告](.build/agent-eval/product-smoke-final-hang/report.md) |
| Playwright `browser-app-server` / `electron-app-server`，`test/smoke/areas/sessions/trace.spec.ts --workers=1` | Web 与 Electron 各 3 项通过；真实评测 Trace 导入、原始详情／完整导出、中文入口／帮助、无障碍层级、实时 Turn／子 Thread 与关闭重开 | [Web](.build/agent-eval/validation/ash-agent-trace-web-smoke.log)、[Electron](.build/agent-eval/validation/ash-agent-trace-electron-smoke.log) |
| 文档新增链接、格式及差异检查 | 通过；没有改动用户的浏览器 integration 测试或技能文件，没有接受无关 TUI 快照 | 本 TODO 与工作区差异 |

## 较宽范围回归未通过的项

下列结果来自初版功能的较宽范围验证，未在诊断补齐后重跑全包测试。这些失败涉及本次没有修改的共享文案、服务断言或 TUI 行为。尚未通过同配置的未改动版本对照来证明它们全部既有，因此保留完整结果，不将它们归为已解决。

| 命令 | 结果与失败点 | 证据 |
| --- | --- | --- |
| `just verify ash-core` | 290 通过、1 失败、2 忽略；`multi_agent::coordinator::tests::root_role_and_default_worker_share_rules_without_inheriting_responsibilities` 断言文案包含 `Shared working rules`，单独重跑仍失败 | [日志](.build/agent-eval/validation/ash-agent-trace-ash-core-verify.log)、[重跑](.build/agent-eval/validation/ash-agent-trace-core-existing-failure.log) |
| `just verify ash-app-server` | 613 通过、2 失败、3 忽略；`restricted_dir_installs_only_non_executable_services` 与 `user_config_revocation_removes_executable_services_but_keeps_file_access` 断言服务定义应为空 | [日志](.build/agent-eval/validation/ash-agent-trace-ash-app-server-verify.log) |
| CLI 全包测试及 `just test-tui` | CLI unit、commands、remote、remote_connect、remote_interactive、remote_stdio 均通过；完整装配后的 TUI 49 项中 14 通过、35 失败，包含旧 `copyOnSelect` 配置、交互文案和 7 份快照差异 | [CLI](.build/agent-eval/validation/ash-agent-trace-cli-tests.log)、[TUI 重跑](.build/agent-eval/validation/ash-agent-trace-tui.log)、[未接受的快照](.build/agent-eval/validation/tui-snapshots/) |
| `just verify ash-core-api` | check 通过；该 trait 包无独立测试，verify 包装器因 `No tests passed` 停止。已另行完成零 warning 检查，并由客户端／真实产品集成测试覆盖新接口 | [日志](.build/agent-eval/validation/ash-agent-trace-ash-core-api-verify.log) |

## 当前边界

- Trace 只展示已经保存的执行事实。本地诊断缺省关闭；启用后保存 Core 与附件转换后的 ModelService 语义请求、响应和终止前部分输出。provider HTTP／WebSocket 字节、逐个 stream chunk 与其他内部模型服务尚不采集；缺失用量不会估算补齐。
- 正文每项最多 8 MiB，每个本地捕获最多 128 MiB／32,000 条事件；省略和存储不可用明确标记。运行时读取一次环境开关，目录清理由设置该目录的调用方负责。
- Trace 导出包含全部已加载事件及可读取的诊断正文，筛选只影响显示；目前全量保存在编辑器内存中，导入／导出限制为 64 MiB。
- 已发出的只读 RPC 无单独取消接口；关闭或隐藏编辑器后释放订阅、停止后续读取，并忽略其迟到响应。
- 评测结果还原支持单 Git 仓库、完整 UTF-8 普通文件；二进制、截断内容、符号链接、多仓库或未封存结果会明确失败。
- 产品 smoke 使用本地脚本化模型和三个手写种子任务。真实模型对比、真实失败任务集和效果基线尚未建立，不能据此给模型排名；使用说明提供扩充与运行方法。
