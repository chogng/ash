# `ash-config`

`ash-config` 隔离配置文档、持久化事务和作用域合并，具体职责只有三项：

1. `ConfigStore` 按 `schemaVersion` 严格读取并原子迁移用户 `config.toml`；根级 `[gui]`、`[tui]` 作为前端自有键值表原样保存，SQLite 保存 revision、generation 和命令回执。
2. `DirConfigStore` 严格读取目录提供的 `.ash/config.toml`；目录文档只能表达待处理的配置意图，不能给自身增加 capability。
3. `DirPermissionsConfig` 按 `DirId` 保存用户明确授予的 capability 集合；缺失条目表示没有持久授权，不使用 Trusted、Restricted 或目录级 Trust 状态。

Plugin 包标识与版本直接复用 `ash-plugin` 的类型和校验，配置层只保存请求及其作用域。

配置合并、来源边界和运行时生效点见 [`docs/config.md`](../../docs/config.md)，环境与目录授权语义见
[`docs/environment-access.md`](../../docs/environment-access.md)。

```text
just test ash-config
```

用户文件 schemaVersion 2 移除旧 Issue 执行配置，只保留 `issues.autoRefreshMinutes`；SQLite 配置文档版本 10 继续支持从版本 7 起的既有记录。Root Role、模型指导与委托通过通用 Agent 系统处理，见 [指令组合](../docs/agent-instructions.md)。

## Feature 与 Schema

- `[features]` 接受 `codeMode`、`queue`、`analytics`、`memories`；前两者默认开启，使用统计与记忆默认关闭。
- Config 保存用户覆盖；`ash-features` 统一解释默认值、阶段和来源。`config/read` 返回 resolved Feature 列表，`config/update.features` 整体替换覆盖，`null` 清空覆盖。
- `schema.json` 从配置类型生成，包含当前文件 `schemaVersion`、严格字段名和嵌套结构。执行 `just generate-config-schema` 更新，`just test ash-config-schema` 检查同步。
- Schema 生成依赖仅在 Cargo 的 `schema` feature 启用；跨字段约束仍由运行时校验。

## Agent 时间策略

`[agent.timeContext]` 保存 `mode = "off" | "date" | "time"` 与可选的 IANA `timeZone`，默认 `date` 且使用宿主时区。策略仅属于 profile；目录不能替用户选择时区。完整行为与参照冻结规则见 [Agent 时间与等待](../docs/agent-wait.md)。
