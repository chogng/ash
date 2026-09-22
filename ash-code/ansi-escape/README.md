# `ash-ansi-escape`

> 当前 transcript 调用路径见 [`ash-tui`](../tui/README.md)。本文拥有 ANSI 到 Ratatui 转换的当前实现契约、
> failure semantics、测试和扩展边界。

`ash-ansi-escape` 是 `ash code` 产品边界内的窄 presentation adapter。它把可能包含 ANSI SGR
的文本转换为 owned `ratatui::text::Text`，让 TUI 可以渲染颜色和 modifier，而不会把原始 terminal
escape bytes 放入 Ratatui buffer。它不拥有工具输出、Thread state、PTY、terminal grid、scrollback、
transcript layout 或主题选择。

## 公共契约

| Symbol | 职责 | Failure semantics |
| --- | --- | --- |
| `ansi_text` | ANSI SGR → Ratatui styles；移除其他 terminal control sequence；tab → 四空格 | best-effort、无 `Result`；解析失败时移除 ESC byte 并返回 plain text |

调用关系固定为：

```text
ash-tui transcript renderer
  → ash_ansi_escape::ansi_text
  → ansi_to_tui::IntoText
  → ratatui::text::Text<'static>
```

原始 stdout/stderr 继续由 protocol 和 Thread presentation state 保存；本 crate 只在 render boundary
生成 owned presentation value。不得让它读取 protocol DTO、修改 Thread message、维护跨 chunk VT
parser state，或依赖 `ash-terminal`。完整 PTY terminal emulation 属于
[`ash-terminal`](../../app/terminal/README.md)，不是此 adapter 的扩展方向。

## 内部实现与修改影响

| Symbol | 可见性 | 职责 | 修改影响 |
| --- | --- | --- | --- |
| `expand_tabs` | private | 固定把 tab 投影为四空格，避免 transcript gutter 碰撞 | 同步检查 tab 测试和调用方 gutter contract |
| `ansi_to_tui::IntoText` | dependency boundary | 解析 SGR、过滤非展示 escape sequence、生成 owned spans | 升级时必须与 workspace Ratatui 版本保持类型兼容 |

当前依赖 `ansi-to-tui 7`，对应 workspace 的 Ratatui `0.29` 类型。若升级 Ratatui，必须先验证
`Text`/`Line` 类型仍来自同一 Ratatui generation，不能在调用方做跨版本转换。

## 测试

```bash
cargo test -p ash-ansi-escape
cargo test -p ash-tui
bazel test //ash-code/ansi-escape:ansi-escape-unit-tests
```

测试覆盖 SGR color、raw escape byte 移除、OSC/CSI control sequence 过滤和 tab projection。新增
escape family 时，应在本 crate 增加字符串到 styled spans 的语义测试；不得使用截图或像素基线。
