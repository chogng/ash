# Ash 工程文档

这里面向开发 Ash 的人，说明如何运行、修改和验证项目。产品介绍见[根 README](../README.md)，使用说明见 [Ash 用户文档](https://github.com/chogng/ash-docs)。

## 开始开发

| 你要做什么                     | 从哪里开始                                                                   |
| ------------------------------ | ---------------------------------------------------------------------------- |
| 安装工具、构建、测试或清理产物 | [构建与开发](build.md)                                                       |
| 开发桌面端、浏览器界面或编辑器 | [前端开发](frontend.md)                                                      |
| 修改命令行或终端界面           | [CLI](../cli/README.md)、[TUI](../crates/tui/README.md)                      |
| 判断功能属于哪一端、哪个模块   | [产品与宿主边界](product-lines.md)、[系统架构](architecture.md)              |
| 构建或发布运行包               | [共享运行包](../build/README.md)、[产品更新](product-update-architecture.md) |

工具版本和命令在构建指南维护；各模块的实现、约束和测试入口在相邻 README。

## 理解系统

- **界面与宿主：** [Desktop 架构](ash-desktop-architecture.md)、[前后端连接](frontend-app-server-boundary.md)、[工作台与文档](workbench-modes.md)、[编辑器架构](editor-architecture.md)、[远程开发](remote-development.md)。
- **后端与执行：** [Rust 架构](rust-architecture.md)、[Agent 运行时](ash-agent-runtime-architecture.md)、[Core](core.md)、[上下文管理](core-context.md)、[多 Agent](core-multi-agent.md)、[进程执行](exec.md)。
- **协议与接口：** [领域身份](domain-model.md)、[协议](protocol.md)、[App Server API](ash-app-server-api.md)、[客户端](app-server-client.md)、[工具契约](agent-tools-spec.md)。
- **配置与扩展：** [配置](config.md)、[模型接入](model-provider.md)、[登录](login.md)、[Agent 定制](agent-customizations.md)、[Skills](skills.md)、[Plugins](plugins.md)、[Connectors](connectors.md)、[MCP](mcp.md)、[编辑器扩展](editor-extensions.md)。
- **权限与安全：** [权限](permissions.md)、[沙箱](sandboxing.md)、[环境访问](environment-access.md)、[工作区安全](workspace-security.md)、[凭据](secrets.md)。
- **界面开发：** [浏览器基础](browser-foundation.md)、[Preferences 与 Settings](preferences-and-settings.md)、[样式职责](ui-styling-ownership.md)、[主题变量](design-tokens.md)、[面板与布局](workbench-pane-composite-design.md)、[菜单](menu-system.md)、[本地化](localization.md)。

设计文档会区分当前实现和目标设计。功能是否可用应以其中的状态说明及对应实现、测试为准。

## 开发约定

修改前阅读 [AGENTS.md](../AGENTS.md) 和适用的[专项规范](../.github/instructions)。文档内容与位置遵循[文档写作规范](../.github/instructions/documentation.instructions.md)。

普通开发直接完成实现和测试，并更新受影响的现有文档。只有显式使用 `/develop` 时，才采用[阶段产物与验收流程](development-workflow.md)；其设计背景见[意图驱动开发](develop.md)。
