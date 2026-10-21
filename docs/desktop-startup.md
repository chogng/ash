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

开启诊断时，每个本地 carrier 在创建时获得独立追踪 ID；Main 将实际子进程 PID 与 Renderer 当前端口 nonce 配对，Rust 在私有 connection prelude 中把该 ID 和 carrier PID 传给 managed 后端。健康 probe 使用独立的 `probe` scope，实际连接使用 `connection` scope。Rust 只记录本进程 `Instant` 时长、固定阶段名及进程身份；作用域结束包含错误返回，不单凭记录存在判断成功。关闭诊断时不发送该额外字段，普通连接的 prelude 不变。该诊断应使用本检出准备的匹配包，旧后端可能拒绝它不认识的诊断字段。

报告增加 `rust` 样本与 `rustClock` 条件。采集器从 Main 已有的脱敏 carrier 诊断和 managed 日志读取有界结构，按同一追踪 ID／carrier PID 配对；不同 ID、PID、nonce 或缺少阶段会使比较不完整。用于定位日志的额外健康查询发生在启动和首次功能操作全部计量之后，避免诊断查询提前预热首次功能；旧配对批次的日志查询位于首用前，比较时必须保持报告中的首用条件一致。Rust 的选择、哈希、probe、目录打开和 initialize 有嵌套关系，不能相加或与 Main 时间戳直接相减。

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

本轮没有可归因的启动优化前后收益，也未修改模块加载和后端兼容性契约。当时留下的两项工作为选定语言资源的加载生命周期和冷连接内部 Rust 阶段配对；后者现由本页的连接配对诊断承接。候选继续覆盖四组和首次功能成本，通过数据决定是否保留实现。比较脚本已防止把 profile 批次混入无 profile 对照，并把 nonce 不匹配的 Main 阶段判为不完整。Python 比较回归12 项、Main／automation 类型检查、prepared Desktop 构建和最终真实 Desktop 场景均通过；所有本次测试拥有的窗口及后端已退出。

提交前的生命周期复核另补15 项 MessagePort transport 单测，覆盖20 轮重连后的 mark 数量有界、并行 transport 独立释放和晚到 initialized 确认；原取消、错误、ACK 和端口释放用例也全部通过。一次独立合成 Desktop 场景核对当前 lease 恰有三个私有 mark、与 Main 的 nonce 一致，以及归一化前后的每个 startTimeMs／detail 完全相等；该验证不作新性能对照，原20 个有效样本保留。证据位于 `.build/ash-playwright-mcp/evidence/startup-marks-lifecycle-2026-10-18T21-08-13-877Z/`。

### 2026-10-18 F1 本机复核

新增真实 macOS Electron 回归使用隔离 profile、UI-only 模式和显式激活的原生窗口。先确认原生窗口及 document 都有焦点，再发送真实 F1；命令输入必须获得焦点、值为 `>` 且命令选项可见，Escape 关闭后恢复之前的焦点。此入口没有点击标题栏，也没有直接执行命令。最终单个回归通过（1.3s），automation 类型检查通过；日志 `.build/todo-round2-f1-final.log` 和 `.build/todo-round2-f1-automation-check.log`。

调查另记录了名义 hidden／active 两组的原生窗口可见性、focusable、焦点与实际 F1 keydown。两组在按键前都实际可见、有焦点，按键均到达并成功打开命令面板，因此没有形成真正隐藏窗口的对照，不能将旧失败归因为隐藏模式。独立 JSON、截图、原始视频和诊断脚本保存在 `.build/investigations/desktop-f1-2026-10-18/`；观察性对照没有加入长期回归。

本次未重跑四组启动性能采样、未复现历史 F1 失败，也未修改快捷键分发或启动入口。新的实窗回归只证明当前原生焦点前置条件下的行为；旧失败的原因继续保留在根 TODO。

```sh
pnpm run test:smoke:ui:no-compile test/smoke/areas/windows/desktop-command-palette.spec.ts --max-failures=1
```

## 2026-10-20 文件监听启动阻塞修复

macOS arm64 在隔离 HOME、空 Codex home 和新 profile 下打开当前 Ash 仓库，旧准备包在 45 秒内没有返回 `initialize`；同目录的监听探针在 root 注册处超过 20 秒。临时阶段记录进一步确认 App Server 已进入 `FileSystemWatcher` 的 root 注册，尚未返回。证据为 `.build/agenthost-closeout/{baseline-probe,baseline-watcher,baseline-instrumented}.json`，不把 daemon endpoint ready 当作协议初始化完成。

原生 FSEvents helper 已有期限，但失败后的 `PollWatcher::watch` 会同步建立递归内容基线；仓库中的大体积构建产物使这一步阻塞目录 runtime。`FileSystemWatcher` 的启动超时随后仍会 join 该线程，不能约束这段等待。本次保持原 initialize deadline，将 macOS 轮询也放入可终止的私有 helper：控制线程接受有界、可合并的完整 root 快照，扫描完成后发送 rescan。重扫先核对实际注册路径；合并快照保留重绑标记，root 的 inode／纳秒时间检查覆盖秒级目录时间不变的快速替换。接口、匹配和回收契约见 [file-watcher](../crates/file-watcher/README.md)。

协议就绪后立即关闭隔离实例还暴露了后台源码扫描的 join 等待。目录 refresh worker 现向源码遍历和准备传递取消，退出前保留最后一份完整索引；不通过分离线程绕过资源释放。共享 App Server、每 Renderer 连接和领域 owner 不变，helper 不加载配置或凭据。

当前源码通过 `pnpm prepare:backend` 的 `dev-small` 正常构建，验证使用选中的准备包 `d9899a30a0ec12ffc241ed2221b696128c995566331f63591128e221c3e13a7a`。验证使用隔离实例，未手动重启用户进程。相同仓库的五个新 profile 全部初始化成功并以退出码 0 结束：initialize 为 2.303、2.928、2.596、1.643、2.077 秒，中位数 2.303 秒；收到正常 EOF 后退出为 2.455、1.315、1.358、1.075、1.039 秒，中位数 1.315 秒。这是独立进程协议响应和退出的观察区间，不是完整 Workbench 启动时长；原始数据见 `.build/agenthost-closeout/initialize-samples.json`。

真实 Electron 另外通过准备包启动并打开 Agents、停后端后重开已授权工作区、复用选中包 daemon 三个场景，命令为 `pnpm run smoketest-no-compile test/smoke/areas/windows/home.spec.ts --grep 'Desktop development startup opens Agents|Desktop reopens an authorized workspace|Desktop reuses a daemon'`，完整日志 `.build/agenthost-closeout/desktop-smoke-verified-host.log`。监听的删除／重建两场景在修正后连续五次通过；同时间戳替换和阻塞扫描期间的更新／回收另有确定性回归。旧失败日志保留，未以重复运行掩盖失败。

本次不归因系统 `fseventsd` 长期高 CPU，也不把这些隔离验证当作完整外部账号目录或旧窗口收尾弹窗的现场因果证明。

## 2026-10-20 Rust 启动阶段配对

本轮只补连接诊断和采集，不修改启动顺序、校验、超时或模块装载。有效报告为
`.build/startup-trace/desktop-2026-10-21T02-36-04-038Z-68294/desktop-startup-trace.json`，
以 2026-10-20 本地日期记录。macOS arm64／Darwin 27.0.0、Apple M2 Max／12 核；后端为正常
`dev-small` 的 host-provided-node 包 `sha256:4f69228593b86e9ddda43219b538b848d12ee109a8c4c22992bb2372a3382670`，
实际后端文件 231,952,528 B，Renderer 清单组合为
`sha256:d99baaa59d8e3d8f52a44079a6e900976879925575a79f4614c66d0a4c691456`。
源码为 `be148189e` 加本轮及并发未提交改动；包清单和 `.build/startup-trace/rust-pairing-20261020/manifest.json` 中的文件摘要标识实际验证来源。
这与 10 月 18 日的机器、产物和前端体积均不同，不把两批时间差当作优化收益。

四组各五次，20 次启动、15 次实际文件打开、20 次命令面板打开全部成功；复用组 daemon PID 不变。
每个后端样本均验证 Renderer nonce → Main carrier PID → Rust 追踪 ID 的唯一配对，
并分别断言 probe 与实际连接的目录打开、initialize 阶段。UI-only 不产生 Rust 记录。

| 场景             | 启动到可用五次原值（ms）     | 中位数（ms） | Main 首写→首回传中位数（ms） |
| ---------------- | ---------------------------- | -----------: | ---------------------------: |
| 新配置、首次授权 | 4593、3987、3457、3030、3046 |         3457 |                       1647.2 |
| 已授权、后端停止 | 2730、3082、2798、2876、3826 |         2876 |                       1619.5 |
| 已授权、复用后端 | 1384、1380、1247、1294、1299 |         1299 |                          2.7 |
| 仅 UI            | 975、1011、1069、1051、969   |         1011 |                            — |

以下是同连接配对后的 Rust 本进程时长中位数，单位 ms。每行独立取中位数，且作用域嵌套，禁止相加；
Main 首写发生时 carrier 可能已完成部分选择／哈希工作，也不能拿这些数反推跨进程开始时间。

| 阶段及 owner                                   |   新配置 | 停止后端 | 复用后端 |
| ---------------------------------------------- | -------: | -------: | -------: |
| carrier 获取生命周期操作锁                     |    0.570 |    0.235 |    0.273 |
| carrier 读取后端文件并计算 SHA-256             |  221.320 |  138.757 |  210.551 |
| carrier ensure-selected 全段                   | 1381.433 | 1471.976 |  222.317 |
| carrier daemon probe 往返                      | 1031.648 | 1108.583 |    1.463 |
| managed 启动到 endpoint bind 返回              |  219.847 |  158.926 |        — |
| managed 自身可执行文件 SHA-256（包含于上一行） |  134.741 |  125.845 |        — |
| 服务端 probe scope 的目录打开                  | 1030.783 | 1107.623 |    0.315 |
| 服务端 probe scope 的 initialize 函数          |    0.088 |    0.074 |    0.051 |
| 服务端实际连接的目录打开                       |  556.447 |  362.258 |    0.243 |
| 服务端实际连接的 initialize 函数               |    1.106 |    1.877 |    2.016 |

当前慢等待主要落在冷目录运行时准备：probe 没有目录 root，实际连接有 root，在 registry 中是不同的目录 key；
probe 的目录打开约覆盖了整个 probe 往返，而 initialize 函数本身很短。
SHA 对这个 232 MB 开发可执行文件有可测成本，但复用组同样执行文件哈希；复用组约 2.7 ms 的首写→回传并不代表其启动链没有做哈希。
这组证据支持旧报告中“冷运行时准备远慢于复用”的调查方向，没有重现旧机器／旧产物的精确 520 ms，
也没有复现或归因用户的所有启动故障。目录准备内部的 IO／扩展成本还需在选择优化时继续细分。

首次采集保存在 `.build/startup-trace/desktop-2026-10-21T02-33-00-155Z-59190/`：
20 次窗口均到达就绪，但采集器的阶段名正则不接受 `executable-sha256` 中的数字，15 个后端样本因此报采集错误并跳过首次功能操作；
不能将该批算作完整验收或产品故障。修正规则后使用同一准备包重跑上面的四组；失败报告及比较器的不完整判断均保留。

验证包括 `just verify ash-app-server-daemon`（59 项）、
`just verify ash-app-server-runtime --filter managed::registry::tests`（16 项）、
`just test ash-app-server-runtime --profile ci-test initialize_is_required_and_request_ids_are_connection_unique`（1 项），
以及 launcher 单元文件 4 项、Python scripts 207 项（1 skipped，配对比较文件 14 项）、automation 2,993 文件类型检查、
正常 `pnpm run pretest:smoke:desktop` 和真实四组启动场景。
初次误用 `--filter startup_tests` 没有匹配用例，verify 明确失败，随后改用实际模块路径完成上面的 16 项；零用例不计通过。
比较脚本对有效报告的自校验完整通过，仅证明配对和完整性，不构成前后优化对照。
所有本次测试的 Electron 窗口和后端均已退出。

## 握手与构建身份

当前 Ash 的可执行文件 SHA-256 用于识别后端代次和验证包摘要，协议 `schemaHash` 用于要求生成契约完全一致；它们不是同一个检查。前者的文件读取与哈希成本可由 `executable-sha256` 阶段观察，后者在真实 initialize 后比较协议身份；支持下述轻量握手时，carrier 也会提前检查 control response 中的协议身份。Git 历史中，可执行文件哈希来自 2026-09-12 的 `6ec4d6c8ea`，严格 schema 一致检查来自 2026-10-06 的 `335b42c9ea`；本轮没有新增或放宽这些检查。

以下为 2026-10-20 对本地只读源码和项目官方来源的对照，不表示 Ash 已迁移握手协议：

| 项目入口                                                                                                                                                                   | 已有机制                                                                                              | 对 Ash 的启发                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| [VS Code Remote Server](https://github.com/microsoft/vscode/blob/72e9539ed6b7115bae67de36810bf10c3cb0ba47/src/vs/server/node/remoteExtensionHostAgentServer.ts)            | 认证／签名握手；两端都有 commit 时要求相等                                                            | 同产品内部后端可绑定明确构建，避免复用旧产物；构建身份与认证各自有目的。   |
| [VS Code Agent Host](https://github.com/microsoft/vscode/blob/72e9539ed6b7115bae67de36810bf10c3cb0ba47/src/vs/platform/agentHost/common/state/protocol/common/commands.ts) | 客户端提交协议版本列表，服务端选兼容版本；不兼容返回专门错误和支持列表；实现名称／版本另行记录        | 独立升级的多客户端服务可采用协议协商及分域能力契约，但须维护实际兼容基线。 |
| [Zed Remote](https://github.com/zed-industries/zed/blob/9f63850f7affbd57772a4f99554d4fd333b50a6f/crates/remote/src/remote_client.rs)                                       | 远端二进制按渠道／版本部署；重连使用新的握手消息 ID，只接受对应 ACK，握手确认不退休尚需回放的业务消息 | 将后端代次、当前连接握手及业务回放确认分开；迟到确认不能恢复旧连接。       |
| [MCP 生命周期](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)                                                                                   | initialize 协商协议和能力，客户端随后发送 initialized；各阶段限制允许的消息                           | 就绪状态应对应已经完成的协议步骤；endpoint 可连接不等于业务初始化完成。    |

Ash 当前随产品一起生成的客户端仍使用严格 schema 一致契约。若后续允许前后端独立升级，可评估协议版本协商和关键能力版本；替换前需覆盖新增／缺失字段、旧客户端与新后端、反向组合，以及权限／模型参数不会被旧端静默忽略的行为。包完整性检查仍有独立用途。当前反复启动故障的原因须由具体失败阶段判断，不能由“有 SHA”或别的项目用了哪种握手直接推导。

## 2026-10-20 轻量连接握手

carrier 现在使用私有 control response 中可选的 `connectionContract` 判断是否允许 Agent 连接，
校验进程记录、包代次、协议 major 与 schema 后直接交付真实连接，不再为健康检查先创建一个无目录 runtime。
该契约由 App Server 在 profile registry 创建成功后发布；历史已转移的 profile 明确发布 execution-only。
它不宣告目录能力或 initialized 状态，真实客户端仍须完成 initialize 和必需能力检查后才能就绪。
旧后端不含该字段时回退完整 probe；显式 `start`、`version`、Web 生命周期及 Execution 连接仍保留原检查。
包 SHA、严格 schema 一致、超时、停止及失败启动回收语义均保留，没有引入公开协议版本协商。

同机、同 Renderer 与协议的四组对照保存在 `.build/startup-trace/light-handshake-20261020/`：
`baseline.json` 对应 `desktop-2026-10-21T03-18-32-814Z-61729`，
`candidate.json` 对应 `desktop-2026-10-21T03-23-34-138Z-69771`，完整比较为 `comparison.txt`。
两批均使用 macOS arm64／Apple M2 Max／12 核及正常 `dev-small` 包，Renderer 清单组合均为
`sha256:6f461dc833d75d63683994e392d4021492648e41e01878574066a925815492fb`，
协议为 major 10／`sha256:50adbe16528286d868af29e9b81e06fdd5a9ff11f3b50ff9cd2e2761c411e0c8`。
基线包为 `sha256:b45270edd2a4c693b971794c70f092c67e374cae251f0ce1db37673560892d46`（232,053,136 B），
候选包为 `sha256:7efa877389c2bfae845520d69a7b940bd213d84bf290af58e0c0b2ae42b2f444`（232,054,064 B）。

为排除期间并行协议变更，匹配基线也从候选源码构建，仅在 control response 构造处过滤掉可选契约，
使 carrier 走旧的完整 initialize probe；准备包后即逐字恢复生产源码，再启动不可变基线包。
`candidate-managed.rs`、`legacy-managed.rs`、`mode-variants.json` 和准备日志保留了这个唯一行为差异。
启动时的 Git diff 已是恢复后的源码，不能单靠该 diff 标识基线编译输入；以这两份源码及实际包摘要为准。
更早的探索基线因协议／Renderer 不同，仅保存为 `exploratory-baseline.json`，不参与收益比较。
两批顺序执行、没有清空系统文件缓存，首次授权仍包含真实信任按钮操作；以下是描述性结果。

| 场景             | 基线五次启动原值（ms）       | 候选五次启动原值（ms）       | 基线中位数（ms） | 候选中位数（ms） |
| ---------------- | ---------------------------- | ---------------------------- | ---------------: | ---------------: |
| 新配置、首次授权 | 3083、3547、3083、3365、3065 | 6021、3097、3099、2973、3053 |             3083 |             3097 |
| 已授权、后端停止 | 2834、2915、2888、2883、2943 | 2683、2673、2649、2427、2427 |             2888 |             2649 |
| 已授权、复用后端 | 1179、1180、1175、1167、1177 | 1165、1216、1294、1213、1170 |             1177 |             1213 |
| 仅 UI            | 945、914、916、934、915      | 935、908、928、904、908      |              916 |              908 |

每批 20 次启动、15 次文件正文断言及 20 次命令面板断言全部通过，复用组 daemon PID 不变。
基线 15 个后端样本全部走 initialize probe，候选全部走 control 检查，且均无 probe scope 的目录打开或 initialize。
采集器验证同一 nonce／carrier PID／trace ID，并仍要求真实连接的两个阶段；缺记录、混入 probe 或失败样本都会使对照不完整。
额外的日志定位健康查询已移至所有首次功能计时之后，两批保持一致，不以诊断查询预热首次功能。

| 同连接的阶段中位数（ms）           | 新配置基线 | 新配置候选 | 停止后端基线 | 停止后端候选 |
| ---------------------------------- | ---------: | ---------: | -----------: | -----------: |
| carrier ensure-selected            |     1410.9 |      349.5 |       1609.8 |        358.3 |
| carrier daemon-probe／control 检查 |     1062.6 |      0.037 |       1266.5 |        0.037 |
| 服务端 probe 目录打开              |     1061.7 |     未执行 |       1265.4 |       未执行 |
| 服务端真实连接目录打开             |      336.2 |     1296.3 |        357.3 |       1375.2 |
| Main 首写→首回传                   |     1471.3 |     1436.6 |       1667.4 |       1423.7 |

这些区间有嵌套，各列独立取中位数，不能相加。原 probe 也预热了真实连接使用的共享资源，因此省掉约一秒 probe
并未带来同等端到端收益：停止后端组快 239 ms（8.3%），首次授权基本持平，复用组慢 36 ms，UI-only 快 8 ms。
候选第一个新配置样本的 6021 ms 原值完整保留；其中 daemon-start 为 1917.5 ms、ensure-selected 为 2045.0 ms，
真实目录打开为 1296.3 ms。当前记录未解释 daemon-start 的额外等待，不剔除此样本或据此宣称启动长尾已修复。
首次文件打开中位数三组为 95.2→95.2、87.7→86.8、86.4→89.5 ms；
命令面板四组为 151.5→159.4、152.7→154.7、158.3→152.6、108.7→111.1 ms。
保留改动的依据是取消重复无目录 runtime 和停止后端场景的实测收益；它不证明用户反复启动故障的根因已消除。

验证通过 `just verify ash-app-server-daemon`（63 项）、
`just verify ash-app-server --test managed_lifecycle`（8 项）和
`just verify ash-app-server-runtime --filter managed::registry::tests`（16 项），各自的检查及警告检查也通过。
新增回归覆盖无需 listener 的 control 准入、错误 major／schema、execution-only、旧后端回退及完整 probe 缺能力拒绝。
Python scripts 208 项（1 skipped，其中比较文件 15 项）、automation／Renderer 类型检查与本轮 20 文件格式检查通过。
真实 Ash Desktop 另通过打开 Agents、后端停止后重开已授权工作区、复用选中包 daemon 三项；
Windows 专属跨包代次替换在 macOS 跳过，不计通过。

常规 `pretest:smoke:desktop` 首跑被并行设置修改的中文翻译校验
`Unknown translation: zh-CN/ash.settings/chrome.searchResults` 阻塞；
本轮使用正常 `prepare:backend` 和现有生成资源上的 `build/desktop/build.ts all --prepared` 完成相同产物的对照，
不将该结果写成常规前端完整准备通过。首轮 daemon 检查还被并行 `ModelInvocationTiming` 类型未注册阻塞，
其 owner 补齐注册后重验通过；随后新增 socket 测试因 accept 继承非阻塞状态首败，修正测试 fixture 后 63 项全部通过。
首败、修正复验及最终日志均保留在上述证据目录，不以重复运行掩盖失败。

## 2026-10-20 开发自动重载等待诊断

用户将反复出现的“等待／重新打开”提示明确为保存代码后的开发自动重载，恢复独立调查。
该提示有两个入口：Electron 的原生 `unresponsive` 事件，以及 Main 发出关闭／重载请求后 30 秒仍未收到回复。
原先两者均只写 `Window is unresponsive`，旧日志不能区分来源。
本机三个开发会话的同名记录之前均有约 30 秒的 `initialize` 请求超时，但该先后关系不足以证明是同一个生命周期缺陷；
旧记录不含待处理的重载 token 或关闭参与者，仍保留待办，不归因于包 SHA。

当前在原有 owner 上补齐诊断，不改变保存顺序、veto、重试或恢复期限：

- Main 的关闭超时记录包含 window ID、原始 token、reason 和本进程单调时钟等待时长；选择继续等待仍沿用同一 token 和起点。
- 原生窗口日志用 `renderer-unresponsive`／`shutdown-timeout` 区分来源。
- Renderer 接收请求与发送完成时记录 token／reason。生命周期每 10 秒记录尚未完成的 veto、普通 join 和最终捕获标签；已完成的操作不列入，成功、失败及对象释放均清理诊断计时器。

隔离配置、合成文本文件和离线凭证下，真实 Vite／Electron 先完成 5 次直接完整重载，
随后通过保存自有临时 TS 模块触发真实 HMR invalidate → page reload，另完成 5 次。
两个批次都断言未保存正文仍在、原窗口收到各自的关闭请求且没有恢复弹窗；并非用户故障的复现成功。
保存批次另核对 token 1–5 各有接收与发送完成的两条持久日志，关闭阶段在同一窗口日志内为 6、8、5、5、6 ms。
整轮观察时长为 2714、2562、3055、14801、3296 ms，完整保留 14.8 秒样本；
该次关闭阶段仅 5 ms，其余等待仍含文件监听、Vite、页面装载及自动化观察，尚未细分，不把它计作关闭保存阻塞。

证据位于 `.build/ash-playwright-mcp/dev-reload-investigation/`：
`2026-10-21T03-49-18.888Z/` 是直接完整重载批次，
`2026-10-21T03-57-03.765Z/` 是含新诊断的真实保存批次，保留原始 trace、WebM、截图、控制台、请求及窗口日志；
这里的 WebM 是原始录制，没有另制字幕视频。两个批次还出现 code-intelligence 文档同步的 `InvalidParams` 控制台错误，
原值保留，未将上述关闭／内容断言当作所有编辑器功能无错误的验收。
本轮没有修改用户 profile、停止已有开发实例或改动生产文件来制造保存事件；临时 TS 模块由试验独占。

定向单元检查覆盖 Main 生命周期 15 项、CodeWindow 24 项（另 2 项 Windows DPI 用例在 macOS 跳过）和 Renderer 生命周期 22 项。
新增诊断回归先因测试订阅未显式释放触发 leak 检查，补齐 fixture 释放后该文件 22 项通过；首败日志保留。
正常 `node build/desktop/build.ts host`、当前 Renderer 类型检查及 8 个变更文件的格式检查通过；
真实保存批次使用该 Main 和 Vite 直接装载当前 Renderer 源码，后端使用本检出当时选中的开发准备包；该诊断批次不作为后端性能对照。
现有 `development-renderer.spec.ts --grep 'shutdown timeout \(workbench\)'` 的真实 Electron 超时恢复用例另通过一次（33.7 秒）：
故意丢弃旧 Renderer 的关闭投递，验证 30 秒提示、继续等待、重新打开新原生窗口及旧窗口退出；这是受控恢复覆盖，不是用户故障的自然复现。
所有本轮试验窗口、Vite server 和隔离后端均已退出，临时 profile 与合成工作区已回收。

## 2026-10-21 后端发布与页面重载重叠

继续沿用户怀疑的后端保存路径检查，确认了两个可独立复现的问题，没有新增 SHA 校验或放宽构建身份、协议与 lease 检查。

`DevelopmentAppServerReloader` 原先以原生目录 `fs.watch` 监听原子替换的 `current.json`。
本机真实发布两次均没有触发重连，单独的原子替换探针也未收到任何事件；新增默认 watcher 回归在旧实现上 5 秒失败。
现改为对这个小指针每 250 ms 做 `watchFile` stat 轮询，沿用 200 ms 防抖、指针解码、Rust lease 及 profile 唯一重启 owner。
重复发布相同 generation 不重启；Workbench 和 Agents 的实际载体一起停止、只重启一次 daemon，再分别初始化并恢复订阅和目录权限。

另一个受控真实窗口场景在旧实现上稳定失败：保留一个未保存文件，使用正常发布器选择新 generation，
仅延迟实际 carrier stop 的完成通知，在这个窗口发起页面重载，再放行后端替换。
旧 Renderer 收到真实 reload token 后，关闭前备份向 stopped 连接发出请求并失败，Main 显示
`The window could not close because its state was not saved.`；后端约 5 秒后虽已 ready，导航仍被取消，自动化最终 30 秒超时。
这次捕获属于主动保存失败，没有 10 秒 pending 警告或 Main 的 30 秒关闭握手超时。

修复由原有 owner 承担：协议 client 新增有界的初始化等待，使用现有 request timeout（Desktop 默认 30 秒），
ready、到期或 client dispose 时释放等待项与计时器；不会启动连接恢复或改变协议状态。
备份 adapter 在发出操作前等待该 client ready，关闭前 flush 与最终捕获随后沿用原流程。
已发出的写入若丢失回复仍返回原失败，不自动重放，expected revision、冲突和保存失败 veto 保持有效。
单元回归还覆盖仅获取传输但尚未初始化、等待到期后仍可连接、已 stopped 的 client 释放，以及写入丢回复后重连不重放。

本轮使用 macOS arm64、本检出正常 `node build/desktop/build.ts all` 的 Main 与 Renderer，以及既有已准备 Rust generation
`b58b3cb417de89e4eaa38211633dea1386f51a64ac7cffdd04786af8076c4854`。
测试以独占 marker 将这些实际二进制重新发布到隔离 generation store，走真实指针替换、daemon restart、端口和协议初始化；
没有执行一次新的 Rust 源码编译，不能据此给出 Rust 保存到可用的构建延迟结论。
全部 profile、工作区及正文均为独占合成数据，未操作用户开发实例。

首败、修复前源码、原子替换探针、各轮窗口日志、控制台、截图和构建／源码摘要保存在
`.build/ash-playwright-mcp/backend-reload-20261021/`。
正常 Desktop 构建、协议／备份定向单元 70 项、发布监听 11 项、自动化类型与 7 个文件格式检查通过。
最终真实窗口两个场景各重复 5 轮，10 项全部通过（3.6 分钟）：双窗口场景保留 Agents 草稿、确认 daemon PID 改变、
各自只恢复一次目录订阅，并通过真实工作区搜索验证目录权限；重叠重载场景确认未保存正文恢复、daemon PID 改变、
选中 runtime 正确且没有关闭错误提示。完整日志、报告与逐次关闭 token 记录在证据目录的 `final-smoke/`。
对应命令为：

```sh
pnpm test:unit:prepared --run src/ash/platform/agentHost/test/browser/appServerProtocolClient.test.ts --run src/ash/platform/backup/test/browser/appServerBackupService.test.ts
pnpm test:unit:prepared --run src/ash/platform/app-server-daemon/test/electron-main/developmentAppServerReloader.test.ts
node build/desktop/build.ts all
pnpm exec bun check -p test/automation/tsconfig.json --all
pnpm run smoketest-no-compile test/smoke/areas/windows/development-runtime.spec.ts --grep 'Rust publication' --repeat-each=5 --max-failures=1
```

上述定向检查不代表完整仓库或 Windows／Linux 验证通过。
期间仍记录到 debug storage 在 stopped／initializing 状态轮询的错误、语言服务／配置的 `InvalidParams`；本次关闭与内容断言不覆盖这些错误。

这两个已复现缺陷不证明旧日志中的三次原生 Renderer 无响应具有相同原因。
原先“等待／重新打开”仍缺带新来源、token 和 pending 标签的现场配对记录，根 TODO 仅保留这一项，避免把主动保存失败的修复写成所有无响应提示均已解决。
