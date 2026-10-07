# Features

- 统一管理功能身份、默认值、实验/稳定/废弃/移除阶段和配置来源。
- 用户 `[features]` 覆盖默认值；显式 `false` 保留关闭语义，未指定的键跟随默认值。
- `codeMode` 控制新 Turn 的代码工具模式；`queue` 控制新消息入队；`analytics` 默认关闭。
- `memories` 默认关闭，控制模型召回、读取和保存；用户仍可管理已有记忆，各范围授权独立保留。
- 配置仅接受 canonical key；目前没有需要迁移的历史 Feature 键，未知键直接报错。
- 功能开关不授予执行、网络或密钥权限；已提交命令的重试不重新解释开关。
- 验证：`just test ash-features`。
