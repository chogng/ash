# `ash-theme`

- 维护 Rust GUI 的颜色、尺寸、内置主题和用户主题格式。
- 解析别名、覆盖与颜色变换，生成不可变 `ThemeSnapshot`。
- 从 profile root 的 `app/themes/*.json` 有界读取用户主题，隔离错误文件。
- 不依赖 TypeScript 注册表、生成工具或 Desktop 用户配置。

## 资源与接口

| Owner | 职责 |
| --- | --- |
| [resources/catalog.json](resources/catalog.json) | Rust 自有颜色默认值、别名与尺寸定义；直接编辑 |
| [resources/entries.json](resources/entries.json) | Rust GUI 的内置主题入口和覆盖 |
| [resources/color-theme.schema.json](resources/color-theme.schema.json) | 用户主题文档结构 |
| [resources/color-theme.template.json](resources/color-theme.template.json) | 可安装的用户主题示例 |
| `ThemeCatalog` | 校验自有目录并解析完整快照 |
| `ThemeDocument` | 严格解析最多 1 MiB、512 项覆盖的用户 JSON |
| `ThemeLoader::preview` | 根据 GUI 传入的选择值解析主题，不读取或保存选择配置 |
| `ThemeLoadOptions` | 宿主提供 profile root、系统明暗方案和默认入口 |
| `tokens.rs` | Rust 调用方使用的语义 ID 常量 |

GUI 从 `[gui].theme` 取得选择值；本 crate 不解释 `[gui]`、`[tui]` 或 Desktop 的 `workbench.colorTheme`。
`ash-ui-theme` 将快照转换为组件颜色和尺寸；组件不读主题文件。

## 执行路径

`ThemeLoader::embedded → ThemeCatalog::embedded` 嵌入本 crate 的 `resources/catalog.json` 和 `resources/entries.json`，验证所有明暗方案。

`ThemeLoader::preview(options, preference)` 解析 `system`、内置主题 ID 或 `app/themes` 内的用户主题 ID。目录最多读取 128 个非递归常规 JSON，每份最大 1 MiB。错误文件通过 `ThemeDiagnostic` 报告，不影响其他文件。

Rust GUI 使用 `https://ash.dev/schemas/app/color-theme.schema.json`。不接受 Desktop 的 Schema，不扫描 Desktop 的 `themes` 目录；旧主题安装步骤见 [主题模板](../../docs/theme-authoring-template.md)。

## 修改与验证

新增 token 时维护本 crate 的目录、所需 ID 常量及组件测试。修改用户格式时同步本 crate 的 Schema、模板和解析测试。TypeScript 主题独立维护，不要求两端同步 token 或默认值。

`ThemeSnapshot::required_color`、`required_size` 和 `required_pixel_size` 在缺少值或单位不匹配时返回错误。调用方负责原子应用完整样式。

验证命令：`just check ash-theme`、`just test ash-theme`、`just rust-warnings ash-theme`；组件适配另运行 `just test ash-ui-theme`。
