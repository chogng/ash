# Desktop 前端启动测量

结论：复用 App Server 的窗口启动中，入口脚本执行和 Workbench 首屏创建是主要的前端耗时。聊天输入框只装载实际使用的编辑器扩展后，首屏 Workbench 创建缩短约 7–9 ms。首次工作区授权属于另一段等待，不能和前端执行混在一起判断收益。用同一套 Playwright 场景比较端到端就绪时间和渲染进程阶段，再决定是否保留优化。

## 如何复测

在仓库根目录构建并运行：

```sh
ASH_DESKTOP_STARTUP_TRACE=1 pnpm run pretest:smoke:desktop
ASH_DESKTOP_STARTUP_TRACE=1 pnpm run smoketest-no-compile test/smoke/areas/windows/desktop-startup-trace.spec.ts
python3 scripts/desktop_startup_trace.py <基线报告.json> <候选报告.json>
```

准备脚本需要支持 `tomllib` 的 Python。启动标记由源码对应阶段的 owner 发出；`ASH_DESKTOP_STARTUP_TRACE=1` 在构建时让 `build/desktop/vite/desktopStartupTracePlugin.ts` 校验这些标记未丢失，运行时开启 Main 连接诊断。插件不重写源码。报告记录后端和渲染产物编号，写入 `.build/startup-trace/desktop-*/desktop-startup-trace.json`，测试也会附加同一文件。每个构建测量四组，每组五次：新配置与首次授权、已授权但后端停止、复用运行中的后端、仅 UI。配置目录每次重新创建；操作系统文件缓存不清空。

`readyMs` 从 Playwright 发起启动请求计时，到工作台可用为止，包含 Electron 启动、窗口创建、授权操作和测试轮询。渲染进程中的 `responseEndMs` 与 `ash.*` 标记共用该窗口的 Performance 时间轴，可以比较脚本执行、连接和 Workbench 创建；两个时钟不能相减。报告还保留各次原始值与错误，比较脚本只给描述性中位数，不设置耗时门禁。Main 的校验、carrier 创建、端口交付、首个写入／回传和初始化确认使用 Main 自己的 Performance 时间轴，以端口 nonce 与 Renderer 关联；只比较各进程内部时长，不跨进程相减时间戳。首个载荷回传包含 carrier 和协议握手，不能解释成 Rust 初始化函数耗时。Renderer 的三个端口阶段 mark 使用当前 lease nonce 后缀，只保留当前 lease；替换、acquire 失败或 dispose 会清理本 lease 的名称，晚到确认不会重新生成旧 mark，也不会清理并行 transport 的记录。采集器只归一化这三个名称，保留原 nonce 和 startTimeMs，报告格式及计时起止点保持不变。

就绪之后，场景再从 Explorer 打开合成 `main.ts`，核对实际编辑器正文，随后点击标题栏命令搜索、输入 `>` 打开命令面板并核对可见选项。报告单独保留这两个首次使用的观察时长；仅 UI 组没有可用后端，因此只测命令面板。用 `ASH_DESKTOP_STARTUP_PROFILE=1` 另跑同一命令，每组单独采一次并保存首秒 Chromium CPU trace（含 V8 CPU samples）；诊断整批不能与无 profile 批次混比。静态依赖的字节数与文件清单在构建的 `build-metrics.json` 中，报告保存摘要和连同 `build-assets.json` 的组合哈希。

## 2026-09-27 基线

macOS arm64，本机正式构建；报告为 `.build/startup-trace/desktop-2026-09-28T02-14-04-284Z-7671/desktop-startup-trace.json`。二十次启动均成功。

| 场景             | 发起启动到可用的中位数 |
| ---------------- | ---------------------: |
| 新配置、首次授权 |                 870 ms |
| 已授权、后端停止 |                 740 ms |
| 已授权、复用后端 |                 638 ms |
| 仅 UI            |                 559 ms |

复用后端的渲染进程中位数：页面响应结束到 `DesktopMain.open()` 约 95.5 ms；获取连接端口约 37.6 ms；端口获取后完成协议初始化约 19.0 ms；初始化后完成工作区设置约 15.8 ms；Workbench 创建约 84.2 ms。Workbench 内部的服务、外壳、可见视图恢复分别约 21、17.3、43 ms。诊断性细分显示，可见聊天视图约占恢复阶段 30 ms，其中输入编辑器约 23 ms。这些阶段位于同一窗口时间轴，但各中位数来自不同样本，不应直接相加成总耗时。

新配置样本中，协议初始化后的工作区设置阶段约 136 ms，包含首次授权与后续请求。它说明新用户启动体验，但不能拿来评估纯前端的脚本优化。

## 2026-09-27 聊天输入框优化

`ChatInputEditor` 原来会给每个聊天标签装载整个代码编辑器扩展集合。现在只装载占位提示和聊天命令、技能补全所需的扩展。测量构建在相同机器上各启动 20 次，四组聊天输入框创建阶段的中位数从 23.8–25.5 ms 降至 18.1–19.2 ms；Workbench 创建阶段从 76.8–88.1 ms 降至 68.9–78.7 ms。端到端中位数四组均下降 11–34 ms，但它还包含进程、连接和测试轮询的波动，不能把整段下降都归因于输入框。

保留的界面验证覆盖输入、补全、键盘焦点、尺寸和占位提示。测量时额外加入的聊天组件细分打点在确认耗时后已从构建插件移除。

## 后续测量入口

入口加载与连接往返的剩余调查见 [Desktop 启动性能 TODO](../TODO.md#desktop-启动性能--todo)。聊天输入框扩展缩减已经完成；输入框是首屏可交互内容，不能通过提前报告就绪隐藏创建时间。新增优化均使用上面的四组样本、首个功能使用成本和相关输入／焦点回归共同判断。

本次试过让模式贡献与连接并行，以及在连接时加载 Workbench 模块。两次试验都未在复用后端与仅 UI 场景得到稳定的端到端收益，因而没有保留。后续改动以这些场景的重复测量和对应功能测试为准。

## 2026-10-18 入口与连接复测

本轮补齐了同一端口 nonce 的 Renderer／Main 记录，以及就绪之后的首次功能断言；没有凭静态大小拆包，也没有修改连接顺序。最终有效报告为 `.build/startup-trace/desktop-2026-10-18T20-55-55-455Z-65841/desktop-startup-trace.json`：四组各五次，20 次启动、15 次实际文件打开和20 次命令面板打开全部成功；复用组的 daemon PID 不变。首次授权仍由 Playwright 点击真实信任按钮，独立留在 fresh 组。

环境为 macOS arm64、Darwin 27.0.0、Apple M5／10 个逻辑核；开发构建使用 Electron 44.4.5／Chromium 152.0.7977.130，Playwright runner 使用 Node 24.21.0。后端为 `sha256:14c7a0dd270d7205e710c9d9a148bccd0f27590a6217bf3e97df9aff67dd84d5`，最终 renderer 清单组合哈希为 `sha256:c222d0b631dee7ab690ef78e2f6e03c2ef1c6cfa09979d78cb14ca81f128d406`。源码基于 `b1005bb5667957ad4df3071385503674e7a74412` 加未提交变更，完整 tracked diff 的 SHA-256 是 `7c7b4e7c5f0f87bd6068f45318f9d13042c0c05c0467e868f306a406f3a69e49`；具体编译结果以产物清单为准。采样期间其它测量和重型构建串行，但外部 VS Code Plugin 进程仍占约一个核，因此以下是当前环境的描述性基线，不能与九月数据直接作优化归因。

| 场景             | 启动到可用的五次原值（ms）   | 中位数（ms） | 首次文件打开（ms） | 首次命令面板（ms） |
| ---------------- | ---------------------------- | -----------: | -----------------: | -----------------: |
| 新配置、首次授权 | 2076、1816、1847、1778、1815 |         1816 |               70.9 |              128.4 |
| 已授权、后端停止 | 1422、1414、1443、1398、1389 |         1414 |               61.8 |              123.8 |
| 已授权、复用后端 | 862、907、854、879、835      |          862 |               63.0 |              125.1 |
| 仅 UI            | 704、686、675、715、676      |          686 |                  — |               89.7 |

首次功能时间是 Playwright 操作到独立 DOM 断言的观察时长，包含自动等待和输入处理，不能解释成纯模块加载 CPU。

同一窗口的阶段中位数如下；每列分别取中位数，不应把这些值相加构造一个虚拟样本。

| 场景             | responseEnd → open（ms） | 贡献加载（ms） | 端口获取（ms） | 端口后初始化（ms） | 初始化后工作区设置（ms） | Workbench 创建（ms） |
| ---------------- | -----------------------: | -------------: | -------------: | -----------------: | -----------------------: | -------------------: |
| 新配置、首次授权 |                    176.1 |          114.9 |            1.5 |              529.3 |                    393.7 |                169.9 |
| 已授权、后端停止 |                    185.9 |          106.0 |            1.4 |              520.7 |                     35.0 |                160.2 |
| 已授权、复用后端 |                    174.2 |          106.0 |            1.3 |                3.1 |                      2.7 |                165.9 |
| 仅 UI            |                    174.6 |          107.4 |            0.7 |                  — |                        — |                109.1 |

Main 的同 nonce 记录将慢等待进一步隔离出来：三组连接的 validate 中位数均为0.13 ms，carrier 就绪后端口交付约0.36–0.37 ms；首个写入到首个回传，新配置／停止后端分别为527.7／519.1 ms，复用后端仅1.7 ms。首个回传之后完成 Main 初始化确认约0.9–1.3 ms。carrier 在 acquire 前已由启动 owner 创建，因此报告要求 `carrier-ready`，不把缺少当前 acquire 内的 `launch` 误判成没有启动进程。数据将下一轮冷启动调查指向 carrier／后端；它尚未分开 Rust daemon 的选择、probe、目录 runtime 打开与 App Server initialize，不能直接删除兼容性校验或某次请求。

### 构建清单与 CPU 证据

最终 Desktop Workbench 入口静态依赖为 **1,349,127 B／62 个 JS chunk**，其中 localization 命名的 catalog 与消息 chunk 共1,181,898 B（87.6%），同时包含英语和中文。首屏还会动态加载贡献模块，故这个静态总量既不是首屏全部传输量，也不是每个模块的执行成本。完整清单保存于 `.build/investigations/desktop-startup-2026-10-18/build-metrics-final.json` 和 `build-assets-final.json`。

另一次独立诊断在 `.build/startup-trace/desktop-2026-10-18T20-48-33-040Z-50613/` 留下四个首秒 trace，共记录四组 Renderer V8 CPU samples。贡献加载阶段分别为125.8、138.5、125.2、118.5 ms；可归到 JS 函数的采样 self time 约43.6–45.7 ms，另有66.1–78.4 ms 的 `(program)` 样本，不能把整段间隔都归入某个 JS 函数。每个 trace 的模块编译事件累计约11–12 ms；首秒诊断有 profile 开销，且新配置／停止后端组未覆盖完整 Workbench 创建。复用／仅 UI 两个完整创建区间的 JS 函数采样 self time 分别约166／128 ms，热点分布于已有编辑器配置、merge、实例化和布局所在的共享 chunk；没有得出一个可安全推迟且已证实收益的模块切片。解析结果及分析脚本位于 `.build/investigations/desktop-startup-2026-10-18/`。

### 失败记录与后续范围

早期诊断中有一次把预建 carrier 当作缺少 launch，另一次错误地用 Electron `contentTracing.stopRecording` 停止 Chromium 的启动 trace；两者是测量入口问题，已经修正。后续4 次 CPU 诊断及一个被停止的无 profile 批次，在就绪之后的 F1 命令面板入口失败；CPU 文件只用于分析已经发生的首秒启动，整批不计入有效启动／首用基线。首批 F1 成功与后来失败的报告源码 revision 均为 `d7485e6e5`，不能归因于某个并发提交，具体 F1 原因仍未定位。最终批次使用产品现有标题栏命令搜索按钮，完成同一命令面板的真实打开与选项断言；这不构成 F1 回归通过。

本轮没有可归因的启动优化前后收益，也未修改模块加载和后端兼容性契约。后续分别验证按选定语言加载资源的完整生命周期，以及将冷连接内部 Rust 阶段携带同一连接标识；候选应继续覆盖上述四组和首次功能成本，通过数据决定是否保留实现。比较脚本已防止把 profile 批次混入无 profile 对照，并把 nonce 不匹配的 Main 阶段判为不完整。Python 比较回归12 项、Main／automation 类型检查、prepared Desktop 构建和最终真实 Desktop 场景均通过；所有本次测试拥有的窗口及后端已退出。

提交前的生命周期复核另补15 项 MessagePort transport 单测，覆盖20 轮重连后的 mark 数量有界、并行 transport 独立释放和晚到 initialized 确认；原取消、错误、ACK 和端口释放用例也全部通过。一次独立合成 Desktop 场景核对当前 lease 恰有三个私有 mark、与 Main 的 nonce 一致，以及归一化前后的每个 startTimeMs／detail 完全相等；该验证不作新性能对照，原20 个有效样本保留。证据位于 `.build/ash-playwright-mcp/evidence/startup-marks-lifecycle-2026-10-18T21-08-13-877Z/`。
