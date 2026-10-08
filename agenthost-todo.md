# AgentHost 对齐实施清单

建议先修复已存在的模型目录与会话模型一致性，再接通后台会话的被动状态显示，最后验证断线恢复和权限生命周期。保留 Ash 的 Rust 执行与持久化架构；VS Code 用来核对公开职责和可观察行为，不作为 Node runtime、私有类图或协议的移植模板。

本文件供云端方案审阅和分批实施。按后续授权，第一批六文件和第二批两文件已在隔离云端 clone 完成各自可验证闭环，分开导出补丁。第一批已交付本地消费；两批真实 Web/Electron 交互与 Mac 产品验收仍待完成。第三批及后续目录身份契约只有方案，没有实施。没有提交或推送。根目录位置按本次用户要求选择，不启动 `/develop` 四份阶段产物流程。

### 第二批交付范围与重要未闭环项

第二批实现的是**当前公开身份可区分的模型目录更新**。不能把它标成所有账户/模型来源的身份隔离已经完成，也不能把类型检查、Web 构建或 WidgetModel 单测标成真实 picker 产品验收。

1. **Kimi subscription 同公开身份重登录未闭环。** `AccountDto.accountId` 固定为 `current`，实际目录身份是 Rust 私有 `device_id`；新设备登录可把 `credentialRevision` 重置为 1，正常 token 轮换又会递增它。`account/login/completed` 没有 provider 字段，成功事件也不能可靠区分 Kimi 重登录和无关 GitHub 登录。本片没有追加 Rust/公共协议，也没有声称解决这个场景。
2. **external `kimi-desktop` / `kimi-cli` 身份与缓存读取未闭环。** 它们使用私有凭证摘要作用域，不属于现有 subscription observer；发现模型未纳入权威 `model/list`，而 `provider/models/list` 会发起远程刷新。本片保留已有接入方式；不能承诺外部凭证切换后刷新失败时不会保留旧目录。
3. **首次账户快照是保守边界。** 若目录已加载、此前没有见过账户快照，第一个账户通知无法证明缓存属于哪个账户，因而会退役旧视图。这可能在无关登录触发首个快照、随后读取失败时暂时显示空目录；后续已建立身份的无关 GitHub 更新和同账户 token 轮换不会错误清空。

这些约束与最小后续契约的只读方案见 [agenthost-catalog-epoch-plan.md](agenthost-catalog-epoch-plan.md)。方案沿原有 backend catalog/subscription/runtime owner 增加不含私有设备或凭证信息的 view epoch；需与 SCM 的共享协议集成协调后另行批准实施。

### 第一批实际结果

2026-10-08 UTC，代码基线仍为 `dd086508b8c0eabe5931793302e8f7dc3d7a47b3` 加下述未提交六文件 diff：

- 生产 owner：SQLite catalog predicate、Session provider、Management equality，准确路径与本节后续 todo 一致。
- 测试：`crates/state/src/sqlite_tests.rs`、`sessionsManagementService.test.ts`、`chatViewPane.test.ts`；startup 测试原文件未修改但参与验证。
- Rust 红测真实复现 3 个失效条件，原有 passive-read 测试通过；修复后相同 4 个测试全绿。
- `just verify ash-state` 完成 check、97 个全包测试和 rust-warnings；1 个手动性能 benchmark 按原有标记 ignored。
- 标准 `pnpm test:unit --run src/ash/sessions/services/sessions/test/browser/sessionsManagementService.test.ts --run src/ash/sessions/test/browser/chatViewPane.test.ts --run src/ash/sessions/test/browser/chatViewPane.startup.test.ts` 最终通过完整 test 编译、5 个 runner 回归和 134 个定向测试。此前定向回退也通过，但最终结论以标准入口为准。
- `pnpm typecheck:renderer`、`pnpm build:web`、定向格式与 whitespace 检查通过。Web 构建仅有 Vite 插件耗时诊断。
- 初期 optional native-keymap 声明缺失曾阻塞完整编译；最终声明和 manifest 已与官方 3.3.9 archive 核对，archive SHA512 匹配冻结 lock，标准编译已不再受阻。native runtime binary 没有因此得到验证。
- 独立六文件源码审核无阻塞。未修改 Core 生产执行/trace、协议 schema、SCM、锁文件、公共指导或其他并行任务文件。

交付源码补丁为 `agenthost-b1.patch`，40,113 bytes，SHA256 `fa94415673aa83fb054856e41a3f17c5a92c6683efa4066879e29a0d671032b3`。它只包含本批六个实现/测试文件；完整 todo 单独交付，不把其他规划文件混入补丁。

剩余验收是实际 picker DOM、pane/profile 关闭重开、Code/Cowork、多窗口和 Web/Electron 运行时。模型/DI 至 inputState/startTurn 的单测通过不等于这些交互已通过。锁定 Chromium 下载曾收到截断 ZIP，随后安装调用的 approval review 被取消；已停止此步骤，未改用系统 Chromium。云端没有就绪的 Electron binary/display，Mac 需消费完整补丁与本文件后验证。

### 第二批实际结果

2026-10-08 UTC，仍基于 Ash `dd086508b8c0eabe5931793302e8f7dc3d7a47b3`；本片只新增下列两文件未提交 diff，未改动第一批六文件：

- 生产 owner：`src/ash/workbench/contrib/chat/common/languageModels.ts`。
- 对应测试：`src/ash/workbench/contrib/chat/test/common/languageModels.test.ts`。
- 消费 `provider/models/updated`、`account/updated`、`account/login/completed` 和原有 API-key/connection 事件。Models、Empty、Failed 均作为失效信号，重读完整后台目录和 provider 状态，不能用单 provider payload 替换全局数组。
- 完成并发刷新合并、刷新中失效补读、成功/失败完成微任务边界、旧连接/旧账户调用者的迟到结果与错误、pending successor 所有权和 dispose 检查。旧调用者不会在新账户结果之后再写回捕获的空视图。
- 公开 model account 的 accountId/organization/plan/status 变化先发布空的当前可选视图，避免 pane 在新账户查询失败时保留旧数组；同账户查询失败保留有效快照。以真实 provider connection 集合过滤无关登录账户，credentialRevision-only token 轮换只重读，不误当新身份清空。
- 比较 provider 状态与模型元数据，provider-only readiness 改变会通知，完全相同结果保持安静。目录刷新不调用模型选择、默认值、visibility 或配置写入 API。
- 最初标准红测共 20 项，3 通过、17 失败；独立复核新增的成功完成边界、同时完成的消费者、token 轮换与 GitHub 范围四项也真实复现红测。修复后最终 service 文件有 30 项通过，包括真正权威空目录必须清空的独立回归。
- 最终标准 `pnpm test:unit --run src/ash/workbench/contrib/chat/test/common/languageModels.test.ts --run src/ash/sessions/services/sessions/test/browser/sessionsManagementService.test.ts --run src/ash/sessions/test/browser/chatViewPane.test.ts --run src/ash/sessions/test/browser/chatViewPane.startup.test.ts` 通过完整 test 编译、5 个 runner 回归和 164 个定向测试。已有 Code/Cowork 手选/Auto 回归继续通过，但它们不是新 provider notification 入口的真实产品验收。
- `pnpm typecheck:renderer`、`pnpm build:web`、两文件格式、`git diff --check` 通过；独立源码复核在上述明确公开身份范围内无阻塞。没有运行 Cargo，也没有改 Rust、Core、Trace、公共 Terminal/SCM 协议、锁文件或公共规则。
- 第一批六文件 SHA256 全部保持不变。第二批补丁在 clean HEAD 的两文件 fixture 上完成 `git apply --check`、实际 apply 和逐字节比对。

独立源码补丁为 `agenthost-b2.patch`，35,119 bytes，SHA256 `682821e7a3a691d5746af0d341d60fe5c8dc7ac414f7b722fc12e82ee85875d7`。只含本批两文件；本文件、后续只读契约方案与证据单独交付。先保存第一批本地 checkpoint，再消费第二批，保持两片可独立审阅与提交。

尚需统一 Mac 验收：已打开的 Code/Cowork picker 收到真实 provider notification 后更新；失败/Empty/账户变化行为可解释；模型、能力和 thinking 选项反映权威目录；手选、显式 Auto、隐藏模型与 profile 默认保持各自 owner；pane/profile 重开、重连和多窗口验证。Kimi 两类身份未闭环不能因这些常规用例通过而标成完成。

## 现有能力与演进方向

| 现有能力                                                                          | 初始审计确认的缺口                                                       | 演进方向                                                       |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------- |
| 一份 Rust 后台服务、多窗口独立 connection；Renderer 持有协议客户端，Main 透明转发 | 连接与恢复已有覆盖，仍需验证不同宿主的恢复边界                           | 保留拓扑，验证 generation、订阅重建、未知结果和窗口关闭隔离    |
| Rust 持久化根 Thread 模型并提供 Session.model                                     | SQLite 的 Session 目录失效判定遗漏 model；前端目录映射忽略 Session.model | 第一批修复真实持久事实到模型选择器的完整链路                   |
| Rust 维护模型发现结果，发布 provider/models/updated                               | 前端 LanguageModelsService 不消费该通知                                  | 第二批使真实模型目录更新抵达已打开的选择器，保留账户与结果语义 |
| Session 目录读取不加载整份历史；订阅按需加载详情                                  | 后台目录缺少每个 Thread 的管理状态，列表也未呈现该状态                   | 第三批暴露现有粗粒度管理事实；精确 Turn 状态另行决定           |
| Core 拥有 Thread/Turn 顺序、policy、交互、取消和执行                              | 本轮未证明需要替换这些 owner                                             | 后续只补可复现的端到端差异，沿现有 Rust owner 修复             |

### 审计基线与证据范围

- Ash：`dd086508b8c0eabe5931793302e8f7dc3d7a47b3`，隔离云端 clone 的 `main`；根目录工作树在写本文件前干净。读取了最近 150 个提交范围内相关文件历史。
- VS Code：`ddcb6c27affe30052a2ade0bfe6c8bcaea9f89e5`，2026-10-08 04:42:38 UTC；只读稀疏 checkout 覆盖 platform/agentHost、Workbench agentHost/chat 和 Sessions。
- 上游近期演进来自按 `src/vs/platform/agentHost` 路径筛选的 50 条提交，不代表整个 VS Code 最近 50 条提交或完整历史。最近一条相关提交为 `9447b39a0b72cd07a936427b944fd865866f348a`，2026-10-08 04:37:30 UTC。
- 本地实施前必须重新记录 HEAD、目标文件未提交差异和对应上游基线。云端 clone 没有用户本地分支、未提交改动或其他任务实时 diff，不能据此断言本地也干净。

相关上游变化：

| UTC 日期            | 提交与公开变化                                                                                                                          | Ash 使用方式                                                    |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 2026-10-07 19:18:18 | [ac4cf28d 缓存 peer chat 详情并在未订阅时提供状态](https://github.com/microsoft/vscode/commit/ac4cf28d8cc5d9bdf08b8578d1931135fa12a1ae) | 核对被动目录状态、详情按需加载和前端缓存责任                    |
| 2026-10-07 19:18:41 | [e11f0d83 保留启动期间的 Codex 模型选择](https://github.com/microsoft/vscode/commit/e11f0d833b19f1035dde69cf974b1515863d884f)           | 核对已持久化选择、临时选择与默认模型的优先级                    |
| 2026-10-07 21:16:50 | [b3a9b152 空 SDK 刷新时保留模型目录](https://github.com/microsoft/vscode/commit/b3a9b152d558e1bd66ae0437cf6d6cae2a9707ad)               | 仅借鉴失败不应意外清空的行为；Ash 的成功 Empty 有独立含义       |
| 2026-10-07 21:22:27 | [19f093cc 启动前执行 MCP enablement](https://github.com/microsoft/vscode/commit/19f093cc13efc8e2c0e3fc694a03cdaa6afc7169)               | 后续核对禁用、恢复、认证与工具可见性，不能只隐藏 picker         |
| 2026-10-08 01:07:22 | [91fa1538 OS sleep 后保留 relay 恢复](https://github.com/microsoft/vscode/commit/91fa1538649fa815b4c6810eda29f032e6e9a342)              | 核对恢复计时与重新鉴权；不移植 AHP reconnect/outbox             |
| 2026-10-08 01:25:41 | [51ec2ee4 AHP 与 legacy version 兼容](https://github.com/microsoft/vscode/commit/51ec2ee42fdaa95257129e1dcea2f64cb7ae55e3)              | 核对兼容失败可观察性；Ash 仍使用自身 major/schema hash 锁步契约 |
| 2026-10-08 03:59:07 | [58afa23a 标题策略与旧配置迁移](https://github.com/microsoft/vscode/commit/58afa23a1cb18ac5d0aa894d9f2d88765889fae3)                    | 暂列后续产品能力，当前不增加同名设置或工具                      |

## 职责与真实调用链

Ash 的 [前后端边界](docs/frontend-app-server-boundary.md)已明确 `platform/agentHost` 承接 Rust App Server 接入。当前两仓的 agentHost 目录没有同相对路径文件；这说明需要先辨认同职责，不能把上游缺失清单直接转成新文件队列。已有 Ash 专属 adapter 保留其职责，新增专属归属或重大 owner 变化须重新确认。

下表的 VS Code 前端缩写路径相对 `src/vs/`，Ash 前端缩写路径相对 `src/ash/`；`crates/` 路径相对仓库根目录。后续 todo 均列完整仓库相对路径。

| 职责                   | VS Code 证据入口                                                                                                                    | Ash 唯一 owner 与调用链                                                                                                                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 服务契约与装配         | `platform/agentHost/common/agentService.ts`、`common/agent.ts`；`workbench/services/agentHost/electron-browser/agentHostService.ts` | `platform/agentHost/common/appServerApi.ts`；各领域 common API；`workbench/browser/workbench.ts`、`sessions/browser/workbench.ts` 经现有 DI 创建 service/provider                               |
| 初始化、请求配对与事件 | `platform/agentHost/browser/agentHostProtocolClient.ts`、`common/state/sessionProtocol.ts`                                          | `platform/agentHost/browser/appServerProtocolClient.ts` 负责一个 Renderer connection 的 pending、双向 dispatch、decoder、generation 与关闭；生成契约源在 `crates/app-server-protocol`           |
| transport 与进程       | `platform/agentHost/common/agent.ts` 中 starter/connection 契约及对应宿主                                                           | `appServerMessagePortTransport.ts` / `appServerWebSocketTransport.ts` → Main `appServerConnectionRelay.ts` → `platform/app-server-daemon` → `crates/app-server-daemon` → 共享 Rust App Server   |
| Session/Chat/Thread    | `sessions/contrib/providers/agentHost/browser/baseAgentHostSessionsProvider.ts`；`platform/agentHost/node/agentService.ts`          | `AppServerSessionsProvider` → `platform/sessions/browser/sessionApi.ts` → `app-server/server/session_operations.rs` → Core/Thread store；`SessionsManagementService` 仅拥有显示目录、草稿与路由 |
| 状态、历史与流         | `node/agentHostStateManager.ts`、`node/agentSideEffects.ts` 与 AHP channels                                                         | `crates/core` reducer/controller 拥有顺序和执行事实，`crates/state` 保存 verified catalog/history；`ChatService` 与 pane model 接收 snapshot/transcript/update 并维护呈现状态                   |
| 模型与工具             | 上游 provider 与 catalog 契约                                                                                                       | `crates/models-manager`、`crates/subscriptions`、`crates/model-provider` 拥有发现和调用；Frontend `LanguageModelsService` 拥有显示目录，pane 拥有未发送选择；工具执行不迁入 frontend            |
| 权限与取消             | 上游 permission/turn/provider 契约及行为测试                                                                                        | Rust Core policy/interaction/turn owner；`ChatService` → `ITurnApi` → `session/request` 的 typed interrupt/interaction。取消 Promise 不代表后台停止                                             |

### 第一批闭环

用户重开已有会话或后台启动进行模型迁移 → Rust Thread snapshot/ThreadCatalogRecord → SQLite 同事务刷新 session_catalog → `session/list` / `session/catalog/read` → Session provider 映射 → SessionsManagement → Code/Cowork pane 模型选择器 → 下一次 `startTurn` 使用正确选择。

唯一持久 owner 仍为 Rust Thread；Session 是分组只读视图，不新增 Session reducer 或独立 sequence。Pane 的未发送手动选择、显式 Auto 和 profile 默认值各自保持已有 owner。

## 第一批 修复会话模型事实一致性

**优先级最高，建议首个本地实施批次。** 用户收益是重开或重连时不显示错误的全局默认模型，后台模型迁移不会让 Session 目录继续报告旧值。

初始基线确认的源码条件：

1. [Rust Session.model](crates/protocol/src/session.rs)来自根 Thread 最近接受的 Turn，child/fork 的选择不替换根模型。
2. [thread_catalog_record](crates/core/src/thread_controller.rs)把该模型写入 ThreadCatalogRecord；现有 Core 测试 `session_catalog_uses_root_model_even_when_a_child_uses_a_different_model` 覆盖重开，但使用内存 store。
3. [SQLite append_batch / session_list_changed](crates/state/src/sqlite/thread.rs)总是更新 thread_catalog，但仅在 predicate 为真时更新 session_catalog；predicate 未比较 model 和 execution_target。仅模型变化可使目录滞后。
4. [Provider](src/ash/sessions/contrib/providers/agentHost/browser/appServerSessionsProvider.ts)的 `toSession` 忽略 DTO.model；`list` 再把全部 Session.model 覆盖为全局 `readModel` 结果，`readCatalog` 继续沿用旧 model。
5. [Management equality](src/ash/sessions/services/sessions/browser/sessionsManagementService.ts)的 `sameSession` 未比较 model 与 workspace。只修 provider 后，model-only 目录更新仍可能被当作无变化而丢弃。

上述失效条件现已由本批 Rust 和前端红测复现，并在相同回归中转绿；没有证据说明用户历史已丢失，修复针对目录事实滞后和前端选择映射。

### Todo 与路径边界

- [x] 在 `crates/state/src/sqlite_tests.rs` 添加先失败的 model-only catalog 更新回归：通过正常 append transaction 更新 root model，其他比较字段保持不变；同时检查 list、指定 catalog read、reopen 和 verified digest。
- [x] 在同一文件使用已存在的 `ash-core` dev dependency 增加 SQLite-backed Core migration 回归：root Turn 处于启动可保留的 user-input 等待态，实际 reopen/recover 后执行 provider identity migration，再检查历史模型、目录和 reopen 一致；不以直接 backfill 或内存 store 代替真实迁移链路。
- [x] 仅在 `crates/state/src/sqlite/thread.rs` 的目录失效 predicate 补齐 Session 导出事实所需 model/execution_target 比较。两项遗漏分别完成红绿回归，未重构 store 或更改现有格式版本。
- [x] 在 `src/ash/sessions/contrib/providers/agentHost/browser/appServerSessionsProvider.ts` 原地修复 model 映射与 list/readCatalog 优先级。持久化目录忠实读取 DTO.model，包括缺失值；全局默认仅在已知 create/draft 流程中选择，不能替换既有目录事实。保留 pane 的未发送手动选择和 Auto，不能用 catalog 更新覆盖它们。
- [x] 在 `src/ash/sessions/services/sessions/browser/sessionsManagementService.ts` 的现有 `sameSession` 补齐 model 与 workspace 事实比较，保持其他刷新、selection 和 subscription 算法不变；默认模型写入不再根据历史模型相等而跳过或改写所有 Session。
- [x] 在 `src/ash/sessions/services/sessions/test/browser/sessionsManagementService.test.ts` 覆盖两会话不同模型、config 默认不同、child 模型不同、重连、迟到旧目录与 model/workspace-only 变化。
- [ ] 使用现有 `src/ash/sessions/test/browser/chatViewPane.test.ts`、`chatViewPane.startup.test.ts` 和 Cowork 测试，验证真实创建入口到 picker/startTurn 的效果。已通过 Code/Cowork WidgetModel/DI/inputState/startTurn 与 startup 单测；真实 DOM 与 profile/pane 重开验收待 Mac。没有修改 pane 生产 owner。

主要 production 写入限于三个现有 owner：SQLite predicate、Session provider 和 Management equality。若现有 `setModel` 的全目录替换与上述事实分离冲突，先核对真实生产调用方，再决定局部变更，不能机械保留或删除旧 API。

Session.model 缺失仅表示目录没有模型事实，不能据此推断没有已接受 Turn 或用户选择了 Auto；例如 model-less shell Turn 同样可能没有值。显式 Auto 由现有 composer 选择标记表达，profile remembered/default 是新建流程偏好，两者不能写回或伪装成历史模型。不为判断缺失而额外加载整份历史。

### 验收

- root=A、child=B、全局默认=C 时，目录与重开 root 会话保留 A；打开 child 后使用其自身 B。
- model-only append 和启动模型迁移后，Thread/read、session/list 与 session/catalog/read 结果一致；完成历史、Thread sequence 和幂等规则不被修改。
- Catalog 更新期间的未发送手动模型与显式 Auto 不回退；旧 connection 的目录结果不能改写新 connection。
- 开启与关闭 Code/Cowork pane、重连和 profile reopen 均经过真实入口；没有第二份模型持久化 owner。
- `just verify ash-state`，现有 Core 根模型回归按需定向运行；上述 TS 定向单测、`pnpm typecheck:renderer`、受影响产品构建和 Web/Electron Playwright 完成。若无协议变化，不新增或手改生成类型。

## 第二批 接通模型目录更新

依赖第一批的模型事实与选择优先级固定。用户收益是账户或订阅模型列表变化能抵达已打开的选择器，失败不会意外替换当前可用快照。

初始缺口链路：`crates/subscriptions/src/lib.rs` 观察账户与发现 → `crates/app-server/src/server/subscription_adapter.rs` → `provider/models/updated` → generated decoder → `IServerEventApi`。基线 `LanguageModelsService` 仅处理 `provider/apiKey/changed`，遗漏此更新；本片现已原地消费，具体可证明范围和未闭环项见文首。

- [x] 在 `src/ash/workbench/contrib/chat/common/languageModels.ts` 原地消费该事件作为 invalidation，重读当前 `model/list` 和 provider 状态；不把某一个 subscription 的 payload 直接替换全局目录。
- [x] 将 connection generation、dispose、并发刷新与“刷新期间又有新通知”的责任闭合在该 service。旧 load 完成不得覆盖新连接目录；合并通知后仍至少完成一次涵盖最新失效的刷新。
- [x] 在 `src/ash/workbench/contrib/chat/test/common/languageModels.test.ts` 增加 Models、Empty、Failed、公开账户切换、连续通知、迟到结果、消费者赋值与零选择/配置写入回归；实际 picker 手选/Auto 验收仍属下一项。
- [x] 只读核对 `crates/app-server/src/server/subscription_adapter_tests.rs`、`crates/subscriptions/src/subscription_tests.rs` 和 `crates/models-manager/src/manager_tests.rs` 的既有 Models/Empty/Failed 语义。本片没有修改或重跑 Rust；确有目录身份缺口已单列后续契约方案，不能为凑跨端 diff 修改 Rust。subscription adapter 自身 Empty 覆盖的补齐随后续协议批次安排。
- [ ] 通过 Code/Cowork 的真实模型选择器验证目录、能力、thinking 选项和非默认语言。仅在确有缺口时登记相关 pane 路径。

**结果语义不可照搬上游：** Ash `ProviderModelsListResult` 明确区分成功 Models、成功 Empty 和 Failed。成功空发现会更新 backend 最新发现集；失败保留已有 metadata，认证/权限失败会降级可用性。账户、organization 或 plan 改变时旧结果由 subscription owner 丢弃。禁止统一忽略 Empty，也禁止保留上一个账户的可选模型。Frontend 以当前 backend 查询为权威。

验收：一次 provider update 能更新已打开选择器；相同结果不产生无意义变更；失败、空目录和账户切换的行为分别可解释；不会触发全局模型选择或写配置。涉及现有 wire fixture 时运行 `just verify ash-app-server-protocol` 与 generated-contract 检查；实际变动 package 再执行对应 `just verify`。

## 第三批 显示后台会话的被动管理状态

依赖目录读取、通知和 owner 保持成立。上游依据为 ac4cf28d。现有 Session catalog subscription 已在 committed Thread event 后发布 `session/changed`，但无需订阅全部历史。Ash 目前的每个 SessionThread 只暴露 Active/Archived 生命周期等元数据；`IChat.executionStatus` 无详情时沿用旧值或 idle，而且列表没有生产显示消费者。

**建议本批采用现有粗粒度管理状态。** `ThreadCatalogRecord.manager` 已由 Core 的 `thread_manager_info` 生成，能区分 Idle、NeedsInput、Working、ReadyForReview、Failed、Stopped 等管理事实。Working 合并 created/running/cancelling，NeedsInput 合并三类等待；它不是精确 TurnStatus。

- [ ] 确认产品选择：先显示现有管理事实，还是新增精确 latest-turn summary。推荐前者；后者另列下一节，未确认前不追加持久状态。
- [ ] `crates/protocol/src/session.rs` 为 SessionThread 暴露已有 manager；`crates/thread-store/src/store.rs` 的 `session_from_catalog` 透出同一事实。
- [ ] `crates/core/src/thread_controller.rs` 只调整现有目录构造所必需的投影，复用已存在的 `thread_manager_info`，不新增执行 reducer。`crates/app-server/src/server/operations.rs` 的 full Session 结果必须使用同源事实；只读核对 `session_operations.rs` 的被动路径。
- [ ] `crates/state/src/sqlite/thread.rs`、`crates/state/src/sqlite/connection.rs` 更新必要的 Session catalog 格式与迁移：从 verified ThreadCatalogRecord 重建，不能默认把旧行全部变 idle，不能为了列表读取重放每份历史。
- [ ] 从 Rust source 重新生成 TS、schema 和 decoder；核对 registry/export 与 fixtures，需要时才改 `crates/app-server-protocol` 的实际生成 owner。
- [ ] `src/ash/sessions/services/sessions/common/session.ts` 增加前端领域 management-state 契约，provider 做机械转换，management 保持更新与 equality 正确。不能伪造 `executionStatus=running` 或具体 waitingReason。
- [ ] `src/ash/sessions/browser/parts/sidebar/sessionsList.ts` 现有 row 显示本地化状态及 aria 描述；复用 Ash 自有 DOM、主题和尺寸，保留 row identity、焦点、滚动与 PR 图标。
- [ ] 在 `src/ash/sessions/test/browser/sessions-list.test.ts`、management 单测、Rust store/catalog/update broker 测试及现有 Sessions Web/Electron smoke 中验证后台切换。新文案同步所属 NLS 和语言词条，至少覆盖一种非默认语言。

验收：另一 connection 启动、等待输入、失败、完成或停止后，未打开详情的会话行会更新；subscriber 数量和 history-load 次数不因状态显示增加；选择、draft、焦点和滚动保留；重连后 retired connection 的活动事实不残留。

粗粒度方案只改变 Session cached-row 的格式版本与重建，不因为公开 DTO 增加 manager 就升级全部 Thread row 版本。当前 outer ThreadCatalogRecord.manager 已有权威事实；旧 nested SessionThread 新字段的默认值不能反向覆盖它。否则可能触发 Core 的 missing-catalog repair 并重放所有旧历史，破坏被动读取目标。

准确 Turn 状态的后续选项：在 catalog 保存最新 TurnId/TurnStatus，改变 Thread 与 Session catalog 版本并从 verified history 回建，生成新契约，再复用现有 executionStatus mapper。这是新协议/存储决定，当前还没有可直接复用的精确被动 primitive。不能把这一选项藏在粗粒度状态批次里。

## 第四批 验证恢复 权限 取消与历史

这是定向验证与缺陷驱动批次，不是预先授权整目录重写。前述前三批通过后，先复用已有覆盖，只有观察到差异才登记具体修改路径。

- [ ] 连接：验证 `appServerProtocolClient.ts`、MessagePort/WebSocket transport、`platform/native/electron-browser/rendererApi.ts` 和 Web renderer assembly 的旧 generation、inbound cancel、pending 关闭、重连及 auth terminal failure。Desktop 当前有三次恢复尝试，Web 使用退避恢复；不能未经产品决定统一策略。
- [ ] 多窗口：关闭一个 Renderer 只清理自己的 pending/resources/subscriptions，另一窗口与共享后台继续工作；process exit 使所有连接失效。Main 不新增 JSON-RPC 分类或业务 pending map。
- [ ] 恢复：catalog-only、已加载后台 details、当前 Thread transcript 和草稿分别恢复；uncertain mutation 不自动重放。现有 `sessionsManagementService.test.ts` 与 `agentHost/test/browser/webRendererApi.test.ts` 已覆盖多种迟到/恢复场景，先运行它们。
- [ ] 权限：沿 Core frozen policy、UpdateBroker interaction capability 与对应 connection owner 验证允许/拒绝/过期/断线。保留现有 approval/user-input 向同 scope、能力匹配且已订阅 connection 重新分配的语义；旧 owner 不能答复新 assignment。dynamic-tool interaction 不重新分配，owner 丢失时取消。不能把 catalog 订阅当成交互授权，不能转交任意窗口；普通 JSON-RPC host request 继续绑定来源 connection。
- [ ] 取消：从实际 Stop/interrupt 按钮到 `ITurnApi` 和 Rust 终态验证 completion race、重复 interrupt、待审批取消；保留 expectedSequence 和 commandId 规则。通用 JSON-RPC Promise cancel 不替代 domain interrupt。
- [ ] 历史与工具：核对现有 snapshot/transcript revision、fork、模型/工具输入和 disabled MCP 恢复。历史编辑/rollback、标题自动生成、bulk questions、Mission Control 或 remote credential delegation 若无 Ash 真实消费者，保持待调查，不创建占位 API。

每个新增实现的验收都必须给出用户入口、唯一 owner、状态/副作用、释放边界与真实测试。现有测试名称或源码审阅不能当成测试已通过。

## 与正在进行工作的边界

| 工作                          | 本计划的交集与处理                                                                                                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Trace / Sessions / Core trace | 第一批不改 `core` 执行与 trace recorder；第三批如触及 `thread_controller.rs`，必须与 Trace 任务对照 exact diff、串行集成。`sessionApi.ts` 同时承载 trace API，默认只读，禁止整体整理 |
| SCM 与 Git 协议               | 初始模型修复无需 `git/*` 或 turnChanges；第三批生成 shared protocol 时只在双方变更合并后统一生成/验证，不能覆盖另一任务 schema fixture                                               |
| Preferences 输入迁移          | 不改 keybinding/input/settings editor；模型默认值、visibility 和 pane 临时选择保持既有 owner。模型服务路径变更必须核对相关配置任务的实际 diff                                        |
| Notifications 菜单            | 不改 contextmenu、toast 或全局 action failure 路径；新状态文案只放所属 Sessions 行                                                                                                   |
| Search 生命周期               | 不改 search controller、cancel handle 或 session file/search provider；generic connection 测试不代表 Search 可重新执行                                                               |
| Output                        | 不改 output filter/autoscroll；诊断只说明已测失败，不引入另一份日志状态或新 output owner                                                                                             |

云端只能确认 main 已提交内容，无法判断这些任务尚未集成的本地冲突。执行者开始每批前读取真实工作树并保护已有变化；中途发现新路径时重新确认边界。

## 环境与验证安排

初始审计环境为 Linux，约 9.8 GiB 总内存、30 GiB 可用磁盘，缺少 Rust/Just/前端依赖。按后续授权现已在 task-local 路径固定 Rust 1.98.0、Node 24.21.0、pnpm 12.8.0、Just 1.46.0，并使用仓库 hashed Python venv、冻结 JS lock 和 Rust generator。Cargo 仅使用 2 jobs、单个 package 验证；未修改全局工具配置或启动 workspace/V8 构建。第一批结束时约 22 GiB 磁盘与 7 GiB 内存可用；第二批复用依赖/生成物，结束时云端约 12 GiB 磁盘可用。保留正常缓存，不主动清理。第二批未占用 Cargo build/verify 进程或共享可写 target。

- 文档可在云端立即校对路径、链接、Markdown 和 whitespace；这些检查不验证产品行为。
- 第一批不改 wire schema，但 TS 测试仍需要有效生成物；可复用与源码指纹匹配的 backend package contract，否则需要 Rust generator，不能手写 `.build/protocol` 来绕过。
- 按仓库脚本准备工具链后串行运行 `just verify ash-state` 和定向前端测试。Rust 初次冷构建先评估依赖图、V8/其他资源与磁盘，限制并发；不直接启动全 workspace build。
- 第三批需 `just generate-protocol`、`just verify ash-protocol`、`just verify ash-app-server-protocol`、受影响 `ash-state`/`ash-core`/`ash-app-server` 检查、`pnpm typecheck:protocol` 和 renderer/build 验证。依据实际变动范围缩小 package，不并行争抢同一 Cargo cache。
- Web 和 Linux Electron 的真实协议/UI行为在相应环境可验证；macOS 的真实系统菜单、OS sleep/wake 和 macOS daemon/窗口边界需在连接的 Mac 上验证。云端 Linux 通过不能标记为 macOS 通过。
- 方案、第一/第二批独立源码补丁和验证证据在云端交付。本地先保存第一批 checkpoint，再按完整补丁与 todo 消费第二批，统一完成 Mac 运行时验收；其余批次和新增身份契约仍需确认。不私自提交、push、开 PR 或修改公共规则。

## 非目标与后续规范建议

本次不引入 VS Code Node/Copilot SDK runtime、AHP action/state/replay 协议、Mission Control，不用上游私有类图重写 Rust；不按文件数补空模块，不扩展 credentials、权限、部署或共享访问；不把 Project/Workspace/Environment/Session/Thread/connection 合并为一个身份。

通用流程建议落在现有 `.github/copilot-instructions.md` 的 Development workflow，与普通任务流程相邻，而不是放进仅适用于 `/develop` 的四产物文档或对齐 skill 的私有结构说明。建议文字：

> 模块对齐先在云端核对现有能力、公开契约、真实调用链、唯一 owner 和近期上游行为，形成根目录 `<module>-todo.md`，写清基线、分批路径、依赖、产品验收与未决定事项；用户确认方案后，在指定本地 checkout 按批准批次实施并记录实际验证。云端审计不替代本地差异检查，不自动授权提交或推送。

此段仅是建议，尚未写入公共指导文件。若本地已有本次流程或模板，合并为一条规则并保持其既有例外，不重复扩张为四份阶段产物。
