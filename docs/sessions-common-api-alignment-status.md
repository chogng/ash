# Sessions common 对齐状态

本地范围为 `src/ash/sessions/common/`，只读参照为
`../vscode/src/vs/sessions/common/`，参照提交为
`fb4de2eb1bcadf786cf3e71df860d814f7ef4bfb`。
17 个上游同路径文件现在均有本地载体。下表记录已闭合的 Ash 调用链；
文件存在不代表上游全部公开 API、设置或行为已经实现。

## 已接入的调用链

| common 文件                       | 底层契约与生产调用链                                                                                                                          | 状态 owner                                                           |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `sessionCommands.ts`              | Files 命令注册、Add tab 菜单、布局操作队列共用公开命令标识                                                                                    | 命令注册表与布局控制器                                               |
| `sessionLinks.ts`                 | GitHubService 合并发现和保存的 PR；比较键与原始打开 URL 分开                                                                                  | GitHubService                                                        |
| `categories.ts`                   | ICommandAction.category → 命令注册 → Command Palette 的中文标题与英文搜索别名                                                                 | 命令注册表                                                           |
| `chatLayout.ts`                   | 配置/手机状态 → 生命周期内稳定的 presentation/owner 快照 → 既有布局队列                                                                       | BaseLayoutController                                                 |
| `sessionConfig.ts`                | 单一 IConfigurationRegistry 设置 → Sessions Appearance → 按 Session / Chat 保存文档及可见性                                                   | 共享配置服务与既有布局存储                                           |
| `dockedEditorInput.ts`            | Files/Changes 输入 → ExcludeFromEditorLimit → EditorGroupModel 与 GroupView 共用替换选择                                                      | EditorGroupModel；内容资源由 pane 释放                               |
| `sessionApplication.ts`           | Session 领域描述 → App Server 目录 adapter → Chat History 应用标签                                                                            | Session 目录来源；当前表示服务目录的 Ash 应用                        |
| `workspaceSelection.ts`           | 选择来源/历史状态快照 → 可取消的 WorkspaceSelection Quick Pick → 草稿执行目标                                                                 | 单个 picker 生命周期；历史仍由 IWorkspacesService 拥有               |
| `agentHostSessionsProvider.ts`    | 连接状态领域契约 → AppServerSessionsProvider → SessionsManagementService 的 loading/error/reload                                              | App Server 连接与 Provider                                           |
| `agentHostSessionWorkspace.ts`    | 本地/SSH/Provider 目标与 hydrated Thread directory → workspace 领域快照和无歧义缓存键                                                         | Session/Thread 后端目录事实                                          |
| `devContainerAgentHostService.ts` | Sessions 命令 → 可取消领域 service → 生成 RPC adapter → profile Provider → Docker/Dev Container CLI → managed gateway → 容器内共享 App Server | Docker 拥有容器；Provider 拥有启动策略；核心拥有授权、路由及连接释放 |
| `sizes.ts`                        | 浮动面板间距 → 现有 layoutPolicy                                                                                                              | 单个实际尺寸常量                                                     |
| `welcome.ts`                      | durable 目录 → profile welcome-complete 标记 → empty view；草稿不标记完成                                                                     | 既有 profile storage                                                 |
| `sessionsTelemetry.ts`            | 返回 Workbench 的实际操作 → host telemetry policy → 分类事件                                                                                  | 原有 ITelemetryService；不启用新的采集目的地                         |
| `contextkeys.ts`                  | 导航历史菜单条件                                                                                                                              | Sessions 服务；保留原实现                                            |
| `layoutConstants.ts`              | Part 标识与侧栏尺寸                                                                                                                           | 既有布局；保留原实现                                                 |
| `theme.ts`                        | Sessions 专属颜色注册                                                                                                                         | 主题服务；保留原实现                                                 |

## Docker Provider 接入范围

新增 `extensions/dev-containers` 独立 Rust executable，使用现有 Rust SDK、
Host RPC v1 与 `sessionRuntime.v1` typed DataChannel。App Server 不链接其实现。
`session/runtime/invoke` 和 `/cancel` 由 Rust 定义并生成；`sessionRuntimes:1`
用于协商。Renderer 的领域 service 不导入生成传输类型，Main 不运行 Docker。

领域边界在 `src/ash/platform/agentHost/common/agentService.ts`，转换在
`browser/appServerAgentService.ts`，线上连接仍由 `browser/appServerProtocolClient.ts`
唯一拥有。Rust 源契约在 `crates/protocol/src/session/runtime.rs` 和
`crates/app-server-protocol/src/protocol/session.rs`；生成类型、method map 和运行时
decoder 位于 `.build/protocol/typescript/`，由既有生成器产生。
`crates/app-server/src/session_runtime_provider.rs` 管理 profile 授权、activation 和准入记录，
Docker 操作在 `extensions/dev-containers/src/`。没有旧 Docker Host 需要迁移或保留。
Main 使用原有共享后端 starter/relay，未增加每窗口后台进程或 Docker 调用。
App 按命令激活 Provider；TUI 可读取 Provider 执行目标，但未增加独立容器选择 UI。
Provider 缺失时 probe 返回不可用，操作失败，不创建本地执行替代目标。
配置、布局和 dirty editor 仍由前端原 owner 处理；SessionDirectory 保留原始文件 authority，
切换 Session 不重定向已打开文档的写入。取消以 operation ID 发往同一 connection generation；
窗口关闭、取消和停用均释放属于该连接或 activation 的进程树。

创建先由 Provider 运行官方 CLI 的 `up`，确认容器内 `ash-remote-server` 可用，
完成真实 initialize 握手和 Session 目录读取后再发布规范化目标。网关只启动已准入的 Provider executable，沿既有 App Server
协议转发。Session/Thread 目录、终端、文件、资源 handle 和 Git 保留该执行 authority。
窗口断开释放 stdio 进程树；容器保留以供其他客户端使用。显式 Stop/Remove
结束旧连接；Stop 保留同一记录中的来源授权，重开 profile 后仍能从后端清单选择 Remove。Remove 撤销记录，删除带当前 workspace label 的容器，保留 volumes。
启停策略变更退休旧 activation/route generation，不重放旧调用。

实际使用要求主机安装 Docker 与官方 Dev Container CLI，发行包带有授权的 Remote runtime catalog，或镜像已经提供兼容的 Ash Remote runtime。Provider 不把宿主 Windows executable 复制到 Linux 容器。
若镜像未提供 Ash runtime，Provider 从产品授权的 Remote catalog 自动选择、校验并安装匹配架构与 libc 的包；复用共享下载 helper、安装脚本与 receipt 校验。当前环境没有 Docker，真实容器启动、执行及重连仍未验证。
详细使用及验证说明见 [Docker Provider](../extensions/dev-containers/README.md)。

## 验证与边界

行为测试覆盖 managed tabs 的编辑器限制豁免、分类命令的中文展示/英文搜索、
Chat 文档与可见性切换、过期布局操作、工作区历史与晚到结果、连接重载、
容器草稿首次发送、欢迎标记与 telemetry policy。
独立 Rust executable 的测试覆盖实际 SDK 注册/调用、未知 Provider、配置缺失、
取消和停用；共享网关测试覆盖资源路由和容器 authority 的 Session/Thread 映射。

本次针对性验证：前端隔离 Mocha 共 203 项、浏览器集成 4 项、Provider 2 项单测与
5 项真实 SDK 进程测试、网关 11 项、profile 准入 2 项、调度优先级 1 项、协议 140 项、
Remote 安装 9 项、Windows Job Object 5 项、打包 12 项均通过。
Renderer/Protocol 与测试 TypeScript 编译、中文翻译、依赖检查、格式检查和受影响 Rust
包的 `--deny-warnings` 检查通过。SDK 进程测试用受控工具脚本模拟 Docker/CLI；
实际 stdio 握手测试另行覆盖协议不兼容和损坏目录响应，均不能提前准入。

标准 `pnpm test:unit` 最后一次重跑在 runner 自检和清理阶段遇到 Windows
`Get-CimInstance Win32_Process` 超时，未把它记作整条命令通过。203 项结果来自相同
编译产物、同一 preload 与独立进程中的直接 Mocha 执行。扩大检查另曾遇到宿主缺少
`llvm-pdbutil`、既有 V8 补丁/扩展清单断言，以及编辑器 tips 的 `CtrlO` 与 `Ctrl+O`
差异；相关编辑器替换用例通过，未修改这些无关行为。

只补实际调用的契约切片：未增设没有消费者的上游命令、实验设置、样例仓库、
外部应用导入、动态 MCP 状态或 transportFactory API。Ash 现有的
`configuration.ts`、`sessionsProfile.ts`、`views.ts`、`windowNavigation.ts`
仍归原 owner；`sessionWorkspace.ts` 集中实际资源 URI 转换。
