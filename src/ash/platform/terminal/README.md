# Terminal 进程接入

此目录拥有共享终端契约、启动配置 schema、环境集合纯操作，以及 Renderer 与交互式 PTY 后端之间的协议适配。Shell 进程、授权目录、输出缓冲和重连租约的最终判定由 Rust 后端拥有；这里不保存终端屏幕、Tab 或活动实例。

## 前后端职责

Rust 领域服务拥有完整 Agent loop：模型调用、工具选择与调度、重试、审批和最终权限、执行与恢复。`app-server` 负责协议分发与授权路由；终端资源由 `exec-server` / `utils-pty` 拥有。前端不根据终端屏幕文本调度 Agent 工具，也不建立另一套自动审批规则。

| 职责         | 前端 owner                                                      | Rust owner                                         |
| ------------ | --------------------------------------------------------------- | -------------------------------------------------- |
| Agent 与审批 | 展示工具进度和审批请求，收集并回复用户选择                      | loop、请求有效性、规则、授权与执行                 |
| 终端进程     | 领域客户端与显式操作请求；展示连接和错误                        | PTY、进程环境、信号、退出、输出保留、资源存活策略  |
| 终端屏幕     | xterm、输入交互、选区、搜索、markers、装饰、有限显示回放        | 命令边界、执行结果、cwd 与 Shell metadata 来源判定 |
| 工作台       | Tabs、分屏、焦点、布局、主题、快捷键、无障碍                    | 执行目标和可恢复资源身份                           |
| 扩展与编辑器 | 客户端 provider 对象、text model、dirty buffer、编辑事务和 undo | Agent 调度；调用已注册能力并消费其结果             |

前端的 command/prompt/env capability 是当前屏幕和后端事件的消费模型。xterm cells/cursor 决定显示坐标；执行状态与来源可信度以 Rust 事件为准。Shell 来源可信不等于执行获准。后端需要客户端能力时发出 typed request，前端交给原 editor/Workbench/provider owner 完成并回复，loop 仍在 Rust。

`common/autoApprove/` 的六个上游路径归后端审批链，`common/localPtyChannel.ts` 的 Node channel 职责归现有 Rust transport。它们是已确认的宿主差异，不创建同名 TS 外壳。用户手动终端输入继续通过原 PTY 输入端口；关闭或隐藏视图不自行推断 Agent Turn 的终止策略。

## 当前接线

`common/terminal.ts` 同时提供宿主输出 PTY 的启动配置、进程事件、标题属性和启动/关闭契约，供 `services/terminal/common/embedderTerminalService.ts` 与 Terminal contribution 共享。宿主输出 PTY 不声明输入或工作目录；交互 child process 按真实能力提供 input/processBinary/resize/getCwd。原始字节输入不降级为文本输入。扩展 PTY 的 input/resize 等待 provider 回复，关闭撤回排队与进行中的输入，原始错误传回调用方；Shell 的读取结果保留原始字节，原 ProcessManager 增量解码为标准 string `IProcessDataEvent`，并用 `trackCommit` / `writePromise` 连接 xterm 解析与 Renderer 续读。Shell 的输入与尺寸已走原 Rust 进程链；SIGINT 与服务器输出背压已接入；完整 child process 的通用属性仍待补全，没有添加空操作实现。

| 文件                                             | 职责与生产入口                                                                                                                                                                          |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `common/terminal.ts`                             | 前端进程契约：profile、带真实 PID/启动目录的创建、文本或原始字节输入、尺寸、增量字节输出、关闭和连接状态；退出码使用 `undefined` 表达未知，由 `IRendererHost.terminal` 提供给 Workbench |
| `browser/appServerTerminalProcessService.ts`     | 已连接 Web 的协议适配；通过现有 Renderer protocol client 调用 `terminal/*`，创建 `connectionOwned` 进程                                                                                 |
| `browser/reconnectableTerminalProcessService.ts` | Electron 本地与远程进程适配器：保存和旋转 token，在新 connection generation 或窗口 reload 后 attach 原 PTY，恢复最后尺寸；宿主直接选择这个服务对象                                      |
| `browser/disconnectedTerminalProcessService.ts`  | 无后端的 UI 运行环境明确拒绝进程操作；不创建模拟 Shell                                                                                                                                  |

两个适配器消费同一个 `AppServerProtocolClient`。创建结果的 ready 信息来自 Rust；文本走 `terminal/write`，原始字节只在适配边界编码为 base64 后走 `terminal/writeBinary`，不经过 UTF-8 转换。普通与 SSH 读取都经过同一 DTO 转换入口，在适配边界把 base64 解码为原始 `Uint8Array`，把 nullable 退出码转为前端 `undefined`；多字节字符和控制字节不会经过逐块文本解码。重连租约管理复用该 client 的状态和代次，只恢复已有 PTY，不自行建立连接。Main 负责 connection acquisition、透明 relay、运行时更换通知和通用窗口级内存 SecretStorage，不解析 `terminal/*`，也不拥有终端会话状态。

`terminalId` 与 `dirId` 一起定位对应后端资源；多根 Workspace 必须保留创建时的 `dirId`。Web 的 `connectionOwned` 进程随 connection 关闭而结束。Electron 本地与远程的 `reconnectable` 进程在连接断开后由同一后端保留 30 秒，成功 attach 会旋转 token；后端进程重启、租约过期或明确 runtime replacement 后不能恢复原 PTY。token 平时只归 Renderer 进程适配层；协调 reload 时通过窗口级内存 SecretStorage 短期交接；跨窗口时先由 Rust 原子 detach 撤销源访问、旋转 token，再经 Main 内存交给指定同工作区／执行宿主窗口，目标失败可返回新 lease 回滚。实际窗口关闭清空内存凭据，不写入普通工作区存储、设置或日志。屏幕和布局 checkpoint 由 Workbench 原 owner 保存，不能代替后端租约。

`common/terminal.ts` 导出 `ITerminalProcessService` 的 DI 标识。Workbench 与 Sessions 注册 `IRendererHost.terminal` 后，Terminal contribution 经容器注入进程服务与 Workspace。SSH 宿主直接使用拥有租约管理的服务对象。传输层使用 Ash 的创建与分页读取契约；`contrib/terminal/browser/terminalProcessManager.ts` 将其接为输出、命令和退出事件，拥有游标与解析等待。适配层与工作台之间的身份和顺序约束见 [Terminal 运行契约](../../../../docs/terminal.md#进程接入)。

后端链路是 `app-server/src/server/request_processors/terminals.rs` → `exec-server/src/terminal.rs` → `utils/pty`；App Server 只校验和分发协议，`exec-server` 拥有交互进程，PTY 工具层拥有操作系统句柄、原始字节、尺寸和进程终止。协议及 decoder 由 `app-server-protocol` 生成，不能在此手改生成物。

创建与恢复后的操作仍属于发起时的 owner。dispose、runtime replacement 或关闭使等待中的操作失效；恢复完成后、实际发送请求前再次核对原记录与 connection generation，读取与属性查询的迟到回复也不发布。关闭只处理当前登记的身份，退休或未知身份不会转发到新宿主。晚到的 create／attach 成功结果只通过原连接回收，不能登记成新租约。

重连测试位于 `test/browser/reconnectableTerminalProcessService.test.ts`，覆盖 Renderer 的租约旋转、连接代次、二进制输出和目录路由；旧 Electron Main 测试路径已按用户确认退出。

`getEnvironment(names, dirId?)` 通过 `terminal/environment/read` 查询选定执行宿主的冻结终端环境，最多 128 个变量；查询不创建进程，不读取 Renderer 或客户端机器的环境。缺失项省略，配置解析器将其替换为空字符串。后台仍采用已有环境白名单，不返回无关进程凭证。目录执行授权撤销后查询失败。

终端创建支持可选 `env`：字符串覆盖子进程环境，`null` 删除继承变量；最多 128 项，变量名最多 256 字符且不能包含 `=`/NUL，值最多 32768 字符且不能包含 NUL。Rust 在分配 PTY 前校验；应用于冻结环境的副本，后续终端不受影响。TerminalService 在首次创建前捕获调用方对象，TerminalInstance 重启复用同一快照。Tasks 和 DAP `runInTerminal` 共用此契约。

进程适配与实例、屏幕、窗口生命周期的协作见 [Terminal 职责与运行契约](../../../../docs/terminal.md)。

扩展环境集合的边界解码由 `common/environmentVariableShared.ts` 拥有，callback 与持久化读取共用同一个入口。`common/environmentVariableCollection.ts` 提供 `MergedEnvironmentVariableCollection`，捕获启动时的独立快照并原子应用 Replace/Append/Prepend；标准 apply 接收 env/scope/resolver；调用方先补被修改键的 inherited 值，合并快照的 constructor 确定执行宿主大小写规则。Workbench EnvironmentVariableService 保留 provider 生命周期、同步与持久化，ProfileResolver 组合启动环境后交给原 Rust 创建请求；平台不反向导入 Workbench。

启动配置 schema 由 `common/terminalPlatformConfiguration.ts` 的 `registerTerminalPlatformConfiguration()` 唯一注册，Workbench 入口仅调用它并注册自己的屏幕/增强设置。原键名、默认值、校验与配置存储保留；Node/Electron PTY host 不由前端建立，进程执行仍属于 Rust。

能力模型的跨层状态归属见 [输出与命令状态](../../../../docs/terminal.md#输出与命令状态)。`TerminalCapabilityStore` 登记真实实现，`CwdDetectionCapability` 拥有已提交目录，`BufferMarkCapability` 管理同一 xterm 屏幕的 markers；Rust 继续拥有命令解析、nonce 与 history。marker 契约采用 DOM 无关结构，Common 不引入 xterm 类型包的 DOM globals。

`TerminalDataBufferer` 接原扩展 PTY 的文本源，在初始 open、name、exit 和 shutdown 前排空。ProcessManager 仍唯一拥有 Shell 的读取游标、增量 UTF-8 解码、输入队列和解析等待；断线续读保留不完整字符前缀，输出 gap 重置状态，退出前排空尾部。普通/SSH 协议适配器继续保留原始读取字节和二进制输入。`afterSequence` 是屏幕完成解析后的消费确认；Rust 在未确认输出达到高水位时暂停读取 PTY channel，确认前进后恢复。最近历史仍有界，持久重播不包含在此机制内。

`terminalProfiles.ts` 由真实 ProfileService/schema 消费。`terminalRecorder.ts` 和 `terminalProcess.ts` 的 ReplayEntry 只承接首次 screen 装载前的有限显示回放，保存尺寸并按 xterm write callback 排序；它们不替代 Rust 的输出保留或持久进程恢复。Tasks 消费 `terminalStrings.ts` 的 ANSI 格式，纯环境 helpers 按实际 shell 类型引用字面路径并规范化 cwd。

能力 store multiplexer 合并原 process/screen store，并通过 disposable lease 控制登记生命周期。PartialCommandDetection 只由可输入的 xterm screen 登记，负责 Enter 回退导航位置；Shell history 仍在 Rust。NaiveCwdDetection 供 Split 查询真实 `terminal/processInfo`，无 shell cwd 时优先使用查询结果，失败才采用创建时目录。查询不会创建另一个进程；开始关闭或执行宿主被替换后，迟到 cwd 不能供 Split 使用。

PromptType 的 producer 与 parser 都在 exec-server；App Server 和两个前端协议适配器只映射可选字段。原 command source 等关联 byte sequence 完成 screen commit 后才更新 PromptTypeDetectionCapability，字段不参与 nonce 信任或审批。三个 Browser 适配器只补本批必要端口，迁移、收敛和删除仍后置。

`strictEnv` 已贯穿扩展 profile、启动快照、首次创建/重启与 Rust spawn。严格模式仅采用显式非 null 环境值，不展开 env 中的配置变量，不合入配置、profile 或扩展 mutations；Rust 从空环境开始应用 overrides。PTY 工具不再在清空后补回 SHELL；普通启动仍采用原冻结宿主环境。当前服务端 startup wrapper 的必要控制变量仍由 Rust 拥有。
