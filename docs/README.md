# 工程文档

[系统架构](architecture.md) · [Ash Code](../code/README.md) · [app](../app-rs/docs/README.md) · [用户文档](https://github.com/chogng/ash-docs)

普通开发直接完成实现和测试，按需更新现有文档；显式使用 `/develop` 时才采用[阶段产物与验收规则](development-workflow.md)。编写文档见[写作规范](../.github/instructions/documentation.instructions.md)。各模块的代码和测试入口在相邻 README。

## 意图驱动的 Agent 开发流程

| 文档 | 类型 | 一句话 |
| --- | --- | --- |
| [`development-workflow.md`](development-workflow.md) | 规范 | 仅 `/develop` 使用的阶段产物、记录模板与验收规则 |
| [`develop.md`](develop.md) | 设计 | 从自然对话到 Intent、Spec、Plan、实施、验收和收口的统一系统设计 |

## Agent 与运行时

| 文档 | 类型 | 一句话 |
| --- | --- | --- |
| [`agent-tools-spec.md`](agent-tools-spec.md) | 规格 | 逐工具 schema / 描述正文 / 错误文案 + 系统提示词扩写 |
| [`agent-harness-design.md`](agent-harness-design.md) | 设计 | harness 行为策略：提示词、循环、失败、裁剪、压缩、缓存 |
| [`ash-agent-runtime-architecture.md`](ash-agent-runtime-architecture.md) | 设计 | 执行内核总体设计、组件状态总账、阶段 A–E |
| [`core.md`](core.md) | 设计 | ash-core 的 ownership、组件、端口、提交顺序 |
| [`core-context.md`](core-context.md) | 设计 | ContextPlan / Manager / checkpoint / compaction 机制 |
| [`core-multi-agent.md`](core-multi-agent.md) | 设计 | 同 Session Agent 的委托、Fresh spawn、消息交付和隔离（部分实现，缺口见状态头） |
| [`agent-customizations.md`](agent-customizations.md) | 设计 | Instructions / Skills / Agents、`.ash` 与外部导入边界 |
| [`agents.md`](agents.md) | 设计 | 内置与自定义 Agent 的统一定义、专化职责、启动来源和执行约束 |
| [`tools.md`](tools.md) | 设计 | 工具三层契约、registry snapshot |
| [`exec.md`](exec.md) | 设计 | 进程执行 |
| [`core-plugins.md`](../ash-rs/docs/core-plugins.md) | 设计 | Plugin 来源、PluginsManager、包存储、activation 与 capability 接线 |
| [`localization.md`](localization.md) | 设计 | 内置 locale catalog、Marketplace localization 包与 UI fallback |
| [`plugins.md`](plugins.md) / [`connectors.md`](connectors.md) / [`skills.md`](skills.md) | 设计 | Plugin 扩展分发、Connector 外部账号连接与 Skill 指令运行时边界 |
| [`editor-extensions.md`](editor-extensions.md) | 设计 | 声明式扩展与 Ash 原生可执行 Host v1 的双轨边界、信任、生命周期和产品接入状态 |
| [`mcp.md`](mcp.md) | 设计 | MCP 客户端协议会话、能力调用与 Connector ready binding |
| [`slash-commands.md`](slash-commands.md) | 设计 | Slash Command 与统一斜杠启动面板边界 |

## 协议与 API

[`domain-model.md`](domain-model.md)（领域身份与命名）、[`protocol.md`](protocol.md)（canonical 产品契约）、
[`ash-app-server-api.md`](ash-app-server-api.md)、[`app-server-client.md`](app-server-client.md)、
[`ash-api.md`](ash-api.md)、[`ash-api-interface-requirements.md`](ash-api-interface-requirements.md)、
[`ash-api-interface-template.md`](ash-api-interface-template.md)（模板）、
[`ash-client.md`](ash-client.md)（参考）

## 模型与配置

[`model-provider.md`](model-provider.md)、[`model-provider-config.md`](model-provider-config.md)、
[`models-manager.md`](models-manager.md)、[`config.md`](config.md)、[`login.md`](login.md)、
[`subscriptions.md`](subscriptions.md)（订阅接入与额度）、
[`secrets.md`](secrets.md)

## 安全与权限

[`permissions.md`](permissions.md)、[`auto-review.md`](auto-review.md)、
[`sandboxing.md`](sandboxing.md)、[`environment-access.md`](environment-access.md)、
[`workspace-security.md`](workspace-security.md)（当前实现）、
[`windows-sandbox-acceptance-runbook.md`](windows-sandbox-acceptance-runbook.md)（参考/手册）

## 界面与体验

[`ash-desktop-architecture.md`](ash-desktop-architecture.md)、
[`ui-styling-ownership.md`](ui-styling-ownership.md)、
[`editor-architecture.md`](editor-architecture.md)、[`editor-core.md`](editor-core.md)、
[`workbench-pane-composite-design.md`](workbench-pane-composite-design.md)、
[`design-tokens.md`](design-tokens.md)、[`theme-authoring-template.md`](theme-authoring-template.md)（模板）、
[`menu-system.md`](menu-system.md)、[`icons.md`](icons.md)、[`search.md`](search.md)、
[`keybindings.md`](keybindings.md)、
[`code-intelligence.md`](code-intelligence.md)、
[`codebase.md`](codebase.md)、
[`syntax-analysis.md`](syntax-analysis.md)、[`lsp.md`](lsp.md)、
[`editor-extensions.md`](editor-extensions.md)、
[`chat-session-inspector.md`](chat-session-inspector.md)、[`typst.md`](typst.md)

## app 产品

[app 文档](../app-rs/docs/README.md)：桌面交互、终端、输入与渲染。

## 平台与产品

[`architecture.md`](architecture.md)（总入口）、[`ash-rs-architecture.md`](ash-rs-architecture.md)、
[`code/README.md`](../code/README.md)、[`workbench-modes.md`](workbench-modes.md)、
[`product-lines.md`](product-lines.md)、[`remote-development.md`](remote-development.md)、[`git.md`](git.md)、
[`documentation-guidelines.md`](documentation-guidelines.md)

## 计划与迁移

| 文档 | 状态 |
| --- | --- |
| [`app-rs/docs/native-deprecation-plan.md`](../app-rs/docs/native-deprecation-plan.md) | Native 弃用迁移 |
| [`app-rs/docs/app-migration-plan.md`](../app-rs/docs/app-migration-plan.md) | App 迁移 |
| [`app-rs/docs/app-release-graph.md`](../app-rs/docs/app-release-graph.md) | App 发布依赖 |
