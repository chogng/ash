# `ash-agent-roles`

`ash-agent-roles` 隔离角色定义、来源加载与校验依赖。

- `assets/**/*.md` 是随产品发布的角色，`.ash/agents/*.md` 是自定义角色；共用 Markdown 正文与 YAML frontmatter 解析、校验和摘要。
- `assets/team`、`assets/develop` 按命令组织角色，文件名只写职责；准确 ID 使用相对路径，如 `team/implementer`。
- `issue.md`、`advisor.md`、`reviewer.md` 保存独立职责；`Default` 使用共享规则。
- Role 声明自身与下放 Tool、Skill、模型及职责指令，声明不能授予超出当前授权的能力。
- 内置 Role 声明启动来源、准确调用方与允许委托目标；运行时负责执行门禁。
- App Server 对根、子 Thread 使用同一准确来源解析；省略角色不会按任务关键词选择。
- Core 持久化并执行冻结配置，处理委托、恢复、取消与工具约束；本 crate 不拥有运行时。

选择 Markdown 是因为角色的主要内容是长篇提示词；工具、版本、启动限制保留为严格类型的 frontmatter。未知字段、无效引用和冲突权限均报错，不再维护另一套 TOML 角色格式。`host` 角色由专用产品入口消费，不进入普通会话或委托选择。

设计与评测见 [Agent 指令组合](../docs/agent-instructions.md)，完整角色产品契约见 [Agent 定义](../../docs/agents.md)。验证：`just test ash-agent-roles`、`just check ash-agent-roles`。
