# 用户主题文件

Desktop 用户主题与根部 [extensions/theme-defaults](../extensions/theme-defaults/package.json) 使用同一种 VS Code 主题 JSON 格式。解析和校验归 [themes/common](../ash-ts/src/ash/workbench/services/themes/common/colorThemeData.ts)，加载、保存与旧文件转换归 [themes/browser](../ash-ts/src/ash/workbench/services/themes/browser/workbenchThemeService.ts)。不再维护 ash-ts/resources/theme 中的独立 Schema 和模板。

## Desktop 主题

内置扩展随根部 extensions 打包到 ash-resources/extensions，由扩展服务加载。用户文件留在当前 Desktop profile 的 themes/*.json，不写入仓库扩展目录。默认 profile 为用户主目录下的 .ash，ASH_HOME 可覆盖；ASH_DEVICE_ROOT 可覆盖设备资源根目录。

将以下内容保存为 themes/aurora.json，完全重启 Desktop 后加载：

```json
{
  "$schema": "vscode://schemas/color-theme",
  "name": "Aurora",
  "type": "dark",
  "colors": {
    "editor.background": "#0b1020",
    "editor.foreground": "#dbe7ff",
    "sideBar.background": "#10172a",
    "panel.background": "#10172a",
    "toolbar.hoverBackground": "#ffffff33"
  },
  "tokenColors": [
    { "scope": "comment", "settings": { "foreground": "#8899aa", "fontStyle": "italic" } }
  ]
}
```

| 内容 | 规则 |
| --- | --- |
| 身份 | 来自文件名，改 name 不改变选择值；扩展主题身份来自清单 |
| name | 显示名称，可省略；省略时显示文件身份 |
| type | dark、light、hcDark、hcLight；省略时为 dark，扩展由清单 uiTheme 决定 |
| colors | 十六进制颜色；保留 Ash 颜色标识；未注册的扩展颜色不应用 |
| tokenColors | 内联 TextMate scope/settings 数组，用户主题和扩展主题走相同生效链 |
| 语法 | 接受注释与尾随逗号；不含 version、id、label、colorScheme |

文件不接受颜色别名和变换对象。注册表内部仍可使用这些能力；导出时转换成具体颜色。未覆盖颜色由对应明暗注册表默认值补齐。Schema 由主题服务注册，颜色提示从当前颜色注册表生成。

当前支持自包含主题；include 和外部 tokenColors 文件不在加载契约内。semanticHighlighting 与 semanticTokenColors 可用于标准文档校验，现有语义高亮消费能力不因本次格式迁移扩大。

每个文件最大 1 MiB，目录最多读取 128 个常规 JSON 文件，不跟随符号链接。加载失败逐文件报告。服务内保存和重新加载会更新注册；外部编辑后需要重启。替换和删除要求文件内容仍与读取时一致，冲突时拒绝覆盖。

## 旧 Desktop 文件

启动加载前识别原 version: 1 文档，校验后将 label 映射为 name、colorScheme 映射为 type，并把别名和变换解析成具体颜色。目标文件名为原 id.json，因此已有主题选择值保持有效。

- 原文件名已匹配 ID 时，比较读取内容后原子替换。
- 原文件名不匹配时，先完整创建目标，再检查并删除原文件。
- 已有相同目标时可继续完成原文件清理；内容不同时报告冲突，保留两份。
- 新格式文件不会再次转换，正常加载器只接受新格式。

## Rust GUI 与 TUI

Rust GUI 继续使用 [独立模板](../app/theme/resources/color-theme.template.json) 和 [Schema](../app/theme/resources/color-theme.schema.json)，文件位于 profile 的 app/themes/*.json，主题选择由 config.toml 的 [gui].theme 保存。其 version、id、label、colorScheme、别名和变换规则保持原样；不要用 Desktop 的新文件替换 Rust 文件。

Ash Code TUI 使用 [自己的格式](../ash-code/tui/README.md) 与 [tui].theme。各界面的主题边界见 [design-tokens.md](design-tokens.md)。

## 验证

Desktop 定向验证：pnpm --dir ash-ts run test:unit --run src/ash/workbench/services/themes/test/browser/workbenchThemeService.test.ts。修改运行时代码还需完成受影响的构建与 Playwright 验证。
