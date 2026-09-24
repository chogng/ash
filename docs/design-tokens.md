# Design Token：各界面的主题边界

Desktop、Rust GUI 与 Ash Code TUI 分别拥有主题实现。配色理念与视觉规范可以互相参考；注册表、默认值、用户主题文件和校验规则由使用它们的界面维护。

## 所有权

| 内容 | Desktop TypeScript | Rust GUI |
| --- | --- | --- |
| 颜色与尺寸声明 | [平台颜色注册表](../app-ts/src/ash/platform/theme/common/colorRegistry.ts) 与 [工作台颜色定义](../app-ts/src/ash/workbench/common/theme.ts)；尺寸由平台注册 | [catalog.json](../app-rs/theme/resources/catalog.json) |
| 内置主题 | TypeScript 注册表默认值与根部 [extensions/theme-defaults](../extensions/theme-defaults/package.json) | [entries.json](../app-rs/theme/resources/entries.json) 和 Rust 解析器 |
| 用户主题校验 | [colorThemeData.ts](../app-ts/src/ash/workbench/services/themes/common/colorThemeData.ts) | [document.rs](../app-rs/theme/src/document.rs) 与 [catalog.rs](../app-rs/theme/src/catalog.rs) |
| 用户主题 Schema 与模板 | [colorThemeSchema.ts](../app-ts/src/ash/workbench/services/themes/common/colorThemeSchema.ts) | [app-rs/theme/resources](../app-rs/theme/resources/color-theme.schema.json) |
| 用户主题目录 | profile root 的 `themes/*.json` | profile root 的 `app/themes/*.json` |
| 主题选择 | `workbench.colorTheme`，由 Desktop 配置服务保存 | `config.toml` 的 `[gui].theme`，由 GUI 解释 |
| 组件消费 | CSS 变量与编辑器、终端颜色表 | `ThemeSnapshot → UiTheme` 与各组件的类型化样式 |

Desktop 的 [IThemeService](../app-ts/src/ash/platform/theme/common/themeService.ts) 只提供当前颜色主题和变化通知。工作台的 [WorkbenchThemeService](../app-ts/src/ash/workbench/services/themes/browser/workbenchThemeService.ts) 负责配置选择、系统配色、主题注册变化、CSS 绑定与文件图标资源的生命周期；同 ID 主题被替换时立即通知现有消费者。用户文件的读写与迁移由该模块内部资源对象负责，独立编辑器自行拥有主题选择状态。

平台颜色按基础、编辑器、输入、列表、菜单、小地图、滚动条、快速选择、搜索和图表分布在 [colors](../app-ts/src/ash/platform/theme/common/colors) 目录；工作台外壳颜色由 [theme.ts](../app-ts/src/ash/workbench/common/theme.ts) 注册。图表色板目前可供主题文件配置，界面尚无图表渲染调用方。

[colorUtils.ts](../app-ts/src/ash/platform/theme/common/colorUtils.ts) 提供颜色注册、变换与 CSS 变量名；[colorRegistry.ts](../app-ts/src/ash/platform/theme/common/colorRegistry.ts) 保存默认值和英文说明，读取颜色目录时按当前语言解析说明，供主题 JSON Schema 使用。颜色文件不在加载时固定翻译结果，切换界面语言后说明会随之更新。

Ash Code TUI 的调色板、用户主题和 `[tui].theme` 由 [code/tui](../code/tui/README.md) 独立拥有。

## 构建边界

- Desktop 直接使用运行时 TypeScript 注册表，不导出给 Rust，也不生成 token manifest。
- Rust 在编译时嵌入自己维护的 JSON 声明；修改 Rust 主题不需要 Node、pnpm 或 TypeScript。
- 没有跨端 token 编译器、生成命令或生成物新旧检查。Desktop 的 Schema 由主题服务维护，颜色字段从注册表生成；内置扩展位于根部 extensions。Rust 的 Schema 与模板仍是自有资源。
- Desktop 用户主题和扩展主题共用 VS Code 主题文档校验，未知颜色标识保留在源文件中，当前未注册的标识不应用。Rust 继续校验自己的别名和变换。
- 同名 token 不构成跨端兼容承诺。两端可以独立增删 token、调整默认值和演进文档格式。

## 使用与验证

- 新颜色语义在使用它的界面注册，组件通过语义 token 取值。
- 每端只解析自己的用户主题目录和 Schema；选择主题不写入另一端的配置。
- Desktop 文件使用具体十六进制颜色；注册表内部仍可使用别名和变换。组件消费完整快照。
- 两端分别验证默认值和主题加载；Desktop 另有旧格式单向转换测试，不使用跨端一致性 fixture。
- 用户主题安装和旧主题处理见 [主题模板](theme-authoring-template.md)；Rust crate 接口见 [ash-ui-theme](../app-rs/theme/README.md)。

## 当前边界

拆分保留各端已有颜色、尺寸、别名和内置主题 ID，不改变既有组件外观。Rust GUI 只接收宿主传入的主题选择，不读写 Desktop 的 `configuration.json`。

Desktop 的设置内保存和预览即时生效；Rust GUI 的外部主题文件在加载时读取。高对比度默认值由各端单独维护，当前未单独定义的值继承对应明暗方案。
