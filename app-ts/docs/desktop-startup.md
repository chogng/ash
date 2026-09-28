# Desktop 前端启动测量与优化路线

结论：复用 App Server 的窗口启动中，入口脚本执行和 Workbench 首屏创建是主要的前端耗时。首次工作区授权属于另一段等待，不能和前端执行混在一起判断收益。先用同一套 Playwright 场景比较端到端就绪时间和渲染进程阶段，再决定是否保留优化。

## 如何复测

在仓库根目录构建并运行：

```sh
pnpm --dir app-ts run pretest:smoke:desktop
ASH_DESKTOP_STARTUP_TRACE=1 pnpm --dir app-ts exec playwright test test/smoke/areas/windows/desktop-startup-trace.spec.ts --project=electron-app-server
python3 scripts/desktop_startup_trace.py <基线报告.json> <候选报告.json>
```

准备脚本需要支持 `tomllib` 的 Python。报告写入 `.build/startup-trace/desktop-*/desktop-startup-trace.json`，测试也会附加同一文件。每个构建测量四组，每组五次：新配置与首次授权、已授权但后端停止、复用运行中的后端、仅 UI。配置目录每次重新创建；操作系统文件缓存不清空。

`readyMs` 从 Playwright 发起启动请求计时，到工作台可用为止，包含 Electron 启动、窗口创建、授权操作和测试轮询。渲染进程中的 `responseEndMs` 与 `ash.*` 标记共用该窗口的 Performance 时间轴，可以比较脚本执行、连接和 Workbench 创建；两个时钟不能相减。报告还保留各次原始值与错误，比较脚本只给描述性中位数，不设置耗时门禁。

## 2026-09-27 基线

macOS arm64，本机正式构建；报告为 `.build/startup-trace/desktop-2026-09-28T02-14-04-284Z-7671/desktop-startup-trace.json`。二十次启动均成功。

| 场景 | 发起启动到可用的中位数 |
| --- | ---: |
| 新配置、首次授权 | 870 ms |
| 已授权、后端停止 | 740 ms |
| 已授权、复用后端 | 638 ms |
| 仅 UI | 559 ms |

复用后端的渲染进程中位数：页面响应结束到 `DesktopMain.open()` 约 95.5 ms；获取连接端口约 37.6 ms；端口获取后完成协议初始化约 19.0 ms；初始化后完成工作区设置约 15.8 ms；Workbench 创建约 84.2 ms。Workbench 内部的服务、外壳、可见视图恢复分别约 21、17.3、43 ms。诊断性细分显示，可见聊天视图约占恢复阶段 30 ms，其中输入编辑器约 23 ms。这些阶段位于同一窗口时间轴，但各中位数来自不同样本，不应直接相加成总耗时。

新配置样本中，协议初始化后的工作区设置阶段约 136 ms，包含首次授权与后续请求。它说明新用户启动体验，但不能拿来评估纯前端的脚本优化。

## 优化顺序

1. **入口执行与加载关系。** 先用 CPU profile 和构建清单找出页面响应结束到 `DesktopMain.open()` 之间实际执行的模块与主线程工作。目标是让入口只承担启动必需的注册和可见界面；功能代码按实际使用时机进入。每次调整同时核对入口静态 JS、首次功能使用成本和四组启动样本。
2. **连接往返与工作区准备。** 在渲染进程、Electron 主进程和 App Server 三处对齐同一连接的时间点，再针对重复请求或顺序等待修改各自负责的接口。首次授权必须保留为明确的用户决策。连接优化需覆盖后端停止和复用两种状态。
3. **首屏聊天输入框。** 它是可见且可交互的界面，不能通过提前报告“就绪”隐藏其创建时间。分析编辑器配置、视图和贡献项的 CPU 成本，保留键盘操作、补全、占位提示和无障碍行为；改动后用 Playwright 验证输入与恢复。

本次试过让模式贡献与连接并行，以及在连接时加载 Workbench 模块。两次试验都未在复用后端与仅 UI 场景得到稳定的端到端收益，因而没有保留。后续改动以这些场景的重复测量和对应功能测试为准。
