# Design Token：各界面的主题边界

Desktop 与 Ash Code TUI 分别拥有主题实现。配色理念与视觉规范可以互相参考；注册表、默认值、用户主题文件和校验规则由使用它们的界面维护。

## 所有权

Desktop 的 [IThemeService](../src/ash/platform/theme/common/themeService.ts) 只提供当前颜色主题和变化通知。工作台的 [WorkbenchThemeService](../src/ash/workbench/services/themes/browser/workbenchThemeService.ts) 负责配置选择、系统配色、主题注册变化、CSS 绑定与文件图标资源的生命周期；同 ID 主题被替换时立即通知现有消费者。用户文件的读写与迁移由该模块内部资源对象负责，独立编辑器自行拥有主题选择状态。

平台颜色按基础、编辑器、输入、列表、菜单、小地图、滚动条、快速选择、搜索和图表分布在 [colors](../src/ash/platform/theme/common/colors) 目录；工作台外壳颜色由 [theme.ts](../src/ash/workbench/common/theme.ts) 注册。图表色板目前可供主题文件配置，界面尚无图表渲染调用方。

[colorUtils.ts](../src/ash/platform/theme/common/colorUtils.ts) 提供颜色注册、变换与 CSS 变量名；[colorRegistry.ts](../src/ash/platform/theme/common/colorRegistry.ts) 保存默认值和英文说明，读取颜色目录时按当前语言解析说明，供主题 JSON Schema 使用。颜色文件不在加载时固定翻译结果，切换界面语言后说明会随之更新。

Ash Code TUI 的调色板、用户主题和 `[tui].theme` 由 [TUI](../crates/tui/README.md#tui-主题文件) 独立拥有。

## 构建边界

- Desktop 直接使用运行时 TypeScript 注册表，不导出给 Rust，也不生成 token manifest。
- TUI 独立维护主题资源；修改 TUI 主题不需要 Node、pnpm 或 TypeScript。
- 没有跨端 token 编译器、生成命令或生成物新旧检查。Desktop 的 Schema 由主题服务维护，颜色字段从注册表生成；内置扩展位于根部 extensions。TUI 的主题格式由 TUI 自己定义。
- Desktop 用户主题和扩展主题共用 VS Code 主题文档校验，未知颜色标识保留在源文件中，当前未注册的标识不应用。TUI 校验自己的主题资源。
- 同名 token 不构成跨端兼容承诺。两端可以独立增删 token、调整默认值和演进文档格式。

## 使用与验证

Desktop 的设置内保存和预览即时生效；TUI 的资源格式和生效点见 [TUI 主题文件](../crates/tui/README.md#tui-主题文件)。高对比度默认值由各端维护。

修改 Desktop 主题后运行 `pnpm test:unit --run src/ash/workbench/services/themes/test/browser/workbenchThemeService.test.ts`；修改 TUI 主题后运行所属 Rust 测试。
