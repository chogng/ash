# Tasks 配置执行语义对齐

基线：`dd086508`。本批先堵住把配置静默降级为默认 shell 执行的路径；这不是完整 Tasks 能力完成。独立云端 checkout，不 push，不修改共享 Terminal/exec-server 契约。

## 当前能力与实际差异

- 已有：工作区显式 task catalog、多根目录身份、package scripts、Cargo 常规任务、动态 `TaskProvider`、集成 Terminal 输出/取消/退出状态。
- 缺陷：`parseWorkspaceTasks` 只保留 label/command/args/group；`options.cwd/env/shell`、依赖、matcher、background、运行策略、平台覆盖被静默丢弃；`process` 被作为 shell 文本执行。
- VS Code 的 [Tasks schema](https://code.visualstudio.com/docs/reference/tasks-appendix) 区分 shell/process，定义 cwd/env/shell、background、problemMatcher、runOptions 和平台覆盖；扩展能贡献配置字段，不能把所有未知字段判错。[Tasks 文档](https://code.visualstudio.com/docs/debugtest/tasks) 还覆盖依赖任务和后台 readiness。
- Ash 当前只可靠提供 server-authorized workspace directory 中的交互 shell，不能承诺 VS Code 的直接 argv 进程或 spawn 时 cwd/env。

## 真实 PTY 合同与 owner

- `workbench/contrib/terminal/browser/terminal.ts`: create 参数仅 dirId、dimensions、profile（另有输出型 custom PTY，不是任务进程 runner）。
- `platform/terminal/common/terminal.ts`: process create 仅 dirId、rows、cols、profile。
- `app-server-protocol/src/protocol/terminal.rs`: `TerminalCreateParams` 与 `TerminalCreateInSessionDirectoryParams`；后者要求 Session 授权目录，不能充当任意 Tasks cwd 绕路。
- `exec-server-protocol/src/terminal.rs`: `TerminalCreateRequest` 仅 rows、cols、profile、lifecycle。
- `exec-server/src/terminal.rs` 按授权的 dir_root，启动已发现 shell profile 的 program + launch_args，继承过滤后的安全 environment。
- 不通过 `cd`/`export` 字符串冒充 spawn cwd/env，不通过 shell quoting 冒充 process argv。共享 owner 下一批扩展 spawn 合同、授权校验、取消/退出状态及两种连接 lifecycle，再从 Tasks 接入。

## 本批闭环

- [x] 解析保存原始配置和未知元数据，显式标注已知但未支持的执行字段；不能整体抹掉合法 sibling 或动态 provider。
- [x] unsupported 任务仍可发现；运行前给出 localized 明确错误，零 Terminal 创建、零 sendText、零 run 状态。
- [x] 全局继承配置也进入能力判断，空依赖/matcher、false background 等 no-op 不过度拒绝。
- [x] 文件修改后刷新；旧配置不可越过新校验，修正后重试执行。
- [x] 单测先红后绿，覆盖 provider、未知 metadata、参数危险字符、已知 unsupported、重试与中文错误。
- [x] 更新 README 与 Web/Electron Playwright 用例；真实 UI 由 Mac 消费并验证，本云端不把编译/单测当真实 UI 通过。

## 后续完整实现（尚未实施）

- [ ] Terminal/exec-server owner：真正的 process executable + argv、task-specific spawn cwd、env override/removal，保持服务器目录授权和过滤策略。
- [ ] Tasks：依赖图/循环错误/sequence 与 parallel；取消与失败传播。
- [ ] Tasks + Problems owner：problem matcher 诊断发布、owner 清理、background readiness 与依赖完成语义。
- [ ] Tasks：inputs/config/env/command 等变量、平台覆盖、provider type resolution、runOptions、默认 build/test、presentation/reuse。
- [ ] 修复并按实际 shell profile验证完整 shell quoting；不得把未支持引号模式或变量当字面/默认 shell 语义执行。
- [x] 本机真实 Web/Electron：unsupported 不写执行计数/不启动进程，修正后运行一次，rerun、cancel。
- [ ] 本机真实 Web/Electron：非零退出与其他 shell profile 行为。

## 验证记录

工具链复用当前云端已有 Node 24 与 pnpm 12.8.0，独立 checkout 使用只读依赖链接与已有协议产物，不运行 Cargo，也不修改协议生成文件。

- `pnpm exec tsc -p tsconfig.test.json`：通过全测试 TypeScript 编译。
- `node test/unit/run.ts --run src/ash/workbench/services/tasks/test/common/workspaceTasks.test.ts --run src/ash/workbench/services/tasks/test/browser/taskService.test.ts`：22 个测试通过，涵盖未知 metadata、provider 省略 label、2.0.0 版本、unsupported 零 Terminal/进程、修正重试、中文与配置刷新竞争。
- `node test/unit/run.ts --run src/ash/workbench/contrib/terminal/test/browser/terminalService.test.ts`：43 个测试通过。
- `pnpm exec tsc -p tsconfig.renderer.json`：通过最终 Renderer TypeScript 编译。
- `pnpm exec tsc -p test/automation/tsconfig.json --noEmit`：通过 smoke TypeScript 编译。
- `pnpm exec vite build --config build/desktop/vite/vite.config.ts --mode web`：通过实际 Web 生产构建；仅 Vite 既有 plugin timings 诊断，未出现本改动新增编译 warning。这里调用同一产品 Vite 配置，避开 `build:web` 前置的 Cargo/protocol generate。
- `pnpm run format:ts ...`、`node build/resources/localization.ts --check`、`git diff --check`：通过；zh-CN 缺项 0，测试实际验证中文错误。
- 基线 parser 已出现回归红灯：provider 类型使整组解析抛错、继承 cwd/linux/危险 args 被静默丢弃。最终同一组能力回归在 `dd086508` 原模块上重放红灯，再恢复最终模块验证绿灯。
- 实际 Web/Electron Playwright Tasks 场景尚未运行，等待 Mac 消费。本云端的 smoke 编译、服务测试、生产构建不能证明本机 UI 行为通过。

新增 UI 用例检查 options 和 process 配置不能写执行计数文件，Tasks status 与命令 notification 都明确显示错误；修正配置后只执行一次，并清除旧错误。

## Mac 独立消费与首轮轻量验收（2026-10-08 UTC）

- 独立 worktree：`/Volumes/1t/ash-tasks-20261008`，分支 `codex/tasks-capability-guard-20261008`，基线完整 SHA `dd086508b8c0eabe5931793302e8f7dc3d7a47b3`。未修改原始 checkout 的源文件，未 push。
- 消费原件 `/tmp/ash-tasks-evidence-20261008/original.patch`：43085 bytes，SHA256 `1490796d603508568aa34a2364c889096bf1ccb29ef65ce8643da75f5a645eec`。12 个目标 Git blob 全部匹配，临时 index apply-check 通过。原件与本机增量分开保存。
- Node `24.21.0`；固定 pnpm `12.8.0` 经 registry 身份校验后确认。先前 sandbox 网络受限时返回的 12.4.2 fallback 未用于安装或验证。
- 本树拥有与基线锁文件一致的独立 compiler/Mocha/jsdom/xterm 测试依赖副本；无跨树 node_modules 链接，无 Cargo、runtime、protocol 或生成结果复用。完整依赖安装仍待准备窗口。
- 原补丁 parser 7 项通过；新增缺少/空 shell command 被 args 当命令执行的回归，原补丁 1 红，本机修正后 8 绿。实际 parser TypeScript 检查通过。
- 新增真实 `TasksViewPane` + DI 创建入口回归，原补丁保留旧错误而失败（0 绿/1 红），修正 catalog 更新处理后 1 绿。组件 TypeScript 检查通过。
- 本机增量：拒绝 args 为缺失 shell command 提供可执行命令；catalog 更新清除旧执行错误；双语 smoke 检查 Terminal 数量不变、零计数、外部修正先清旧错误、修正后成功退出且只执行一次。
- `format.ts --check` 与 `git diff --check` 通过。正常 NLS 校验实际执行后因本树缺少 `.build/protocol/typescript/ApprovalModes.ts` 失败；未伪造协议产物。
- Web/Electron Playwright `--list` 也实际尝试，均因本树缺少 `.build/protocol/typescript/index.js` 而失败，0 个测试不得视为通过。
- Mac 的 Tasks service/Terminal suite、全测试/renderer/smoke 类型检查、Web/Electron 正常构建及真实 Playwright 均未完成。云端的 22+43 不作为 Mac 通过数。
- 阻塞：按委派要求等待重型 Cargo/protocol/runtime 准备和前台 UI 窗口。协调消息多次因 `Transport closed` 未送达，异步窗口问题已提交；未擅自启动重型准备、前台 UI 或终止其他任务。

## Mac 协议及前端准备验收（后续窗口已放行）

本轮只放行本树 `protocol:generate` 与前端准备。完整后端仍由 Trace 占用，真实 UI 队列仍为 SCM 后 Search/AgentHost；未启动这两类任务，未 push。

- `CARGO_BUILD_JOBS=2`，`CARGO_TARGET_DIR=/Volumes/1t/ash-tasks-20261008/.build/cargo`；Python 使用已安装基础解释器 3.14.2。本树冷编译 `generate_protocol` 成功，全部 31 个源码目录指纹来自本树。协议 major 7；schema hash `sha256:d0855515d162555ff96db2eff76aeb9a8c9c137cde5a62c10b15c9d1579b1e86`。未复制他树 Cargo、runtime 或 protocol。
- `pnpm install --frozen-lockfile --offline`：通过，pnpm 12.8.0，完整独立工作区依赖。仅包存储无法跨卷 hardlink 的环境提示，pnpm 自动选择 `/Volumes/1t/.pnpm-store/v11`；锁文件未变。
- 正常 `pnpm run localization:generate`、`pnpm run localization:check`：通过，zh-CN 缺项 0。28 项与源文相同是已有 NLS 统计，不涉及新增 Tasks 错误词条。
- 正常 `pnpm run test:unit` 精确选择 workspaceTasks、TaskService、TasksViewPane、TerminalService：通过全测试 TS 编译、公共类型检查和资源前置，测试 runner 自身 5 项通过；Mocha 执行 Tasks 24 + Terminal 43 = 67 项，0 失败文件。
- `pnpm run typecheck:renderer`、`pnpm exec tsc -p test/automation/tsconfig.json`：通过；最终 smoke 断言增强后重跑 automation 类型检查通过。
- `pnpm exec playwright test test/smoke/areas/tasks/tasks.spec.ts --project=browser-app-server --list`（`ASH_PLAYWRIGHT_SERVER=full`）与 Electron 对应项目：各枚举 4 项，其中 en/zh-CN unsupported 场景各 1 项。仅枚举，未运行真实窗口。
- 正常 `pnpm run build:web`、`pnpm run build:renderer`：通过。产物分别在本树 `.build/desktop/web/ash` 和 `.build/desktop/renderer/ash`，后者包含 Electron Workbench/Sessions 入口。两个构建日志均无 warning。本轮未构建 Electron Main/Preload 或组装完整 Desktop 后端。
- 已补强 smoke：options/process 的命令入口和面板入口都断言 Terminal 数量不变、计数仍为 0；process 在面板产生错误后，外部修正先清除旧错误，再只执行一次并成功退出。
- 证据：`/tmp/ash-tasks-evidence-20261008/verification.json` 与同目录日志、原件、本机增量和最终补丁。唯一后续验收门槛是本树完整后端准备及真实 Web/Electron UI 窗口，不把这次编译、单测、构建或枚举当作真实 UI 通过。

## Mac 主线同步与后端/无界面 Web 验收（并行放行后）

- 用户已取消整个任务必须占用单一 UI 窗口的安排；本轮允许独立后端准备和不使用系统焦点/剪贴板的 headless Web。Electron 全局资源隔离仍待核对；未 push。
- 保全前轮补丁/证据后创建本地提交，正常 fetch/rebase 到 `origin/main` 的 `e05e17e93c26f0281357ff9aca53bea8aaf98a67`；本树功能提交为 `54b8e544a5c5ecc3ca1690329e51be44b325d169`。未修改原始脏 checkout 的源文件。
- `CARGO_BUILD_JOBS=2`；Cargo 输出、Cargo 依赖源副本、Go build/module 和 pip 缓存均位于本树 `.build`，V8/media 等锁定缓存由本树 `third_party/.cache` owner 管理。未复用他树 Cargo/runtime/protocol 产物。开始及过程资源检查均无 swap、内存/磁盘压力。
- 最新主线上再次正常执行 targeted `test:unit`：Tasks 24 + Terminal 43 = 67 项通过，完整测试 TS 编译及公共前置通过。Renderer 类型检查、automation 类型检查、`build:web:full`、`build:renderer`、NLS 校验通过。修改的 9 个 TS 文件格式检查通过；JSON/Markdown 检查发现新增 todo 格式问题并按本树 Prettier 配置修正。
- 后端准备经历 exec-server transport 中断；先检查原 PID 和日志，确认原进程已退出且无结果后恢复同一本树命令。恢复后的进程拥有独立 session、PID 记录和持久退出码；后续只读探针恢复时先确认该进程仍在运行，没有重复启动。
- 本阶段后续完成了本树独立后端包、Desktop Main/Preload/Renderer 构建和真实 production 浏览器 initialize；最终真实 UI 结果见下一节。

## Mac 最终真实 Web/Electron 验收

- 本树 `prepare:backend:web`（packaged-node）与 `prepare:backend`（host-provided-node）均成功，后端、runtime 和 protocol 均由本树构建。正常 `pnpm run build` 完成 Desktop Main/Preload/Renderer；Electron 44.4.5 使用本树安装及输出。没有跨树运行时或协议产物链接。
- production Web initialize 实际通过浏览器 WebSocket 请求/响应断言：服务为 `ash-app-server`，major 7、schema hash 与本树生成协议一致，工作区目录是隔离 fixture 的真实目录。日志和结构化结果保存在 evidence 目录。
- 首轮真实 smoke 暴露测试假设错误：fixture 同时发现四项 Cargo 任务，因此修正后 catalog 应为五项；中文 Tasks 页签的 accessible name 为“任务”。已按实际产品契约修正断言，未放宽超时或弱化零执行检查。
- 后续 Web 英文用例暴露 Run Task 选择器未跟随外部配置刷新。新增真实注册命令 + DI 回归先失败（旧任务仍显示），修复后两项通过；选择器订阅最新 catalog，在隐藏时释放。异步命令提前保留服务实例，避免 invocation 结束后访问已失效的 accessor。
- 最终正常 `pnpm run test:unit` 选择五个 owner 测试文件：Tasks 26 + Terminal 43 = 69 项通过，0 失败文件；完整测试 TypeScript、公共前置及 runner 自身五项检查通过。最终 renderer 类型检查、`build:web:full` 和 `build:renderer` 均通过；automation 类型检查、NLS（中文缺项 0）也通过。
- 最终真实 `test:smoke:browser:full:no-compile`：4/4 通过，0 跳过、0 flaky，32.8 秒。真实 `test:smoke:desktop:no-compile`：4/4 通过，0 跳过、0 flaky，25.8 秒。两端均使用本树构建的完整后端与独立用户目录/端口/输出；不占用系统剪贴板或外部 Terminal.app。
- 四个场景覆盖：发现不执行、显式执行与 rerun、运行中取消、中英文 unsupported 配置。options/cwd/env/dependencies/matcher/background 和 process 在命令及面板入口均不增加 Terminal 数量、不写执行计数；外部修正清除旧错误，重试恰好执行一次且退出成功。unsupported 不创建 PTY 的服务层断言也通过。
- 最终候选基于 `e05e17e93c26f0281357ff9aca53bea8aaf98a67`，原始云端补丁原件/hash 保留。证据目录 `/tmp/ash-tasks-evidence-20261008` 保存原件、红灯、各轮 JSON/trace、最终日志、补丁与干净临时 index apply-check。没有 push，主线仍由父任务串行集成；原始脏 checkout 未改动。
- 本批验收完成，仅覆盖当前支持的 shell 集成执行与明确拒绝。完整 process argv、cwd/env、依赖图、matcher/readiness、变量与其他运行策略仍是后续能力，不声明完整 VS Code Tasks 兼容。

## 主线串行集成验收（槽已授权）

- 原验收提交与证据已保全到本地 `tasks-accepted-before-main-20261008` 和 `/tmp/ash-tasks-evidence-20261008/before-main-integration`。正常 fetch/rebase 到 `da7f3d12fe28abaad1eca5c80dbb5c9531c2b169`，无冲突；14 个 Tasks 文件 blob 与已验收候选逐个一致，未改他人生产代码。
- 新主线涉及生命周期/IME owner 和文本文件 drive identity，未改 Rust、协议、锁文件或本批 Tasks 代码。补跑正常定向 `test:unit`：157 项、8 个文件、0 失败；其中 Tasks/Terminal 69 项，相关生命周期/IME/textfile 88 项，runner 自身另 5 项通过。
- 正常 `typecheck:renderer`、automation 类型检查、`build:web:full`、`prepare:backend:web`、`prepare:backend`、完整 Desktop `build`、NLS 与本批十个 TS 文件格式检查均通过。后端复用的只是本树正常准备校验过的自有包。
- 新基线真实 Web 再次 4/4 通过（32.9 秒），Electron 再次 4/4 通过（24.8 秒），均无跳过或 flaky。覆盖发现不执行、显式运行与 rerun、cancel，以及中英文 unsupported→外部修正清错→仅运行一次的完整流程。
- 一轮 Web 启动前因我追加的 CLI `--trace=on` 与 fixture 自带 tracing 冲突而失败；原日志/JSON/trace 已保全。移除该参数后正常命令 4/4 通过，没有修改公共自动化模块或产品来规避错误。
- 最终提交只包含本批任务执行语义与拒绝/修正重试/rerun/cancel 闭环。按授权将候选整理为独立 subject 和 Why、What changed、Testing 三标题；非 force 推送并核实远端，最终 SHA、精确补丁与校验在 integration evidence 中保存。
