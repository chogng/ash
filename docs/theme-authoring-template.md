# 用户主题文件

Desktop 用户主题与根部 [extensions/theme-defaults](../extensions/theme-defaults/package.json) 使用同一种 VS Code 主题 JSON 格式。解析和校验归 [themes/common](../src/ash/workbench/services/themes/common/colorThemeData.ts)，加载、保存与旧文件转换归 [themes/browser](../src/ash/workbench/services/themes/browser/workbenchThemeService.ts)。不再维护 resources/theme 中的独立 Schema 和模板。

## Desktop 主题

内置扩展随根部 extensions 打包到 ash-resources/extensions，由扩展服务加载。用户文件留在当前 Desktop profile 的 themes/*.json，不写入仓库扩展目录。默认 profile 为用户主目录下的 .ash，ASH_HOME 可覆盖；ASH_DEVICE_ROOT 可覆盖设备资源根目录。

将以下内容保存为 themes/aurora.json，Desktop 会自动加载并监听更改：

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

| 内容        | 规则                                                                 |
| ----------- | -------------------------------------------------------------------- |
| 身份        | 来自文件名，改 name 不改变选择值；扩展主题身份来自清单               |
| name        | 显示名称，可省略；省略时显示文件身份                                 |
| type        | dark、light、hcDark、hcLight；省略时为 dark，扩展由清单 uiTheme 决定 |
| colors      | 十六进制颜色；保留 Ash 颜色标识；未注册的扩展颜色不应用              |
| tokenColors | 内联 TextMate scope/settings 数组，用户主题和扩展主题走相同生效链    |
| 语法        | 接受注释与尾随逗号；不含 version、id、label、colorScheme             |

文件不接受颜色别名和变换对象。注册表内部仍可使用这些能力；导出时转换成具体颜色。未覆盖颜色由对应明暗注册表默认值补齐。Schema 由主题服务注册，颜色提示从当前颜色注册表生成。

支持相对路径的 include 和外部 TextMate tokenColors 文件；引用必须留在主题目录或扩展包内，循环引用会被拒绝。semanticHighlighting 控制主题是否默认启用语义颜色，semanticTokenColors 支持类型、修饰符和语言选择器。DOM 与 GPU 使用同一套解析结果；每项颜色和字体标志分别继承，false 清除对应字体标志。

每个文件最大 1 MiB，目录最多读取 128 个常规 JSON 文件，不跟随符号链接。加载失败逐文件报告。服务内保存和重新加载会更新注册，并立即更新使用该主题的工作台；外部编辑会自动重新加载。替换和删除要求文件内容仍与读取时一致，冲突时拒绝覆盖。

## 覆盖配置与系统外观

配置保存在 Desktop profile 的 settings.json，支持注释和尾随逗号。主题服务负责选择主题、解析主题资源和应用覆盖；编辑器消费最终颜色与 token 样式。

| 设置                                    | 内容                                                                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| workbench.colorCustomizations           | 界面颜色，包括 editor.selectionBackground、editor.inactiveSelectionBackground 和 editor.selectionForeground；default 恢复注册表默认值 |
| editor.tokenColorCustomizations         | comments、strings 等语法分组，以及 textMateRules                                                                                      |
| editor.semanticTokenColorCustomizations | enabled 和 rules；规则可分别覆盖 foreground、bold、italic、underline、strikethrough                                                   |
| window.autoDetectColorScheme            | 根据系统外观使用首选浅色或深色主题                                                                                                    |
| window.autoDetectHighContrast           | 系统开启高对比度时使用首选高对比度主题                                                                                                |
| workbench.preferred*ColorTheme          | 分别指定浅色、深色、高对比度浅色、高对比度深色的主题                                                                                  |

三个覆盖设置都支持以主题显示名称或 ID 编写的方括号块，也支持通配符和多个名称，例如 "[Ash Dark][Ash Light]"。匹配块按声明顺序覆盖全局配置，未指定的属性继续继承。TextMate 规则按 scope 的具体程度逐项匹配，相同具体程度时后声明的值生效；无 scope 的规则提供全局 token 样式。

```json
{
  "workbench.colorCustomizations": {
    "editor.selectionBackground": "#264f78",
    "[Ash Light]": { "editor.selectionBackground": "#add6ff" }
  },
  "editor.tokenColorCustomizations": {
    "comments": { "foreground": "#8899aa", "fontStyle": "italic" }
  },
  "editor.semanticTokenColorCustomizations": {
    "enabled": true,
    "rules": { "variable.readonly": { "bold": false } }
  }
}
```

主题配置不接受语言覆盖块。自动外观开启时，颜色主题选择命令修改当前系统外观对应的首选主题。Browser 监听媒体查询；Electron 从 Main 读取系统配色并订阅变化。Main 保存最近的窗口背景色，在下一次创建窗口时使用。

扩展清单可贡献 colors、semanticTokenTypes、semanticTokenModifiers、semanticTokenScopes 和 icons。注册随扩展目录的更新一起替换，卸载后撤销；校验失败保留此前有效的目录。产品图标主题支持标准 fonts/fontCharacter/fontId，也支持 SVG iconPath；字体来自扩展包内的资源，样式表随主题切换和卸载更新。颜色、文件图标和产品图标 Schema 从当前注册表提供提示。

## 旧 Desktop 文件

启动加载前识别原 version: 1 文档，校验后将 label 映射为 name、colorScheme 映射为 type，并把别名和变换解析成具体颜色。目标文件名为原 id.json，因此已有主题选择值保持有效。

- 原文件名已匹配 ID 时，比较读取内容后原子替换。
- 原文件名不匹配时，先完整创建目标，再检查并删除原文件。
- 已有相同目标时可继续完成原文件清理；内容不同时报告冲突，保留两份。
- 新格式文件不会再次转换，正常加载器只接受新格式。

## TUI

Ash Code TUI 使用 [自己的格式](../crates/tui/README.md#tui-主题文件) 与 [tui].theme。各界面的主题边界见 [design-tokens.md](design-tokens.md)。

## 验证

Desktop 定向验证：pnpm run test:unit --run src/ash/workbench/services/themes/test/browser/workbenchThemeService.test.ts。修改运行时代码还需完成受影响的构建与 Playwright 验证。
