# Smoke 跨平台修复交接 TODO

更新：2026-10-08。本文件归档云端 smoke 工作的交接资料，随工作树清理提交到 main。下文的云端检查为原任务报告；本地未取得已核验补丁字节，三文件修复尚未应用或发布。后续从 main 接手，先取得原补丁，再完成真实 UI 验收。

## 从哪里接手

- 云工作树：`/workspace/scratch/33fe1ca805e5/ash-smoke-platform-cloud`
- 分支：`fix/smoke-platform-assumptions-20261008`
- HEAD / 补丁 base：`1a49304ba4e03f4f08ccf67d8e93a3dd40bfcb8d`，已包含 `caf6e1494`
- 未提交代码仅有以下三个文件，共 41 行新增、42 行删除；本交接文档另计：
  - `test/smoke/areas/windows/renderer-hot-reload.spec.ts`
  - `test/smoke/areas/windows/command-center.spec.ts`
  - `test/smoke/areas/editor/auxiliary-window.spec.ts`

改动分别修正 Windows 的 Vite `/@fs/` 路径、按真实权限状态补齐精确标题后缀、用现有 `QuickAccess.runCommand` 和稳定 ID 执行辅助窗口命令。未修改产品代码、其他 Sessions / AgentHost spec；未增加 timeout、放宽标题断言或新增 `first()`。

## 已完成，可直接查证

- [x] 28 项构造 / fixture 机制回归：修改前 17 失败、11 通过；修改后 28 全通过。它们不是完整产品 UI 验收。
- [x] 本树正常 `pnpm protocol:generate`，jobs=1、独立 `.build/cargo`，退出码 0。
- [x] 本树生成后，全部 31 个协议源目录、当前输入及 1,362 个产物哈希已核实。
- [x] 本树生成后，`pnpm exec tsc -p test/automation/tsconfig.json` 通过。
- [x] 三文件仓库格式检查和 `git diff --check` 通过。
- [x] Electron 目标收集成功：10 条测试、3 个文件；仅 `--list`，没有将收集成功当作执行通过。
- [x] 独立只读审查无阻断：保留精确标题、tooltip、aria、Main 窗口标题与辅助窗口行为断言；弹窗监听先于命令执行。

工具链为 Node 24.21.0、pnpm 12.8.0、Rust 1.98.0。独立复制的依赖与锁文件一致，但 pnpm 仍提示工作区路径迁移，执行时使用 `verify-deps-before-run=warn`；未修改依赖或锁文件。早期跨树协议副本已移出工作树隔离，相关旧 types / list 日志不计最终验收；上述最终结果均在本树正常生成后重跑。

## 待办：本机真实 UI

- [ ] 将补丁和需要的证据传到本机的独立 Ash checkout，核对 base、补丁哈希和三文件 diff；不要把云路径当成本机路径。
- [ ] 使用正确工具链和该 checkout 的正常依赖 / 构建入口；先完成下面的 UI preparation。
- [ ] 运行下面全部 10 条 Electron 测试，记录 OS、HEAD、实际权限、通过 / 失败数及日志。
- [ ] Windows 普通用户与管理员各跑一轮，验证无后缀 / `[Administrator]` 以及 Windows HMR 路径。macOS 通过不能替代 Windows 验收。
- [ ] macOS 运行 Electron 选择，验证对应权限下的无后缀 / `[Superuser]`；只有实际以提升权限运行过，才能记该权限组合通过。
- [ ] 运行 Browser 选择，验证三文件中的非桌面专属流程；桌面窗口切换场景会跳过。
- [ ] 对失败保留实际错误、trace 和当前修改，不扩大补丁范围或降低断言。
- [ ] 验收完成后交回原集成负责人串行处理最新 main、提交及远端核实；当前没有发布记录。

本云的 Playwright Chromium 缺少配套可执行文件；已安装的 `/usr/bin/chromium` 实测在 `process_singleton_posix.cc:297` 因 `socket() EPERM` 退出。没有绕过限制。真实 Windows / Electron / Browser UI 均未在本云通过，不能据此宣称全跨平台完成。

HMR 测试会临时改写源码并恢复；在独立 checkout 运行，期间不要同时编辑这些源文件。

### 本机命令

以下命令均从本机 Ash 仓库根目录执行，Bash / PowerShell 均可使用。正常 preparation 成功后才能使用 `no-compile` 命令；任何源码更新后都要重新 preparation。

```sh
pnpm run pretest:smoke:ui
```

一次选择并执行全部 10 条：

```sh
pnpm run test:smoke:ui:no-compile test/smoke/areas/windows/renderer-hot-reload.spec.ts test/smoke/areas/windows/command-center.spec.ts test/smoke/areas/editor/auxiliary-window.spec.ts --grep 'desktop privileges|window title and command center|window title template|titlebar command center opens|detached|development rebuilds model cards|development DomWidget'
```

需要逐条接手或定位时，下面 10 条每条应命中一个测试。可先给对应命令加 `--list` 核对选择，但仍须去掉 `--list` 真正执行。

1. 辅助窗口继承主题和无障碍状态，并重开恢复窗口边界：

   ```sh
   pnpm run test:smoke:ui:no-compile test/smoke/areas/editor/auxiliary-window.spec.ts --grep 'detached editor window inherits workbench theme and accessibility state$'
   ```

2. 辅助窗口切换及关闭其他窗口：

   ```sh
   pnpm run test:smoke:ui:no-compile test/smoke/areas/editor/auxiliary-window.spec.ts --grep 'detached editor windows participate in desktop window switching and close-other-windows$'
   ```

3. 辅助窗口独立标题与布局空间：

   ```sh
   pnpm run test:smoke:ui:no-compile test/smoke/areas/editor/auxiliary-window.spec.ts --grep 'detached window titlebar follows its own editor and reserves layout space$'
   ```

4. 原有 Main 权限到窗口标题的独立契约：

   ```sh
   pnpm run test:smoke:ui:no-compile test/smoke/areas/windows/command-center.spec.ts --grep 'desktop privileges reach the window title through the Main process$'
   ```

5. 活动编辑器、脏状态及完整标题同步：

   ```sh
   pnpm run test:smoke:ui:no-compile test/smoke/areas/windows/command-center.spec.ts --grep 'window title and command center follow the active editor and its dirty state$'
   ```

6. 标题模板和分隔符动态修改：

   ```sh
   pnpm run test:smoke:ui:no-compile test/smoke/areas/windows/command-center.spec.ts --grep 'window title template and separator settings update the title and command center live$'
   ```

7. Command Center 的文件搜索、命令切换及焦点恢复：

   ```sh
   pnpm run test:smoke:ui:no-compile test/smoke/areas/windows/command-center.spec.ts --grep 'titlebar command center opens file search, switches to commands and restores focus$'
   ```

8. Code 侧模型卡片、对话和侧栏 HMR 保留状态：

   ```sh
   pnpm run test:smoke:ui:no-compile test/smoke/areas/windows/renderer-hot-reload.spec.ts --grep 'development rebuilds model cards, chat transcripts, and the Sessions sidebar while retaining their state \(code\)$'
   ```

9. Cowork 侧对应 HMR 保留状态：

   ```sh
   pnpm run test:smoke:ui:no-compile test/smoke/areas/windows/renderer-hot-reload.spec.ts --grep 'development rebuilds model cards, chat transcripts, and the Sessions sidebar while retaining their state \(cowork\)$'
   ```

10. DomWidget 连续重建保留草稿、焦点及关闭状态：

    ```sh
    pnpm run test:smoke:ui:no-compile test/smoke/areas/windows/renderer-hot-reload.spec.ts --grep 'development DomWidget rebuilds chat tips twice while retaining draft, focus, and dismissal state$'
    ```

Browser 的正常构建加执行入口：

```sh
pnpm run test:smoke:browser test/smoke/areas/windows/renderer-hot-reload.spec.ts test/smoke/areas/windows/command-center.spec.ts test/smoke/areas/editor/auxiliary-window.spec.ts --grep 'window title and command center|window title template|titlebar command center opens|detached|development rebuilds model cards|development DomWidget'
```

## 补丁、证据及空间

- 补丁：`/tmp/ash-smoke-platform-evidence-20261008/smoke-platform-assumptions.patch`
- 补丁 SHA-256：`4ed3c3f8618d83e089544691a4a6afdc0783bd75d324407d307de1ed2e457e30`
- 证据目录：`/tmp/ash-smoke-platform-evidence-20261008/`
  - `REPORT.md`：完整报告
  - `result.json`：验收结果汇总
  - `original-selected-errors.json`：Windows 原始失败摘录
  - `regression.test.cjs`、`before.log`、`after.log`：28 项机制红绿
  - `protocol-generate.log`、`protocol-final-provenance.log`：本树正常生成及产物核实
  - `typecheck-final.log`、`format-final.log`、`electron-list-final.log`：最终检查
  - `system-chromium-launch.log`：云浏览器权限阻断
- 原始 CI：`/tmp/ash-ci-failure-evidence-20261008/c580-win-113297388213.log`、`c580-win-errors.json`
- 交接时空间：本树 `.build/cargo` 约 1.5 GB；云文件系统剩余约 1.3 GB，使用率 96%。不要在此直接追加大型构建，也不要清理其他任务目录。

现有同文件中的 Panel 恢复、activity bar 选择、toolbar 可访问名称失败不属于本补丁，仍需各自负责人处理。
