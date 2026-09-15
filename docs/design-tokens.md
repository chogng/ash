# Design Token：各界面的主题边界

Desktop、Rust GUI 与 Ash Code TUI 分别拥有主题实现。配色理念与视觉规范可以互相参考；注册表、默认值、用户主题文件和校验规则由使用它们的界面维护。

## 所有权

| 内容 | Desktop TypeScript | Rust GUI |
| --- | --- | --- |
| 颜色与尺寸声明 | [theme/common](../ash-ts/src/ash/platform/theme/common/colorTheme.ts) 的注册表 | [catalog.json](../app/theme/resources/catalog.json) |
| 内置主题 | TypeScript 注册表和主题快照 | [entries.json](../app/theme/resources/entries.json) 和 Rust 解析器 |
| 用户主题校验 | [userColorTheme.ts](../ash-ts/src/ash/platform/theme/common/userColorTheme.ts) | [document.rs](../app/theme/src/document.rs) 与 [catalog.rs](../app/theme/src/catalog.rs) |
| 用户主题 Schema 与模板 | [ash-ts/resources/theme](../ash-ts/resources/theme/color-theme.schema.json) | [app/theme/resources](../app/theme/resources/color-theme.schema.json) |
| 用户主题目录 | profile root 的 `themes/*.json` | profile root 的 `app/themes/*.json` |
| 主题选择 | `workbench.colorTheme`，由 Desktop 配置服务保存 | `config.toml` 的 `[gui].theme`，由 GUI 解释 |
| 组件消费 | CSS 变量与编辑器、终端颜色表 | `ThemeSnapshot → UiTheme` 与各组件的类型化样式 |

Ash Code TUI 的调色板、用户主题和 `[tui].theme` 由 [ash-code/tui](../ash-code/tui/README.md) 独立拥有。

## 构建边界

- Desktop 直接使用运行时 TypeScript 注册表，不导出给 Rust，也不生成 token manifest。
- Rust 在编译时嵌入自己维护的 JSON 声明；修改 Rust 主题不需要 Node、pnpm 或 TypeScript。
- 没有跨端 token 编译器、生成命令或生成物新旧检查。主题 Schema 和模板是各端自有资源，随所属解析器维护。
- JSON Schema 描述文档结构；加载时由各端注册表校验 token 是否存在、引用能否解析、变换是否合法。
- 同名 token 不构成跨端兼容承诺。两端可以独立增删 token、调整默认值和演进文档格式。

## 使用与验证

- 新颜色语义在使用它的界面注册，组件通过语义 token 取值。
- 每端只解析自己的用户主题目录和 Schema；选择主题不写入另一端的配置。
- 解析器负责未知 token、循环引用、变换深度与透明度校验；组件消费完整快照。
- 两端各自保留别名、变换、主题模板及默认值测试，不使用跨端一致性 fixture。
- 用户主题安装和旧主题处理见 [主题模板](theme-authoring-template.md)；Rust crate 接口见 [ash-ui-theme](../app/theme/README.md)。

## 当前边界

拆分保留各端已有颜色、尺寸、别名和内置主题 ID，不改变既有组件外观。Rust GUI 只接收宿主传入的主题选择，不读写 Desktop 的 `configuration.json`。

Desktop 的设置内保存和预览即时生效；Rust GUI 的外部主题文件在加载时读取。高对比度默认值由各端单独维护，当前未单独定义的值继承对应明暗方案。
