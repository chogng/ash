# `ash-agent-roles`

`ash-agent-roles` 隔离角色定义、来源加载与校验依赖。

- 从 `assets/builtins/*.toml` 加载内置 Role，从 `.ash/agents/*.md` 加载目录 Role，发布不可变 catalog、摘要和诊断。
- 内置 `issue`、三个 Team 角色、五个 Develop 阶段角色及三个 Intent 私有角色；`Default` 使用共享规则。
- Role 声明自身与下放 Tool、Skill、模型及职责指令，声明不能授予超出当前授权的能力。
- 内置 Role 声明启动来源、准确调用方与允许委托目标；运行时负责执行门禁。
- App Server 对根、子 Thread 使用同一准确来源解析；省略角色不会按任务关键词选择。
- Core 持久化并执行冻结配置，处理委托、恢复、取消与工具约束；本 crate 不拥有运行时。

设计与评测见 [Agent 指令组合](../docs/agent-instructions.md)，完整角色产品契约见 [Agent 定义](../../docs/agents.md)。验证：`just test ash-agent-roles`、`just check ash-agent-roles`。
