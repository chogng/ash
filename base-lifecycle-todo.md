# Base singleton 资源所有权

本批修复开发期泄漏追踪的 singleton 所有权合同，以及 IME realm 状态缺失的 emitter owner。不会提前导入模块、关闭泄漏检查或全局豁免 emitter。

## 准入与边界

- Ash 基线：`baba5f6`；VS Code 只读参考：`ddcb6c27affe30052a2ade0bfe6c8bcaea9f89e5`。
- 发布集成基线：无冲突 rebase 至 `11f6898309bef8a8f5e1ca710770296d156e8e9f`；四个已审源码/测试 hash 不变，同一标准 94+5 测试与 renderer 构建再次退出 0。
- 生产链：Open Editors 首次加载 → InputBox → IME 状态及事件；Keybinding chord → IME enable/disable → InputBox 与 EditContext 消费者。
- `base/common/lifecycle.ts` 与 `base/common/ime.ts` 均有上游同路径职责。只修改 Ash 既有 tracker 的报告语义及 IME 的资源所有权，不复制上游私有实现。
- VS Code 的 singleton root 及已注册后代不计入泄漏；上游 IME 是 realm 状态，没有实例释放 API。Ash 的 leaf dispose 属于本地资源合同适配，不称为上游 IME 架构。
- 修改范围：以上两个生产文件、既有 `base/test/common/disposableTracker.test.ts`、新增 `base/test/common/ime.test.ts` 和本记录。`async.ts`、Open Editors 实现与测试均不改动。

## 合同与实现

- 每次查询沿当前所有权图计算 singleton root 的后代；支持先注册后标记，以及标记后新注册。移除或转移到普通 owner 后恢复泄漏报告。
- singleton 标记不能隐藏普通 owning root。循环与多重 owner 仍被拒绝；已释放的旧 owner 不给已脱离后代永久豁免。
- IME 的普通实例是持有单个 emitter 的 `AbstractDisposable` 叶子，直接登记并释放其 emitter。只标记导出的 realm 实例；普通实例、独立订阅和未登记资源仍受检查。
- 保留 boolean 事件负载、状态去重与现有消费入口；释放普通实例后拒绝继续修改状态或注册监听。

## 验收

- 标准 red：生产代码不改，仅增加 tracker 回归；tracker 16 通过、5 失败。原 Open Editors 第一个行为用例通过，但 afterEach 准确报告 IME 构造的 `Emitter without an owner`；共执行 22 个测试、2 个文件失败。
- 标准 green（最终源码重新运行）：`test:unit` 94/94，runner 5/5；覆盖 tracker 21、IME 2、lifecycle 21、event 15、InputBox 4、Open Editors 2、keybinding 29。Open Editors 测试与动态导入位置未改。
- 标准前置完整通过 `protocol:generate`、localization、`typecheck:common`、icons；完整 `tsconfig.test.json` 编译通过。4 个修改的 TypeScript 文件通过仓库 formatter，`git diff --check` 通过。
- `build:renderer` 正常生产构建退出 0；保留现有依赖工作树结构提示和 Vite plugin timing 性能提示，没有类型或构建失败。
- 独立只读 review 无阻塞；补充 probe 使用 Node 24.19.0（标准验收为 24.21.0），对最终稳定编译产物额外验证已释放 singleton/child 拒绝新资源且拒绝的资源仍报告，以及已标记后代脱离普通 owner 后成为 root 的行为。复核上游 root-parent 语义及本树 1359 个 protocol 产物来源。
- 待完成：串行发布与远端核实。
- 工具版本：Node 24.21.0、pnpm 12.8.0、Cargo 1.98.0；必要 protocol 生成限制 `CARGO_BUILD_JOBS=1`。依赖与已验证相同的 lockfile 对应，只读链接现有依赖，未 install/rebuild；使用 pnpm 支持的 `--config.verify-deps-before-run=warn`，如实保留链接工作树结构提示。
- 每棵工作树独立生成 protocol、编译与测试产物。初次误用的外树 protocol 副本已移出本树，相关诊断结果不计入验收。
- 未宣称：全仓库测试、产品 Playwright、整个 base/platform 对齐完成。
