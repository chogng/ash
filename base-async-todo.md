# Base 异步取消与生命周期对齐

两个独立切片分别沿剪贴板 Paste/Cut 与 TextMate catalog 的真实调用链，修复 value/rejecting cancellation race 的预取消晚拒绝与订阅收尾。各自保留原结果、原错误与取消契约；不增加异步 API、平行 owner 或 UI 公共接口。

## 基线与准入

- Ash：2026-10-08 拉取最新 main，`dd086508b8c0eabe5931793302e8f7dc3d7a47b3`。独立 `ash-base-async-cloud` checkout，起始 tracked/untracked 状态为空；Git 对象共享，依赖与产物独立。
- 集成基线：2026-10-08 再次 fetch main 得到 `e08faa321d89d504a14e5d22eace76a8a2ff694c`；在该提交的干净 worktree apply-check 四文件通过，目录差异与内容校验均精确对应本批。验证树无冲突 fast-forward 到同一基线，复用它自己生成的产物缓存，未在不同 worktree 间复制生成产物。
- VS Code：只读固定提交 `88f4baf8714b14cd299f5cbba2e9920cc59d24df`。公开 `raceCancellation` 重载返回原结果或取消默认值；正常工作错误必须保留。上游测试验证取消能先于底层工作结束返回；不复制上游实现。
- 上游生产语义证据：`workbench/contrib/chat/browser/agentSessions/localAgentSessionsController.ts` 的 `refresh(token)` 只取消调用方等待、不取消共享刷新。Ash 本批同样保留底层 Clipboard service 的 Promise 所有权。
- 参考全局 `alignment-todo.md` 中 L01/B01：生命周期与取消只有局部源码审计，不能据此宣称整体 base 已验收。
- 真实调用链：Paste/Cut 命令 → `editor/contrib/clipboard/browser/clipboard.ts` → `raceCancellation` → `base/common/async.ts`。Editor 状态取消源拥有 focus/selection/model 取消条件；异步 race 拥有自己创建的订阅；底层 clipboard Promise 仍归 clipboard service。
- 可观察结果：取消后命令及时返回、不粘贴或剪切旧内容；立即释放 race 订阅；尚未结束的工作与晚失败不留下未处理拒绝；新 Paste 仍正常执行。

## 锁定范围

- `src/ash/base/common/async.ts`（双方同路径）：只修改 `raceCancellation` 的订阅、Promise 收尾及所需现有错误报告 import；保留公开签名与其他 helper。
- `src/ash/base/test/common/async.test.ts`（双方同路径）：覆盖成功、失败、先取消、晚结果、预取消、永久 pending 工作、清理异常及重入。
- `src/ash/editor/contrib/clipboard/test/browser/clipboard.test.ts`（既有 Ash 测试路径，本批准确边界已获批准）：通过真实 Paste 命令验证取消后释放与新请求；剪贴板生产代码只读。固定上游没有同路径测试文件，不声称这是文件数量对齐。
- `base-async-todo.md`：用户要求的新根工作记录。

## 已支持与缺口

- 已支持（本轮 E3）：race 返回原成功/失败，token 取消返回默认值；Paste/Cut 拒绝过期 editor 状态的结果。没有改变公开签名、取消底层任务或处理晚结果对象的所有权。
- 本轮已修复：取消分支等底层 Promise 结束才释放订阅；预取消分支没有观察原 Promise 晚拒绝；成功返回后的额外 microtask 才释放订阅。
- 实现说明：race 自己拥有唯一订阅；原 Promise 成功、失败或 token 取消时，先同步固定外层 Promise 的胜者，再同步尝试清理，await 调用方的下一 microtask 仍发生在清理之后。这样清理重入无法改变原成功、原错误或取消默认值。原 Promise 的两个处理器始终建立，预取消仍先返回默认值；注册期间同步取消也收尾返回的订阅，重复释放不会重复操作资源。
- 清理失败语义：按现有 base `CancellationTokenSource`/`Emitter` 边界报告给 `onUnexpectedError`，不替换已固定的 race 结果，也不让忽略的 `.then` 派生 Promise 产生拒绝。报告器同步抛错时用现有 `console.error` 兜底保留原清理错误与报告错误。默认 unexpected-error handler 的报告行为不被修改或静默关闭。
- 第一切片不包括 `raceCancellationError`；它在下方单独记录。其他 async helper、Search 基础输入、Notifications、Editor 保存模型均不在两个切片内。

## 验收步骤

1. 先运行新增回归并记录准确红测，再在唯一 base owner 局部修复。
2. 本树正常 `protocol:generate`，使用已有官方 Node/Rust 工具链、显式 Cargo/Rustup home，Cargo 并发 2。不复制跨树生成产物。
3. 标准 `pnpm test:unit` 精确选择 async/clipboard；类型检查 `typecheck:common`、`typecheck:renderer`；必要生产构建与 touched formatter、diff 检查。
4. 如标准 aggregate 被既有失败阻塞，保留日志并按仓库相同编译配置做定向验收，明确分别报告，不能称全套通过。
5. 初期实现只输出补丁；集成阶段在批准的四文件边界使用最新 main 的 base tree 和唯一 parent 原子发布，不 force，不覆盖并发修改。报告实际 SHA、CI 和验证范围。

## 本轮验证记录

以下命令使用官方 Node `24.21.0`、pnpm `12.8.0`、Rust `1.98.0`；pnpm 命令前置 `--config.verify-deps-before-run=false`，避免独立复制的依赖被跨树安装状态触发重装。测试、编译和生成步骤没有跳过。

- `pnpm run protocol:generate`：退出 0。本树正常生成，显式 `RUSTUP_HOME`/`CARGO_HOME`，`CARGO_BUILD_JOBS=2`；`.build/cargo`、protocol 与前端资源均为本树产物。此前本次复制的两个 protocol 目标已精确移除，未作为验证输入保留。
- 修改生产前，标准 `pnpm run test:unit --run src/ash/base/test/common/async.test.ts --run src/ash/editor/contrib/clipboard/test/browser/clipboard.test.ts`：实际执行 24 个测试，退出 1。成功/取消订阅仍在、永久 pending 的取消留下单个订阅、真实 Paste 取消后订阅仍在；预取消晚拒绝使 `--unhandled-rejections=strict` 子进程退出 1。
- 首版修改后，同一标准入口执行 25 个测试（async 20、Clipboard 5）通过；再选 cancellation/lifecycle 执行 62 个测试通过。但独立 review 后发现清理抛错会使 race 永久 pending/产生派生 Promise 未处理拒绝，清理重入会改变胜者，首版补丁已作废；这些结果不作为最终验收。
- 在首版源码补充 review 回归，标准 `test:unit --run src/ash/base/test/common/async.test.ts --grep 'cleanup reentry|throwing cleanup'` 实际执行 8 个测试，7 fail/1 pass，退出 1；使用真实 Emitter 清理回调与 strict-unhandled-rejections 子进程复现。
- 修复上述 review 阻塞后，最终标准 `test:unit` 选择 async、cancellation、lifecycle、Clipboard 四个文件：async 28、cancellation 16、lifecycle 21、Clipboard 5，共 70 个测试全过，退出 0；runner 的 5 个回归也全过。清理异常的 resolve/reject/cancel/同步注册取消及报告器抛错均已验证；重入的 resolve/reject/cancel 胜者均保持不变。
- 独立 review 在稳定编译产物上执行 strict 模式 20 个场景，全部通过；覆盖三结果与 plain/throw/reporter-throw/reenter/reenter-throw，注册时同步取消，以及预取消后的 late resolve/reject 与已完成工作。
- 在集成基线 `e08faa321` 上重新执行同一标准四文件入口：70 个测试与 runner 5 个回归全过；重新执行 `build:renderer`：common/test/renderer 类型编译和正常 Renderer 构建通过，退出 0。生产 `async.ts` 及其测试编译模块与独立 review 的 SHA256 完全一致。
- 标准入口最终源码的 `typecheck:common` 和完整 `tsconfig.test.json` 编译通过。翻译资源生成报告 0 missing，产品图标检查验证 246 个输出。
- `pnpm run build:renderer`：review 修复后的最终源码 renderer TypeScript 编译和 Browser/Electron Renderer 正常生产构建已重新完整通过，退出 0。唯一提示为 `PLUGIN_TIMINGS`，报告插件耗时占比，不代表性能已验收。
- `pnpm run format:ts` 选择三个 touched TypeScript 文件：0 unformatted；`git diff --check` 通过。
- `pnpm exec prettier --check base-async-todo.md`：通过。
- Warning：原有 Clipboard 测试继续输出 jsdom canvas 未实现日志；新增测试用自己拥有且恢复的 mock，没有新增该 warning。
- 未运行 Web/Electron 产品 Playwright、其他平台或全套所有 unit suites；这份 E3 验收不提升为 E4。
- 第一切片已原子发布为 `2dec0c4324ad018351986902f486aeee1513da5a`，远端 ref 与精确四文件均复核。该提交 CI 的 Spelling 通过；Formatting 报告 95 个既有文件，四个 touched 文件均不在其中。Frontend/Linux 全套执行 4,823 项后因另外五个测试文件失败，Windows/macOS 取消；不能宣称整套 CI 通过。相关修复由其他 owner 独立处理。

## 下一验收

第一切片的发布与 CI 已核对；第二切片按下方独立验收。整体 Web/Electron 产品行为仍须在最终组合源码验收。新的 async 边界另从真实消费者选择并先复现，不把其他上游成员差异当作实现清单。

## 第二切片：TextMate 取消后仍观察已启动的工作

- 基线：`c6d6db1ef0171832536c6ff16e87a939c8c8a813`，独立本地分支 `base-cancel-error`；起始工作树与 index 均为空。第一切片 `2dec0c4` 已发布，`raceCancellation` 的完整字节已单独锁定，本切片不得改变它。
- 准入链：TextMateGrammarService 注册/替换语法 → `materializeTextMateGrammarCatalog` 同步启动 `loadGrammar` → loader 在启动期间取消 signal → `raceCancellationError` → 调用方收到分类取消、已启动的 catalog Promise.all 仍被观察 → 旧 loader 晚失败或晚成功都不能产生未处理拒绝。
- 唯一 owner：base 的 rejecting race 拥有自己的取消订阅与外层 Promise；TextMate 服务继续拥有 revision、catalog 与 loader 生命周期，不向 base 移业务状态，不取消共享底层工作。
- 准确写入边界：`src/ash/base/common/async.ts` 中的 `raceCancellationError`、`src/ash/base/test/common/async.test.ts`、既有 `src/ash/workbench/services/textMate/test/common/textMateGrammarService.test.ts`、本文件。TextMate 生产源码与其他 async helper 只读。
- 已复现（只读实际运行）：稳定编译产物的真实 catalog 入口在 loader 中同步取消后正常返回 CancellationError 并保留原 reason；loader 晚失败使 strict 子进程退出 1，晚成功也因 catalog 的后置 abort guard 拒绝而退出 1。入口前已取消的对照通过，loader 调用 0 次；这是不同的入口语义，不能统改为 CancellationError。
- 当前契约：保留 `PromiseLike<T>` 同化，正常 work 的原值/原错误，取消时既有 CancellationError/message/reason/cause，以及 catalog 入口 `AbortSignal.throwIfAborted` 的原生 reason/AbortError 行为。清理抛错、重入和注册期间取消也必须验证，不能机械套用 value race 的代码。
- 正式红测：新增真实 catalog strict 回归、原生入口对照、PromiseLike/原错误控制，以及 rejecting race 清理异常/重入/注册期取消回归后，原生产源码的标准两文件 `test:unit` 实际执行 57 项，12 失败（base 10、TextMate 2），退出 1。独立 reviewer 建议再保留注册自身抛错的契约回归；将 helper 暂复基线后的标准 `test:unit --run src/ash/base/test/common/async.test.ts --grep 'failed subscription registration'` 实际执行 1 项，因底层晚拒绝产生 strict 未处理拒绝而失败。前两次 fixture 类型失败已修正，不作为红测证据。
- 原 owner 修复：预取消仍立即固定既有 CancellationError，但所有分支都保留 PromiseLike 同化与原工作的成功/拒绝处理器。成功、原错误、取消均先固定外层胜者，再清理唯一订阅；清理失败沿既有 unexpected-error 报告契约，报告器抛错继续保留两个错误。注册期间同步取消会清理返回的 handle；注册失败也观察已经启动的工作。TextMate 入口原生 abort guard 不变。
- 标准绿测：最终五文件 `test:unit` 选择 async、cancellation、lifecycle、Clipboard、TextMateGrammarService，实际 100 项（44/16/21/5/14）与 runner 5 项通过，退出 0；入口的 common 类型检查、完整 test TypeScript 编译与本树正常 generated 准备均通过。
- 生产构建：最终源码 `pnpm run build:renderer` 的 common/renderer 类型编译与正常 Renderer 生产打包通过，退出 0。产物在本树生成，未复制其他 worktree 的 protocol 或构建输出；仅有既有 `PLUGIN_TIMINGS` 提示。
- 集成复验：fetch 最新 main `721e4297e9982c8fab4e3df4c87ebfe41466efff` 后，干净检查树 apply-check 四路径通过；验证分支无冲突 fast-forward 并保持四任务 blob 不变。在该最新基线重新执行标准 100 项与 runner 5 项、`build:renderer` 均退出 0，生产与测试编译 hash 仍与独立 review 一致。
- 最终发布基线：恢复集成后 fetch main `f7d93765cf32a5cca44000c4748eeb3a7edfb3c3`，新增仅三个其他测试 fixture。验证分支无冲突 fast-forward，重新执行标准 100 项与 runner 5 项、`build:renderer` 均退出 0；生产与测试编译 hash 再次核对不变。
- 独立 review：稳定产物的 Node `24.21.0` strict 模式 78/78 场景通过。覆盖真实 AbortSignal/token、三胜者与清理失败/重入/报告器抛错、PromiseLike/跨 realm Promise、注册失败、reason/cause，以及真实 TextMate Registry/Catalog/Service 的 supersession/disposal。helper 外字节、已发布 `raceCancellation` 与生产/编译 SHA256 在验收前后完全不变；没有本切片阻塞。
- 后续验收：按最新基线原子发布后核对远端精确四路径与该提交 CI。未验证 Service 同步重入注册、全套 CI 或产品 Playwright，不将本次定向测试与构建提升为这些验收。
- 非本批：`Delayer` 在当前 `src/ash` 生产中没有调用方；`Throttler`/`ThrottledDelayer` 没有当前生产调用边，不因名字存在于上游而造功能。已读取的 Terminal timeout 由调用方 finally 主动 cancel，尚未复现它自身的缺口。
