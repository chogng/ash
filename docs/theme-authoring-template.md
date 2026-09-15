# 用户主题 JSON 模板

> 本文分别说明 Desktop 与 Rust GUI 的用户主题。Desktop 使用 [自己的模板](../ash-ts/resources/theme/color-theme.template.json) 和 [Schema](../ash-ts/resources/theme/color-theme.schema.json)；Rust GUI 使用 [自己的模板](../app/theme/resources/color-theme.template.json) 和 [Schema](../app/theme/resources/color-theme.schema.json)。两端 token 由各自主题实现维护，架构见 [主题边界](design-tokens.md)。Ash Code TUI 使用 [独立格式](../ash-code/tui/README.md)。

## 快速理解

以下设置页面操作描述 Desktop。创建主题最简单的方法是在 Settings → Appearance 中从当前主题另存一份，再只修改需要变化的
语义颜色。主题文件不需要复制完整颜色表；未覆盖的颜色会继续使用所选明暗方案的默认值。

| 想做什么 | 推荐方式 | 生效方式 |
| --- | --- | --- |
| 从当前外观开始修改 | 使用“Create from current theme” | 保存后立即预览和切换 |
| 安装别人提供的主题 | 把 JSON 放入用户主题目录 | 完全重启后加载 |
| 更新已有主题 | 在设置中保存，或替换同名文件 | 设置内保存立即生效；外部替换需重启 |
| 删除主题 | 在设置中删除，或移除对应文件 | 自动回到内置明暗主题 |
| 修复加载失败 | 根据 Appearance 中的错误修改 JSON | 其他有效主题不受影响 |

## 从当前主题创建

推荐在 Settings → Appearance 中操作：

- 当前选择 Light 时，“Create from current theme”会生成完整的 Light JSON；Dark 同理。
- System 会采用当前操作系统实际生效的 Light 或 Dark。
- 有效 JSON 会即时预览；取消或关闭 Settings 会恢复编辑前的主题。
- 内置 Light/Dark 只能使用“Save As”创建新主题，不会被覆盖。
- 用户主题可以直接“Save”，也可以修改 `id` 和 `label` 后“Save As”。
- 用户主题可以在 JSON 编辑器中“Delete”；确认后删除文件并按原主题明暗类型切回 Ash Light 或 Ash Dark。
- 保存成功后 JSON 会立即注册、切换并写入用户主题目录，不需要重启。

## 文件安装与卸载

Desktop 读取 profile root 的 `themes/*.json`；Rust GUI 读取 `app/themes/*.json`。默认 profile root 在 macOS 为 `/Users/<user>/.ash`，Linux 为 `/home/<user>/.ash`，Windows 为 `C:\Users\<user>\.ash`。`ASH_HOME` 可整体覆盖 profile；测试主题加载器时还可用优先级更高的 `ASH_DEVICE_ROOT` 仅覆盖 device resource root。Desktop 中的实际绝对路径会显示在 Settings → Appearance 底部。

- 外部安装：把 [`color-theme.template.json`](../ash-ts/resources/theme/color-theme.template.json) 复制到该目录，修改 `id`、`label` 和颜色后保存，完全重启 Ash。
- 外部更新：替换同名文件，完全重启 Ash。
- 卸载：删除对应文件，完全重启 Ash。
- 恢复：如果已选择的主题不存在或加载失败，配置验证会回退到 System，内置 Light/Dark 始终可用。

每个文件独立加载。一个损坏主题不会阻止其他主题或 App 启动；错误文件和原因会显示在 Appearance 页面。目录只读取非递归的常规 JSON 文件，最多 128 个，每个最大 1 MiB，不跟随目录或符号链接。

## 可复制模板

以下是 Desktop 模板。Rust GUI 请使用上方的独立模板，其 `$schema` 为 `https://ash.dev/schemas/app/color-theme.schema.json`。

保存为 `ash-aurora.json`：

```json
{
  "$schema": "https://ash.dev/schemas/color-theme.schema.json",
  "version": 1,
  "id": "ash-aurora",
  "label": "Ash Aurora",
  "colorScheme": "dark",
  "colors": {
    "workbench.background": "#0b1020",
    "editor.background": "#0b1020",
    "editor.foreground": "#dbe7ff",
    "sideBar.background": "#10172a",
    "auxiliaryBar.background": "sideBar.background",
    "panel.background": "sideBar.background",
    "titleBar.background": "#080d18",
    "titleBar.foreground": "#edf4ff",
    "titleBar.actionForeground": "#dbe7ff",
    "input.background": "#18223a",
    "input.border": "#31446d",
    "focusBorder": "#7aa2f7",
    "accent.foreground": "#89b4fa",
    "button.primaryBackground": "#4169a8",
    "button.primaryHoverBackground": "#527bbd",
    "selection.background": "#29466f",
    "list.activeSelectionBackground": "#29466f",
    "toolbar.hoverBackground": {
      "op": "transparent",
      "value": "#ffffff",
      "factor": 0.2
    }
  }
}
```

只覆盖与基础方案不同的语义 token，不要复制整张颜色表。未覆盖 token 会继承 `colorScheme` 对应的注册表默认值，因此产品新增 token 后，用户主题仍可形成完整快照。

## 字段契约

| 字段 | 约束 |
| --- | --- |
| `$schema` | 可省略；存在时必须使用模板中的 Schema URL |
| `version` | 当前固定为 `1` |
| `id` | 稳定、唯一、小写 kebab-case；不能与内置或其他用户主题重复 |
| `label` | Settings 中显示的名称，1–80 个已去除首尾空格的字符 |
| `colorScheme` | `light`、`dark`、`high-contrast-light` 或 `high-contrast-dark` |
| `colors` | 已注册颜色 token 到颜色值的映射，最多 512 项 |

普通颜色值可以是：

- 十六进制颜色：`#rgb`、`#rgba`、`#rrggbb`、`#rrggbbaa`；
- 另一个 token ID，例如 `"panel.background": "sideBar.background"`；
- 下述受支持的颜色变换对象。

## 颜色变换

透明度：

```json
{
  "op": "transparent",
  "value": "foreground",
  "factor": 0.5
}
```

变亮或变暗：

```json
{
  "op": "lighten",
  "value": "editor.background",
  "factor": 0.12
}
```

`op` 也可以是 `darken`。`factor` 必须在 0 到 1 之间。

混合：

```json
{
  "op": "mix",
  "value": "editor.background",
  "other": "accent.foreground",
  "factor": 0.2
}
```

合成到不透明背景：

```json
{
  "op": "opaque",
  "value": {
    "op": "transparent",
    "value": "#ffffff",
    "factor": 0.15
  },
  "background": "editor.background"
}
```

变换最多嵌套 8 层。未知字段、未知 token、循环引用、非法颜色或不满足透明度契约都会让该主题文件加载失败。

## 主题生效范围

一个成功注册的用户主题会自动出现在 Settings → Appearance，并使用实际快照生成预览。选择后以下消费者使用同一快照：

- Workbench CSS custom properties 与 Stanza editor token 颜色；
- composer CodeEditor、multi-diff editor、terminal ANSI palette 与 scrollbar；
- Desktop Terminal 前景、背景、光标、选择色和完整 ANSI palette；
- Windows/Linux 原生标题栏按钮区域；
- 状态栏、菜单、输入框、列表和其他语义组件。

Rust GUI 的选择值保存在 profile `config.toml` 根级 `[gui]`，并可同时设置编辑器字体：

```toml
[gui]
theme = "ash-aurora"
interfaceFontFamily = "sans-serif"
interfaceFontSize = 13
editorFontFamily = "monospace"
editorFontSize = 13
editorLineHeight = 20
```

Desktop 的选择值保存在 profile `configuration.json`，对应主题文档位于 `themes/*.json`；Rust GUI 的主题文档位于 `app/themes/*.json`：

```json
{
  "version": 1,
  "values": {
    "workbench.colorTheme": "ash-aurora"
  }
}
```

各字段都可省略。`system` 表示跟随操作系统并在内置 Light/Dark 之间切换；界面字体默认使用 `sans-serif` 13px，编辑器默认使用 `monospace` 13px / 20px。Rust GUI 收到新的 Config generation 后即时应用主题选择、界面字体与编辑器字体；Desktop 保存和预览也会即时更新。外部修改主题文件后，Rust GUI 仍需重启才能重新读取文件内容。Ash Code TUI 使用独立主题格式，选择值写入 `config.toml` 的 `[tui].theme`，不消费本模板描述的图形界面主题。

## 开发与验证

修改 Desktop Loader、Schema 或 token 后，在 `ash-ts` 目录运行：

```text
pnpm test:main
pnpm typecheck:renderer
pnpm build
```

Rust GUI 的解析器或资源变更运行 `just check ash-ui-theme`、`just test ash-ui-theme` 和 `just rust-warnings ash-ui-theme`。不再运行跨端生成命令。

只修改用户主题 JSON 不需要重新构建 App。

## 已有共享主题

Desktop 的现有主题和路径保持有效。以前同时用于 Rust GUI 的主题需要单独安装：

1. 保留 `themes/<id>.json` 给 Desktop 使用。
2. 将需要用于 Rust GUI 的文件复制到 `app/themes/<id>.json`；已有同名文件时先比较内容，不能直接覆盖。
3. 把副本的 `$schema` 改为 `https://ash.dev/schemas/app/color-theme.schema.json`，按 Rust 自有目录核对 token。
4. 在 `[gui].theme` 中选择该 ID，重新启动 GUI 并检查加载诊断。

两份文件独立维护。程序不会自动读取 Desktop 目录、覆盖用户文件或猜测跨端 token 对应关系。
