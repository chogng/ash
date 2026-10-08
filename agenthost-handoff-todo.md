# AgentHost 接手与后续 TODO

当前由本聊天接手。用户在 2026-10-08 授权把 agenthost 原五个提交整合到 main，并由我们继续负责；下方旧快照中的停工、禁止提交和发布许可安排是接手前历史，不再代表当前授权。

## 本批代码

- 保留 `64b456ad0`、`77e38dcb9`、`6b4921a7c`、`1b216a571`、`388e4276f` 五个已有提交，范围涵盖 B1–B3 与真实 host 回归。
- 首次账号范围修复单独提交：模型服务必需注入现有账号服务，接受首批目录前读取权威快照；同账号和无关账号重读失败保留有效目录，换账号立即退役旧目录，旧快照及失败不回流新 connection。
- Sessions 在创建模型服务前注册账号服务；对应 fixture 使用真实账号适配器，新增缺失必需服务的创建阶段回归。
- 原红测重新执行：38 项中 31 通过、7 失败。修复后的模型测试 39 项全通过；补齐 Chat fixture 的账号读取后，pane 测试 83 项全通过。完整集成验证结果见下节。

## 当前验证

本批九个验证步骤全部通过，精确命令、退出码及日志哈希记录于 `.build/agenthost-evidence/main-integration-20261008/validation.json`。

- 199 项单元测试（8 文件，含账号范围、Sessions、picker 和分层）与 5 项 runner 回归。
- renderer、generated protocol 和 automation 类型检查；正常完整 Web 与桌面构建，无新增构建 warning。
- 53 项 Chromium 集成；真实 App Server-backed Web 与 Mac Electron 会话模型持久化、Code/Cowork 和 profile 重开各 1 项通过。
- Playwright 仍打印已有 NO_COLOR/FORCE_COLOR 环境 warning。本批未重跑五分钟 B2 观察周期或 Windows/Linux CI。

旧五提交的六个 Rust owner verify、TUI 调用方编译与中英文 B3 验证保留在原证据目录；已核对完整验收 JSON 的 SHA256 `3fade43ffe923a2a49d7ba9f1b6f5376cc489043734ce7567b2b4515b5f84d7d` 和五提交 rebase 等价证明。本批没有改动 Rust 或公共协议；真实 UI 入口按源码契约自动选择/准备 runtime package。

## 我们接着负责的工作

1. Kimi subscription 同公开身份重新登录：先确认 backend catalog/subscription/runtime 的身份范围契约，区分新设备登录与 token 轮换；现有公开 `accountId=current` 不足以证明范围相同。
2. External `kimi-desktop` / `kimi-cli` 的凭证范围与权威目录读取：明确失败时目录保留、退役与重试语义。原引用的 epoch 提案尚未交付，不视为已经批准的实现方案。
3. 复用原第四批恢复、权限、取消、多窗口和历史覆盖，按真实失败推进；真实 OS sleep/wake、禁用 MCP 恢复、外部账号与 Windows/Linux CI 仍需对应环境证据。
4. 隔离 UI 记录中的麦克风枚举失败与 `TerminalOperationFailed` 先定位 owner，再决定是否属于本模块，不扩大本批修复。

以下保留原交接快照及验证历史，以便追溯旧 SHA、失败与证据；其中未完成状态以本页当前部分为准。

## 原交接快照（接手前）

**当前停工；B2 首次账号范围缺失仍是发布阻断。** 原五个提交保留，生产修复尚未开始。用户要求本轮只写交接文档，接手人按下列步骤继续；本任务不继续开发、不提交、不 push。

本文件是当前交接入口。[agenthost-todo.md](agenthost-todo.md) 保留完整云端方案，不重写其正文；`.build` 内旧交接记录与验收清单仅作历史证据。

## 位置与版本

- 状态日期：2026-10-08，America/Los_Angeles；快照时间 06:44 PDT / 13:44 UTC。
- Worktree：`/Volumes/1t/ash-agenthost-20261008`。
- Branch：`codex/agenthost-session-facts-20261008`。
- HEAD：`388e4276fc4d589c9ac6b8e032b9398f152472ce`。
- Base / 最近 fetch 观察到的 origin/main：`1a49304ba4e03f4f08ccf67d8e93a3dd40bfcb8d`；本轮交接未重新联网确认远端。
- 本模块已入 main 的 SHA：**无**。本树相对所记录 origin/main 为落后 0、领先 5；原脏主树 `/Volumes/1t/ash` 未操作。

五个已提交、未推送的提交，依次为：

```text
64b456ad0192bf7fa86bdea715ecbbc703eae327 B1 持久会话事实
77e38dcb9704155dcf16e5b8d7bdd58754c7a0b8 B2 模型目录生命周期
6b4921a7c3d6978e1f8c2c0764ec2ad96f29b6fa 真实 host 验收
1b216a5713a75d2c5ac4d3f5cb0a36ee065cf07a picker 焦点
388e4276fc4d589c9ac6b8e032b9398f152472ce B3 分支管理状态
```

## 当前内容与缺口

- 已实现 B1：SQLite model/execution_target 变化刷新会话目录；provider 使用持久模型；model/workspace 相等性传播更新，缺失模型保持未知。
- 已实现 B2 的目录重读、合并通知和过期完成隔离，但首个权威账号快照缺失，不能标为完成。
- 已实现 picker 说明消失/模型移除时的焦点保持，以及 B3 管理事实、SQLite 缓存迁移、中英文列表/分支历史。
- 未提交代码：`src/ash/workbench/contrib/chat/test/common/languageModels.test.ts`，增加账号服务 fixture 和 8 个回归；当前差异 118 行新增、9 行删除。生产代码未修改。
- 本交接文件 `agenthost-handoff-todo.md` 也未提交。五提交的 51 个未推送路径见末尾；19 个生产文件原补丁已完整交给云审，不需重复传输。
- 首次账号快照修复、绿色回归、修复后的构建/UI、独立修复提交、复审及集成都未完成。

## 已知问题与复现

热 daemon / 重连可以先加载模型目录，却没有收到任何账号通知。此时 `languageModels.ts` 的 `accountScope` 仍为 undefined；首个同账号凭据刷新、登录完成或无关 GitHub 账号通知会误退役目录。权威目录重读临时失败后，原有模型变为 `[]` 并保持。initialize 不提供账号快照，通知不重放，不能依赖初始通知到达，也不能简单忽略首次事件。

在本树运行：

```sh
pnpm test:unit --run src/ash/workbench/contrib/chat/test/common/languageModels.test.ts
```

最近实际结果：**31 passing / 7 failing，退出码 1**；5 个 runner 回归通过。失败覆盖首次同账号 updated/login、首次无关账号通知、初始快照与换账号竞态、重连旧快照完成/失败、首次账号读取失败。新测试已成功编译；失败是预期红测，不是修复完成。

范围外已记录：隔离 Electron 麦克风枚举失败；重开 Code 详情出现 `TerminalOperationFailed`，尚未修复或确认来源。源方案引用的 `agenthost-catalog-epoch-plan.md` 尚未交付，不编造正文。

## 验证事实

| 验证阶段                                    | 实际结果与限制                                                                                                                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 完整验收，base `092ed761` / HEAD `d0d14eb7` | 22 步全部通过：6 Rust owner 的 check/test/rust-warnings，244 Mocha + 5 runner，53 Chromium 集成，生成/类型/正常构建/两种运行时握手，真实 Web/Electron 各 4 个 B1–B3 用例，TUI 调用方仅编译 |
| 原周期 B2 UI                                | 原 300 秒观察周期；更新至非法响应间隔 Web 300.078s、Electron 300.085s；仅合成账号和本机 loopback；不是本次缺口修复后的验收                                                                 |
| Rebase 到 `1a49304`                         | 原五提交 range-diff 全为 `=`；19 文件补丁字节相同，58,263 bytes，SHA256 `4bef1efb66ace86da820c46bc8fbd58150a9baa44c72836c6c28986a5f160976`                                                 |
| 新基线快速复核                              | 8 步通过：244 Mocha + 5 runner，53 Chromium 集成，renderer/protocol/automation 类型检查，正常 Web/桌面构建，2 个 Bazel 注册测试；Rust/runtime 构建输入没变，未重编后端                     |
| 当前新增红测                                | 38 Mocha 中 31 通过、7 失败；5 runner 通过；生产修复和绿色复核未运行                                                                                                                       |
| 未验证                                      | Linux/Windows CI、真实外部账号变化、私有 credential epoch/Kimi 契约、禁用 MCP 恢复、真实 OS 睡眠恢复、TUI 行为测试                                                                         |

旧 UI 有 21 段已哈希录屏及 42 个成功解码帧；B3 四个客户端/语言组合均为 0 个未打开后台会话详情请求。SQLite model-only/workspace-only 是 owner 回归覆盖；实际 UI 使用真实通知和重开路径。

## 接手步骤

以下均未完成，当前任务不会执行。

1. **修复 owner**：编辑 `src/ash/workbench/contrib/chat/common/languageModels.ts`。通过现有 `IAccountService` 取得首个权威快照，接受目录前建立同 catalog generation、connection generation、revision 的账号范围。账号事件走现有账号服务；真实换账号立即退役旧模型。迟到快照、迟到失败均不能覆盖新账号；初次快照失败不得发布无范围目录，后续能重试。
2. **同步装配与测试**：在 `src/ash/sessions/browser/workbench.ts` 将账号服务注册提前到模型服务创建前；常规 Workbench 已先注册账号服务。同步 `src/ash/sessions/test/browser/chatViewPane.test.ts` 与当前 `languageModels.test.ts` 的必需服务 fixture，并补缺失依赖在创建时失败的覆盖。不要使用可选依赖兜底。当前 38 个模型测试应全部通过，新增装配测试也必须通过。
3. **跑 focused**：`pnpm test:unit --run src/ash/workbench/contrib/chat/test/common/languageModels.test.ts --run src/ash/sessions/test/browser/chatViewPane.test.ts --run src/ash/workbench/services/accounts/test/browser/gitHubConnectionService.test.ts`。要求首次同账号/无关账号重读失败保留原数组，首次真正换账号清空旧范围，初始快照/重连竞态不回流旧模型。
4. **类型、正常构建和 UI**：运行 `pnpm run typecheck:renderer`、`pnpm run build:web:full`、`pnpm run build`、`pnpm run valid-layers-check`；运行 `pnpm test:browser:integration chatInput.integration.spec.ts sessionGitHub.integration.spec.ts --reporter=line --max-failures=1`。再分别运行 `pnpm run test:smoke:browser:full:no-compile` / `pnpm run smoketest-no-compile`，参数为 `test/smoke/areas/sessions/session-models.spec.ts --grep 'Persisted root and child models'`。确认 Code/Cowork 真实启动、账号服务注册和模型重开通过。仅在新证据要求时重复 300 秒 B2 长测；不机械重跑整个 Rust/后端。
5. **复审与集成**：保持原五提交，修复另作一提交；使用 `.github/pull_request_template.md` 的 Why / What changed / Testing。提交前检查 `git diff --check`，给父任务精确修复补丁、SHA、真实验证结果，取得云审结论和串行发布许可后再集成；当前禁止 push。

## 依赖、进程与证据

- 截止快照，本树没有在跑的 Rust、app-server、Electron、Playwright 或 unit-test 验收进程。红测 runner PID 2850 已结束，`red.exit=1`；没有启动 green/build 组。
- Core trace、SCM Git protocol、Preferences 输入迁移等其他 owner 的工作不得顺改。坚持本树 Cargo/runtime/protocol；真实外部账号不操作。
- 完整旧验收：`.build/agenthost-evidence/current-acceptance-20261008/acceptance.json`；截图、录屏、运行时哈希和命令日志同目录。
- 新基线证明：`.build/agenthost-evidence/rebase-1a49304-20261008/rebase-proof.json`、`quick-acceptance.json`。
- 当前红测：`.build/agenthost-evidence/account-scope-fix-20261008/scope-red.log`、`scope-red.json`、`red.exit`。
- 原 Library 上传失败/helper 请求证据保留在 `.build/agenthost-evidence/rebase-20261008/review/`。截图传输不能阻塞代码接手，不声称已上传成功。
- `/tmp/agenthost-scope-run.py` 只是已有命令的日志 wrapper；优先使用文中 pnpm 命令。**不要重跑 `/tmp/agenthost-scope-red.py`**，它会重复追加测试。

## 五提交的未推送路径（51 个）

可复核：`git diff --name-only 1a49304ba4e03f4f08ccf67d8e93a3dd40bfcb8d HEAD`。

```text
agenthost-todo.md
crates/app-server/README.md
crates/app-server/src/server/agent_session_tests.rs
crates/app-server/src/server/operations.rs
crates/core/src/thread_controller.rs
crates/core/src/thread_controller_tests.rs
crates/protocol/README.md
crates/protocol/src/contract_tests.rs
crates/protocol/src/session.rs
crates/state/README.md
crates/state/src/sqlite/connection.rs
crates/state/src/sqlite/thread.rs
crates/state/src/sqlite_tests.rs
crates/thread-store/README.md
crates/thread-store/src/store.rs
crates/thread-store/src/store_tests.rs
crates/tui/src/app/fullscreen/frame_tests.rs
crates/tui/src/app/fullscreen/pointer_tests.rs
crates/tui/src/app/mode_tests.rs
crates/tui/src/app/session_manager_tests.rs
crates/tui/src/sessions/details_tests.rs
crates/tui/src/sessions/picker_tests.rs
crates/tui/src/sessions/state_tests.rs
crates/tui/src/thread/agent_switcher_tests.rs
docs/ash-app-server-api.md
localization/en/sessions.json
localization/zh-CN/sessions.json
src/ash/sessions/README.md
src/ash/sessions/browser/actions/chatActions.ts
src/ash/sessions/browser/actions/sessionsChatActions.ts
src/ash/sessions/browser/parts/sidebar/media/sessionsList.css
src/ash/sessions/browser/parts/sidebar/sessionsList.ts
src/ash/sessions/browser/sessionManagementLabels.ts
src/ash/sessions/contrib/chat/browser/sessionsChatAccessibilityHelp.ts
src/ash/sessions/contrib/providers/agentHost/browser/appServerSessionsProvider.ts
src/ash/sessions/services/sessions/browser/sessionsManagementService.ts
src/ash/sessions/services/sessions/common/session.ts
src/ash/sessions/services/sessions/test/browser/sessionsManagementService.test.ts
src/ash/sessions/test/browser/chatViewPane.test.ts
src/ash/sessions/test/browser/sessions-actions.test.ts
src/ash/sessions/test/browser/sessions-list.test.ts
src/ash/workbench/contrib/chat/browser/widget/input/modelPicker/modelPickerWidget.ts
src/ash/workbench/contrib/chat/common/languageModels.ts
src/ash/workbench/contrib/chat/test/common/languageModels.test.ts
test/automation/playwrightWeb.ts
test/automation/test.ts
test/integration/browser/chatInput.integration.spec.ts
test/integration/browser/chatInput.integration.ts
test/smoke/areas/sessions/session-models.spec.ts
test/smoke/areas/sessions/session-states.spec.ts
test/smoke/areas/sessions/sessionProfileFixture.ts
```

## 代理文档核对补记（2026-10-08 13:55 UTC）

父任务请求代写时，本文件已由原 owner 写好。本次保留以上完整交接原文，仅补充只读核对结果；不再次创建同模块 TODO。

- 实际 branch 为 `codex/agenthost-session-facts-20261008`，HEAD `388e4276fc4d589c9ac6b8e032b9398f152472ce`，本树缓存 `origin/main` 为 `1a49304ba4e03f4f08ccf67d8e93a3dd40bfcb8d`。未 fetch、未 rebase、未推送。
- `origin/main..HEAD` 为上文列出的 5 个本地提交：`64b456ad0192bf7fa86bdea715ecbbc703eae327`、`77e38dcb9704155dcf16e5b8d7bdd58754c7a0b8`、`6b4921a7c3d6978e1f8c2c0764ec2ad96f29b6fa`、`1b216a5713a75d2c5ac4d3f5cb0a36ee065cf07a`、`388e4276fc4d589c9ac6b8e032b9398f152472ce`。旧 `d0d14eb7` 是历史 checkpoint，当前 HEAD 以上述读取为准；本次未验证远端 main 是否包含这些提交。
- 写入前只有 ` M src/ash/workbench/contrib/chat/test/common/languageModels.test.ts` 与 `?? agenthost-handoff-todo.md`。生产源码没有未提交变更；该测试文件 SHA256 `764428e7f35e2cbefc313d2bce3a074d2649dac1fc2b31197602da89ef278adc` 在本次文档写入前后保持一致。
- 首次 accountScope 初始化缺失的 P2 仍未修复；原 owner 最新记录为 38 项测试中 31 通过、7 失败，runner 5 通过。以上是已有证据，本次没有重跑，不据旧验收推断当前修复已完成或已入 main。
- 当前仍按用户要求停止工程工作。本次只写 Markdown；未应用生产修复、运行测试/构建/UI、提交/推送、清理工作树或停止其他任务进程。

## 原 owner 文档收尾核对（2026-10-08，America/Los_Angeles）

- 保留代理任务补记和原测试改动；未继续生产修复、测试、构建、提交或推送。
- 本文件已格式化，授权上下文中的 `pnpm exec prettier --check agenthost-handoff-todo.md` 成功；`git diff --check` 成功；原 `agenthost-todo.md` SHA256 仍为 `5839d82fa75559264c699de84e7166281b50c7eaaf17ea72c01c18d7e1e46638`。
- 首次受限上下文的格式检查失败于 `ERR_PNPM_PNPM_ENGINE_IDENTITY_UNVERIFIABLE`（注册表身份核验网络失败）；该检查进程已自行退出，后续授权上下文检查成功。未停止其他任务进程。
