# Terminal 界面与贡献

此目录拥有终端实例契约、窗口内实例管理及界面。Shell 进程和授权由 Rust 后端拥有，经 [platform/terminal](../../../platform/terminal/README.md) 的进程契约访问；contribution 不导入生成协议。

| Owner                                                     | 职责                                                                                                                             |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `browser/terminal.contribution.ts`                        | Terminal 实例服务注册、View、聚焦命令，以及 links、voice 贡献的装载入口                                                          |
| `browser/terminalMainContribution.ts`                     | BlockStartup 时订阅宿主 PTY 创建通知，交给现有实例服务并显示 Terminal View                                                       |
| `browser/terminal.ts`                                     | `ITerminalService`、实例、profile、尺寸及前端事件契约                                                                            |
| `browser/terminalService.ts`                              | 窗口实例列表、顺序、活动项；每实例输入队列、创建/关闭、连接状态与进程管理器生命周期                                              |
| `browser/terminalProcessManager.ts`                       | 每个 Shell 的增量读取、输出/命令游标、分页排空、命令事件排序、解析等待与读取取消                                                 |
| `browser/terminalView.ts`                                 | View 内容、实例 Tab、活动项呈现、profile 选择和实例 Widget 生命周期；隐藏 View 保留实例和 Widget                                 |
| `browser/instance/terminalInstanceWidget.ts`              | 每实例一个 xterm：ANSI/VT 解析、网格、光标、scrollback、选择、输入编码、fit 与输出标记；从实例事件消费字节并向实例发送输入与尺寸 |
| `browser/instance/alternateScroll.ts`、`terminalTheme.ts` | 当前 Widget 的 alternate-screen 滚动行为与主题转换，不保存后端进程状态                                                           |
| `browser/view/*`                                          | 实例列表布局、标题动作和 profile 图标；布局不成为实例列表 owner                                                                  |
| `common/terminalColorRegistry.ts`                         | Terminal 颜色 token 注册；不能以同路径文件存在代表上游完整 API                                                                   |
| `terminalContrib/links`                                   | 检测 URL 的用户命令；当前扫描与 Quick Pick 由 Widget 实现，真实打开委托 Opener                                                   |
| `terminalContrib/voice`                                   | 终端语音输入会话与用户动作；消费 `ITerminalService` 和已有 dictation 服务，不直接写 PTY 协议                                     |

桌面链路是 Widget 的 onData/onBinary → `ITerminalInstance.write`/`processBinary` → `ITerminalProcessService.write` → Renderer protocol client → MessagePort → Main 透明 relay → App Server → `exec-server` → PTY。输出走相反方向，屏幕只有 xterm 一份 owner；Rust Desktop 的终端网格属于另一个产品，并不作为 Electron 屏幕的后端副本。

Shell 实例从平台契约消费原始字节和前端退出码，不解析生成 DTO 或 base64。`TerminalProcessManager` 拥有轮询与两个读取游标，实例转发 `IProcessDataEvent`。Widget 同步设置 `writePromise`，只在 xterm write 回调中完成；管理器等待解析后才续读、发布对应命令完成和退出。没有屏幕消费者的 Shell 不制造解析确认，命令状态仍可供 Tasks 使用。已退出进程的输出和命令流均排空分页后才报告退出；未来输出对应的命令事件留在管理器中等待。

宿主提供的输出 PTY 从 `services/terminal/common/embedderTerminalService.ts` 经 `TerminalMainContribution` 接入同一个实例列表。实例先登记、发布再打开 PTY，保留界面订阅前的输出和退出；标题直接跟随宿主改名，后端连接变化不影响宿主 PTY。xterm 禁止输入，语音输入不启动；关闭与 Relaunch 使用宿主的生命周期，不请求 Rust Shell，也不要求打开 Workspace folder。宿主 PTY 无 OS 子进程，PID 使用 `-1`，cwd 为空。

当前已有多实例、输入、主题、Tab、标题动作、URL 与语音能力。终端专属 Accessible View、帮助、verbosity 设置、Find、命令历史、Quick Fix、Sticky Scroll、扩展提供 PTY、编辑区终端与真正的分组分屏尚未接通；不能根据 xterm 可用或上游文件名相同宣称完成这些贡献。后续每项贡献须先找到当前生产消费者、唯一状态 owner 与下层服务契约，再在对应路径实现，并通过键盘、焦点、非默认语言和真实 Playwright 状态断言验证。

完整文件对应关系、仅 Ash 文件及实施准入见 [Terminal 对齐台账](../../../../../docs/terminal-api-alignment-status.md)。本目录说明现有职责，不授权移动、删除或批量创建上游文件。

## 实例与创建生命周期

Workbench 与 Sessions 核心入口注册所选 `ITerminalProcessService`；共同加载的 Terminal contribution 声明依赖并经容器 `createInstance(TerminalService)` 创建窗口唯一实例服务。缺少进程或 Workspace 注册时，创建立即失败。Terminal View、Tasks、Debug、Testing View 和 voice 消费同一个公开实例契约；共享 services 不导入它。

| 行为       | 当前约定                                                                                                                                                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 创建       | 验证 Workspace folder；多根窗口保存选定 `dirId`；后端返回真实 profile、PID 与启动目录 后才公布实例；`onDidCreateInstance` 在启动轮询之前触发，界面可先订阅输出；窗口已释放时关闭晚到的 PTY 并取消创建；创建和 Relaunch 开始读取前查询窗口的当前连接状态 |
| 列表事件   | 创建、释放和移动均触发 `onDidChangeInstances`；事件到达时列表、顺序、标题与活动项已更新，创建的初始连接状态已应用                                                                                                                                       |
| 输入与尺寸 | 文本与二进制共用发送队列，二进制前先发送全部待处理文本批次；UTF-8 单批不超过 60 KiB；尺寸在微任务内合并；断线时丢弃尚未发送的输入，恢复后不回放                                                                                                         |
| 读取       | 管理器按输出和命令的独立 sequence 续读；有屏幕时等待真实解析；命令事件按 `afterOutputSequence` 发布，分页未排空时不报告退出；后端输出缺口明确提示截断                                                                                                   |
| 本地断线   | `connectionOwned` 实例进入 `disconnected`，连接重新 ready 不自动创建或恢复 Shell；创建或 Relaunch 返回前已断线时同样适用，不发起读写                                                                                                                    |
| SSH 断线   | `reconnectable` 实例进入 `reconnecting`；连接 ready 后开始续读，首次成功读取才进入 `running`；创建或 Relaunch 返回前已断线时先保持 reconnecting；恢复失败进入 `error`，由用户 Relaunch                                                                  |
| 退出与关闭 | 进程退出保留实例与屏幕；close 立即停止输入和读取，同一实例的并发 close 等待同一后端释放结果，完成后移出实例；直接 dispose 同步移出实例并开始关闭 PTY；窗口不持有已释放实例；隐藏 Panel 保留实例                                                         |
| Relaunch   | 保留 UI 实例身份，创建新 PTY，更新 PID/启动目录并重置两个游标；并发请求合并为一次重启，采用首个请求尺寸；创建期间关闭实例或窗口，关闭晚到的 PTY，close 等待这次清理；创建失败可重新尝试                                                                 |

已有 Shell 首次输出会加载 xterm 进行解析，包括隐藏实例，避免后台 Tasks 等待显示面板才完成；隐藏实例仍不显示、不抢焦点。没有进程的隐藏面板仍不读取 profile、创建 Shell 或加载 xterm。解析等待在断线或关闭时取消；同一 Shell 恢复时先等原屏幕写入，保留已提交字节的游标；Relaunch 更换管理器，旧解析回调不影响新进程。

解析确认约束 Renderer 的续读，不阻塞 Rust 的 OS PTY drainer；后端 bounded ring 仍可能截断超过历史上限的输出，并通过 outputGap 显式报告。完整服务器 flow control 仍待实现。

公开契约目前承接 Ash 已有行为；与 VS Code 完整 backend、child process、profile/configuration、group 和 editor terminal API 仍有差异。本批完成对应 owner 与实例装配，不能记为整个 Terminal API 已对齐。
