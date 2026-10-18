# Windows Smoke 实机验收交接

更新：2026-10-18。原云端三文件修复已在当前 checkout 独立重做，无需继续寻找旧云工作树或 `/tmp` 补丁。本轮改动作为本地提交保存，尚未发布；交接时须保留本次提交。本机运行也包含 checkout 当时已有的窗口宿主改动，不能将结果当作纯 HEAD 的通过记录。

本机修复覆盖 Windows Vite `/@fs/` 路径、按真实权限精确断言标题、辅助窗口稳定命令 ID，以及当前 UI-only／Quick Access／窗口关闭契约的测试准备。实际运行还修复了终端默认服务注册和 DI 延迟代理的启动阻断，以及 Chat HMR 可见／隐藏状态的阅读位置恢复。产品改动位于 `instantiationService.ts`、`terminal.contribution.ts`、`chatListWidget.ts`，不能只交接三份 spec。

## 本机验证

- macOS arm64，普通用户 UID 501：最终 Electron 选择 **10 passed**，包括真实 Main 权限、精确标题、tooltip／ARIA、窗口切换、关闭独立窗口并保留本工作台辅助窗、草稿返回与边界恢复，以及 Code／Cowork／DomWidget HMR。
- macOS Chromium Browser 选择 **8 passed**；两个桌面专属测试由 project 排除。窄窗口布局使用实际 viewport 缩窄，仍精确检查省略、tooltip 和焦点。
- DI 与终端单测 **113 passed**，Chat List 单测 **17 passed**；两个新增 DI 回归在修复前均失败。
- 正常 Electron／Browser preparation、自动化类型检查和改动源码格式检查通过；另有 8 个路径构造检查覆盖两处 HMR 回调的 Windows、macOS、Linux 路径，不能替代 Windows UI。
- 本机证据：`.build/smoke-platform-local/`。最终执行日志为 `electron-final.log`、`browser-final.log`；构建日志为 `prepare-electron-final.log`、`prepare-browser-final.log`；单测日志为 `di-terminal-final.log`、`chat-list-unit.log`。
- `result.json` 记录 HEAD、7 个改动源码的哈希与通过数；`task.patch` 保存本轮源码 diff，SHA-256 为 `53349156ae333fd8929182b7f202e1d835f065603f43a5a52be60fc9f24d064f`。四个 HMR 源文件的运行前后哈希一致，runner 已退出。

macOS 本轮没有提升权限，不记录 `[Superuser]` 组合通过。未运行 Windows；本文件只保留 Windows 的待验收项。

## Windows 剩余工作

- [ ] 在普通用户、未提升权限的交互桌面中运行下面全部 10 条，确认无权限后缀。
- [ ] 在管理员提升权限的交互桌面中再运行全部 10 条，确认精确的 `[Administrator]` 标题、tooltip／ARIA 与 Main 窗口标题；两轮都须验证 Windows HMR 路径。
- [ ] 每轮记录完整源码 SHA／工作区 diff、Windows 版本与架构、实际权限、通过／失败数、日志及失败 trace。确认测试进程退出、HMR 源文件恢复后，关闭根 TODO 的入口并移除此交接文件。

使用仓库锁定工具链与正常构建入口，从接手机器的目标 Ash checkout 根目录执行。HMR 会临时修改并恢复源码，运行期间不要并发编辑或构建相关源码。源码改变后重新 preparation。

```sh
pnpm run pretest:smoke:ui
```

普通用户和提升权限的终端分别执行：

```sh
pnpm run test:smoke:ui:no-compile test/smoke/areas/windows/renderer-hot-reload.spec.ts test/smoke/areas/windows/command-center.spec.ts test/smoke/areas/editor/auxiliary-window.spec.ts --grep 'desktop privileges|window title and command center|window title template|titlebar command center opens|detached|development rebuilds model cards|development DomWidget'
```

应实际执行 **10 条**。可先加 `--list` 核对选择，但收集成功不能记为验收通过。出现失败时保留错误和 trace，继续定位，不增加 timeout 或放宽标题、焦点、滚动位置等断言。
