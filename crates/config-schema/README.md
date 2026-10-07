# Config schema

- 从 `ash-config::UserConfigDocument` 的 serde 类型生成 `crates/config/schema.json`，对应 TOML 文档结构和当前 `schemaVersion`。
- Schema 依赖仅在 `schema` feature 中启用；生成命令与产物由本 crate 负责。
- 运行 `just generate-config-schema` 更新，`just test ash-config-schema` 检查同步。
- 跨字段与外部身份校验继续由 Config 执行，Schema 不替代运行时校验。
