# Ash 工程文档

这里面向开发 Ash 的人，说明如何运行、修改和验证项目。产品介绍见[根 README](../README.md)，使用说明见 [Ash 用户文档](https://github.com/chogng/ash-docs)。

## 开始开发

| 你要做什么                     | 从哪里开始                                                       |
| ------------------------------ | ---------------------------------------------------------------- |
| 安装工具、构建、测试或清理产物 | [构建与开发](build.md)                                           |
| 开发桌面端、浏览器界面或编辑器 | [前端开发](frontend.md)                                          |
| 修改命令行或终端界面           | [CLI](../cli/README.md)、[TUI](../crates/tui/README.md)          |
| 判断功能属于哪一端、哪个模块   | [产品与宿主边界](product-lines.md)、[系统架构](architecture.md)  |
| 构建或发布运行包               | [共享运行包](../build/README.md)、[产品更新](product-updates.md) |

工具版本和命令在构建指南维护；各模块的实现、约束和测试入口在相邻 README。

## 功能文档与待办

当前职责、运行契约和验证入口按功能阅读：[Chat／Speech](chat.md)、[Terminal](terminal.md)、[Sessions／Changes／Docker](sessions.md)、[Preferences／Configuration](preferences-and-settings.md)。未完成动作与验收缺口集中在[根 TODO](../TODO.md)，按“功能 · TODO”组织，完成后移除。文档中的通用审查清单、接口模板和可选目标设计保留各自用途，不自动转为实施任务。

[Windows UAC 手册](windows-system-authorization.md)与[上传文件验证](browser-foundation.md#浏览器上传文件访问验证)保留可重复的操作步骤；平台待验收状态由 TODO 维护。编辑器和 Work 的目标契约继续保留在 [design](design/editor-roadmap.md) 中，研究快照与测量证据保留原路径。

## 理解系统

- **界面与宿主：** [Desktop 架构](desktop-architecture.md)、[前后端连接](frontend-app-server-boundary.md)、[Sessions 布局与 Changes](sessions.md)、[工作台与文档](workbench.md)、[编辑器架构](editor-architecture.md)、[远程开发](remote-development.md)。
- **后端与执行：** [Rust 架构](rust-architecture.md)、[Agent 运行时](agent-runtime.md)、[Core](core.md)、[上下文管理](core-context.md)、[多 Agent](core-multi-agent.md)、[进程执行](exec.md)。
- **协议与接口：** [领域身份](domain-model.md)、[协议](protocol.md)、[App Server API](app-server-api.md)、[客户端](app-server-client.md)、[工具契约](agent-tools-spec.md)、[工具系统](tools/tools.md)、[完整工具目录](tools/tool-catalog.md)。
- **模型调用：** [模型 API](model-api.md)、[模型调用客户端](model-client.md)、[Provider](model-provider.md)、[模型目录](models-manager.md)。
- **配置：** [配置](config.md)、[模型接入](model-provider.md)、[登录](login.md)、[Agent 定制](agent-customizations.md)。
- **Extensions（扩展）：** [产品层级与扩展架构](editor-extensions.md#extensions-的产品层级)；包含 [Skills](skills.md)、[MCP](mcp.md)、[Connectors](connectors.md)、[LSP / 语言服务器](lsp.md)、编辑器扩展、主题和语言包等能力。[包管理](../crates/docs/core-plugins.md)与 [Plugin 包及来源授权](plugins.md)说明底层安装和授权契约。
- **权限与安全：** [权限](permissions.md)、[沙箱](sandboxing.md)、[环境访问](environment-access.md)、[工作区安全](workspace-security.md)、[凭据](secrets.md)。
- **界面开发：** [浏览器基础](browser-foundation.md)、[Preferences 与 Settings](preferences-and-settings.md)、[样式职责](ui-styling-ownership.md)、[主题变量](design-tokens.md)、[面板与布局](pane-composites.md)、[菜单](menu-system.md)、[本地化](localization.md)。
- **Trace 与评测：** [执行 Trace](trace.md)、[执行 Trace 当前行为](chat-session-inspector.md#执行-trace)、[任务评测](../test/agent-eval/README.md)。
- **外部运行时研究：** [Codex Owl 运行时调查与 Ash 性能优化参考](codex-owl-runtime-investigation.md)，包含定版安装包、进程与事件循环、任务分配、JSON／IPC、证据快照和隔离小测。
- **数据链路性能：** [Ash app-server 到 Renderer 的大响应链路审计](ash-app-server-data-path-audit.md)，记录解析、复制和背压的实际问题与优化优先级。

设计文档会区分当前实现和目标设计。功能是否可用应以其中的状态说明及对应实现、测试为准。

## 开发约定

修改前阅读 [AGENTS.md](../AGENTS.md) 和适用的[专项规范](../.github/instructions)。文档内容与位置遵循[文档写作规范](../.github/instructions/documentation.instructions.md)。

普通开发直接完成实现和测试，并更新受影响的现有文档。只有显式使用 `/develop` 时，才采用[阶段产物与验收流程](development-workflow.md)；其设计背景见[意图驱动开发](develop.md)。
