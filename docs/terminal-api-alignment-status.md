# Terminal API 对齐状态

## 职责边界

Agent loop 全部由 Rust 后端拥有。前端保留 Workbench 交互、屏幕模型和领域客户端，具体边界定义在 [Platform Terminal README](../src/ash/platform/terminal/README.md#前后端职责)。文件清单用来定位职责，不表示公开契约或行为完成率。

用户已确认：六个 `common/autoApprove/` 路径按后端审批 owner 的宿主差异处理；`common/localPtyChannel.ts` 按 Rust PTY transport 的宿主差异处理。这七项不创建前端空壳，也不计为已实现的 TypeScript 文件。审批行为的缺口回到 Rust action-policy / execpolicy / 工具执行链验证；PTY 行为的缺口回到 Rust terminal / utils-pty 验证。前端审批只展示后端请求、收集人类选择并回复，Rust 校验请求仍有效后执行。

三个平台 Browser 适配器沿用既有确认，仅补当前调用方需要的端口和元数据映射；迁移、收敛和删除仍后置。

## Platform Terminal 文件清单与接线

只读参照 `../vscode/src/vs/platform/terminal`。生产 TS/CSS 排除 test：双方同路径 **25**、仅 Ash **3**、仅 VS Code **21**；Common 为 **25 / 32**，七个差异路径均已有上述归属决定。Workbench Terminal 为双方同路径 **89**、缺失 **0**、仅 Ash **0**；这只说明文件落位。

| 平台相对路径                                                       | 文件关系         | 当前职责、接线或缺口                                                                                                                                                                     |
| ------------------------------------------------------------------ | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser/appServerTerminalProcessService.ts`                       | 仅 Ash（已确认） | 已确认 Ash 专属；本地 Electron/已连接 Web 通过 Renderer protocol client 调用 Rust PTY。                                                                                                  |
| `browser/disconnectedTerminalProcessService.ts`                    | 仅 Ash（已确认） | 已确认 Ash 专属；无 App Server 宿主时明确拒绝操作。                                                                                                                                      |
| `browser/reconnectableTerminalProcessService.ts`                   | 仅 Ash（已确认） | 已确认 Ash 专属；SSH Renderer 独有 lease/token/generation owner；Main 只 relay 与 runtime replacement 通知。                                                                             |
| `common/autoApprove/autoApproveParseSafety.ts`                     | 仅 VS Code       | 已确认宿主差异：命令安全解析与自动审批归 Rust action-policy / execpolicy；不建立前端规则副本。                                                                                           |
| `common/autoApprove/cmdDelayedExpansion.ts`                        | 仅 VS Code       | 已确认宿主差异：命令安全解析与自动审批归 Rust action-policy / execpolicy；不建立前端规则副本。                                                                                           |
| `common/autoApprove/gitAutoApproveRules.ts`                        | 仅 VS Code       | 已确认宿主差异：命令安全解析与自动审批归 Rust action-policy / execpolicy；不建立前端规则副本。                                                                                           |
| `common/autoApprove/powershellAutoApproveRules.ts`                 | 仅 VS Code       | 已确认宿主差异：命令安全解析与自动审批归 Rust action-policy / execpolicy；不建立前端规则副本。                                                                                           |
| `common/autoApprove/sedFileWriteParser.ts`                         | 仅 VS Code       | 已确认宿主差异：命令安全解析与自动审批归 Rust action-policy / execpolicy；不建立前端规则副本。                                                                                           |
| `common/autoApprove/sortAutoApproveRules.ts`                       | 仅 VS Code       | 已确认宿主差异：命令安全解析与自动审批归 Rust action-policy / execpolicy；不建立前端规则副本。                                                                                           |
| `common/capabilities/bufferMarkCapability.ts`                      | 双方都有         | DecorationAddon 登记原 screen markers；创建、借用、替换、trim 与释放共用唯一模型。                                                                                                       |
| `common/capabilities/capabilities.ts`                              | 双方都有         | 进程与屏幕 capability 的共同契约；命令执行与来源可信度来自 Rust，markers/input/output range 由 screen 拥有。                                                                             |
| `common/capabilities/commandDetection/promptInputModel.ts`         | 双方都有         | 解析后的 cells/cursor 输入模型：Unicode、ghost、右提示、续行、interrupt 和序列化；无键盘编辑模拟或第二套 parser。                                                                        |
| `common/capabilities/commandDetection/terminalCommand.ts`          | 双方都有         | 屏幕命令/partial command：真实 markers、时间/ID、输出范围与匹配、持久化可序列化坐标；不替代 Rust history。                                                                               |
| `common/capabilities/commandDetectionCapability.ts`                | 双方都有         | 屏幕命令周期、当前输入/已提交执行状态、marker lifetimes、clear/gap/reuse 与 serialize/deserialize；backend 状态仍在原 source。                                                           |
| `common/capabilities/cwdDetectionCapability.ts`                    | 双方都有         | 已提交 cwd/trust/访问目录集合；原 command source 更新，Rust 仍拥有实际 cwd 与 nonce 判定。                                                                                               |
| `common/capabilities/naiveCwdDetectionCapability.ts`               | 双方都有         | Split 在无 shell cwd 时查询真实 processInfo；模型释放后丢弃迟到更新。                                                                                                                    |
| `common/capabilities/partialCommandDetectionCapability.ts`         | 双方都有         | xterm 普通 buffer Enter 的回退导航 marker；erase/trim/屏幕释放退订，不猜测命令文本或状态。                                                                                               |
| `common/capabilities/promptTypeDetectionCapability.ts`             | 双方都有         | Rust PromptType 经 output sequence commit 发布；仅显示身份；screen prompt input 由独立 PromptInputModel 消费实际 cells/cursor。                                                          |
| `common/capabilities/shellEnvDetectionCapability.ts`               | 双方都有         | 原子 env 事务与累计 nonce 信任；未结束不发布，abort 撤回；Send Sequence 消费已提交且可信快照。                                                                                           |
| `common/capabilities/terminalCapabilityStore.ts`                   | 双方都有         | 可变 store、专用事件与 multiplexer 已接 process/screen，lease 与优先级覆盖测试通过。                                                                                                     |
| `common/environmentVariable.ts`                                    | 双方都有         | 标准 variable/scope/description/diff/apply 契约已接；process-creation / shell-integration phase options 已贯穿 SDK、resolver 与 Rust startup wrapper。                                   |
| `common/environmentVariableCollection.ts`                          | 双方都有         | 启动时 immutable snapshot、scope 优先级、diff 和原子 apply，执行宿主大小写由 constructor 确定。                                                                                          |
| `common/environmentVariableShared.ts`                              | 双方都有         | 扩展/持久化唯一解码与标准序列化；旧快照规范化、opaque scope key 与 URI 边界校验。                                                                                                        |
| `common/localPtyChannel.ts`                                        | 仅 VS Code       | 已确认宿主差异：Renderer protocol client → Rust terminal dispatch → PTY；不建立 Node IPC channel。                                                                                       |
| `common/requestStore.ts`                                           | 双方都有         | 原 extension profile bridge 的 callback 配对、超时、同步回复和释放；不共享或复制 transport request IDs。                                                                                 |
| `common/terminal.ts`                                               | 双方都有         | 部分契约；实际服务由 Renderer host 提供，Workbench/Sessions 注册。child process 输入按真实 capability 接线；通用属性、signal 的前端消费者、服务端 flow control、持久恢复未完整接入。     |
| `common/terminalDataBuffering.ts`                                  | 双方都有         | 扩展 PTY 的文本合并与 drain；Shell 输出仍由 Rust ring + 原 ProcessManager 分页/解析等待。                                                                                                |
| `common/terminalEnvironment.ts`                                    | 双方都有         | Tasks/Debug literal shell path quoting 与 resolver sanitizeCwd；collapseTildePath 仍未接真实调用；strictEnv 已贯穿真实 Rust spawn。                                                      |
| `common/terminalLogService.ts`                                     | 双方都有         | 终端日志 scope、当前 Workspace trace 标签、level/event 和原持久化 flush；Root 在 Workbench/Sessions 注册真实 logger factory。                                                            |
| `common/terminalPlatformConfiguration.ts`                          | 双方都有         | 通用 launch schema 唯一注册，原 Workbench 入口调用；保留原配置键、默认与校验。                                                                                                           |
| `common/terminalProcess.ts`                                        | 双方都有         | 真实 display replay 消费 ReplayEntry；完整 process details/config/layout 仍待接线。                                                                                                      |
| `common/terminalProfiles.ts`                                       | 双方都有         | 动态 schema enums、args 比较和 ThemeIcon/URI icon 比较供 ProfileService 消费。                                                                                                           |
| `common/terminalRecorder.ts`                                       | 双方都有         | 有限 screen display replay，保存 geometry、文本与 ordered metadata；不等同服务端持久恢复。                                                                                               |
| `common/terminalStrings.ts`                                        | 双方都有         | Tasks 启动提示消费 ANSI formatMessageForTerminal，保留 NLS 文本与正确换行。                                                                                                              |
| `common/xterm/shellIntegrationAddon.ts`                            | 双方都有         | 消费已提交的 Rust shell boundaries 并登记 screen command/env/mark 模型；无 TS OSC parser，nonce 与权威 history 留 Rust。                                                                 |
| `electron-main/electronPtyHostStarter.ts`                          | 仅 VS Code       | 不启动 Electron PTY host；Desktop 通过既有连接层获取 Rust App Server。                                                                                                                   |
| `node/childProcessMonitor.ts`                                      | 仅 VS Code       | 执行端职责由 crates/exec-server/src/terminal.rs、crates/exec-server/src/terminal/shell_integration.rs 与 crates/utils/pty 拥有；不引入 Node PTY 实现，也不据此声称该上游契约已完整支持。 |
| `node/heartbeatService.ts`                                         | 仅 VS Code       | 执行端职责由 crates/exec-server/src/terminal.rs、crates/exec-server/src/terminal/shell_integration.rs 与 crates/utils/pty 拥有；不引入 Node PTY 实现，也不据此声称该上游契约已完整支持。 |
| `node/nodePtyHostStarter.ts`                                       | 仅 VS Code       | 执行端职责由 crates/exec-server/src/terminal.rs、crates/exec-server/src/terminal/shell_integration.rs 与 crates/utils/pty 拥有；不引入 Node PTY 实现，也不据此声称该上游契约已完整支持。 |
| `node/ptyHost.ts`                                                  | 仅 VS Code       | 执行端职责由 crates/exec-server/src/terminal.rs、crates/exec-server/src/terminal/shell_integration.rs 与 crates/utils/pty 拥有；不引入 Node PTY 实现，也不据此声称该上游契约已完整支持。 |
| `node/ptyHostMain.ts`                                              | 仅 VS Code       | 执行端职责由 crates/exec-server/src/terminal.rs、crates/exec-server/src/terminal/shell_integration.rs 与 crates/utils/pty 拥有；不引入 Node PTY 实现，也不据此声称该上游契约已完整支持。 |
| `node/ptyHostService.ts`                                           | 仅 VS Code       | 执行端职责由 crates/exec-server/src/terminal.rs、crates/exec-server/src/terminal/shell_integration.rs 与 crates/utils/pty 拥有；不引入 Node PTY 实现，也不据此声称该上游契约已完整支持。 |
| `node/ptyService.ts`                                               | 仅 VS Code       | 执行端职责由 crates/exec-server/src/terminal.rs、crates/exec-server/src/terminal/shell_integration.rs 与 crates/utils/pty 拥有；不引入 Node PTY 实现，也不据此声称该上游契约已完整支持。 |
| `node/terminalContrib/autoReplies/autoRepliesContribController.ts` | 仅 VS Code       | 未接入自动回复场景；当前无前端生产调用方。                                                                                                                                               |
| `node/terminalContrib/autoReplies/terminalAutoResponder.ts`        | 仅 VS Code       | 未接入自动回复场景；当前无前端生产调用方。                                                                                                                                               |
| `node/terminalEnvironment.ts`                                      | 仅 VS Code       | 执行端职责由 crates/exec-server/src/terminal.rs、crates/exec-server/src/terminal/shell_integration.rs 与 crates/utils/pty 拥有；不引入 Node PTY 实现，也不据此声称该上游契约已完整支持。 |
| `node/terminalProcess.ts`                                          | 仅 VS Code       | 执行端职责由 crates/exec-server/src/terminal.rs、crates/exec-server/src/terminal/shell_integration.rs 与 crates/utils/pty 拥有；不引入 Node PTY 实现，也不据此声称该上游契约已完整支持。 |
| `node/terminalProfiles.ts`                                         | 仅 VS Code       | 执行端职责由 crates/exec-server/src/terminal.rs、crates/exec-server/src/terminal/shell_integration.rs 与 crates/utils/pty 拥有；不引入 Node PTY 实现，也不据此声称该上游契约已完整支持。 |
| `node/windowsShellHelper.ts`                                       | 仅 VS Code       | 执行端职责由 crates/exec-server/src/terminal.rs、crates/exec-server/src/terminal/shell_integration.rs 与 crates/utils/pty 拥有；不引入 Node PTY 实现，也不据此声称该上游契约已完整支持。 |

## Common 已接通的行为

- 环境集合：扩展 SDK scoped view / options / descriptions → 平台唯一边界解码 → Workbench 集合持久化与快照 → scope/diff/原子 apply → ProfileResolver → Rust spawn。process-creation mutations 在启动前应用；shell-integration mutations 经标准 `VSCODE_ENV_REPLACE/PREPEND/APPEND` metadata 交给 Rust，在用户 RC 后按字面值应用，不执行插值或 eval。`strictEnv` 只采用显式字面环境，Rust 不解释该模式中的 metadata 字段。
- Profiles 与配置：ProfileService 消费 args/icon 比较，动态 schema 消费 profile enums；平台唯一注册 launch schema。未知持久化 profile 保留现有 fallback。
- 输出与屏幕：Rust 输出和 typed Shell boundaries 共享 sequence；适配器保留 bytes，ProcessManager 唯一增量解码并等待 xterm write commit。有限 TerminalRecorder 保存 geometry 与 metadata 顺序，不替代服务端输出保留或持久恢复。
- 屏幕能力：ShellIntegrationAddon 消费已提交事件；CommandDetection / PromptInputModel / TerminalCommand 拥有 markers、输入、宽字符、ghost、右提示、续行和输出范围。gap、trim、clear、reuse 与 storage-disabled 撤回相应屏幕状态。Rust 继续拥有 OSC parser、nonce 判定、执行状态与权威 history。
- cwd / PromptType / env：cwd 查询回到原 `terminal/processInfo`；PromptType 与实际 Shell 类型由 Rust producer 发布。Shell env 使用完整或增量事务，来源可信度来自 Rust；Send Sequence 消费已提交且可信的 env，否则使用原执行宿主环境。来源可信不授予执行权限。
- 客户端输入：`ITerminalChildProcess.processBinary` 由真实输入 owner 消费；text-only/output-only provider 不声明该能力。扩展 PTY 输入和 resize 等待原 provider 确认，失败传回原调用方；关闭拒绝排队及进行中的输入，迟到回复不发布输出，正常确认可以同时报告退出。cwd 查询在关闭或执行宿主替换后撤回结果。
- 日志与请求：TerminalLogService 使用 host logger scope、level/event 与真实 flush；RequestStore 关联 extension profile 的领域 callback/deadline，不复制协议 pending map。超时或撤回取消 provider，迟到 PTY 经原关闭端口回收。
- Tasks / Debug：共用原 Rust 进程启动、literal shell path quoting 与配置环境；Tasks 消费标准 ANSI 提示格式。客户端 PTY API 和 provider 对象留在其原 owner，Agent 工具调度不进入前端。

## 待接入契约

- 完整通用 process property、child-process/backend port 需按实际消费者补齐。`terminal/sendSignal` 的后端实现已存在，当前没有前端生产调用方；不预建无调用方端口。
- 服务端 flow control / ACK 需闭合执行端产出、解析确认和后端背压；现有分页读取、解析等待、有界 ring 不表示这些契约已完成。
- 跨窗口或重启恢复需后端持久资源身份、进程列表、detach/attach、输出恢复及屏幕重建。当前本地 connection-owned 进程与 SSH 30 秒租约各自保持原生命周期，不冒充持久恢复。
- 尚无消费者的通用 layout/process details、自动回复和其他公开端口不预建模块。后续新增消费者时先确认唯一 owner 与可观察结果，再补对应契约。

## 已执行的迁移与验证

平台环境合并算法已回到 `common/environmentVariableCollection.ts`；上游存在的 Workbench `common/terminalEnvironment.ts` 保留，继续拥有启动 override 解析。已确认的重连测试从 `test/electron-main/reconnectableTerminalMainService.test.ts` 迁至 `test/browser/reconnectableTerminalProcessService.test.ts`，旧测试路径退出。

本轮 macOS 验证：正常 `pnpm test:unit` 选择 TerminalService / TerminalBackend / TerminalProcessExtHostProxy / TerminalConfigurationService 四文件，**137 项通过**；Common **2458** 文件、Renderer **3863** 文件类型检查通过。修复正常准备入口中重复的中文翻译、失效的听写翻译、重复 Chat imports，以及共享 URLSearchParams 声明缺少已使用标准成员的问题。

正常浏览器入口的全 fixture 类型检查在范围外 `chatTranscript.integration.ts` 的 diagnostic code 类型、`textModel.integration.ts` 的 SyntaxToken fixture 上失败。终端切片继承原浏览器 compiler options 的 **2504** 文件检查通过；原 `test/integration/browser/run.ts` 执行 Chromium **3 场景通过**：粘贴与原始键盘输入、重新附着只订阅一次、鼠标原始高字节。没有将全浏览器类型检查记为通过。受影响 TS formatter、文档/NLS JSON Prettier 和 diff whitespace 检查通过。

本轮未修改 Rust、协议、平台 Browser adapters 或视觉样式，也未声明 Electron、真实 SSH、Windows/Linux PTY 或 PowerShell runtime 验证。
