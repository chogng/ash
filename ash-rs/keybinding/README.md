# `ash-keybinding`

供 Rust GUI 和 TUI 使用的通用快捷键规则库。各端自己管理命令、默认键位、焦点、连续按键超时、配置读写和设置界面；本 crate 只共享规则算法，不依赖 UI 或 App Server。

## 职责

1. 表示和解析标准按键、修饰键、一至四段快捷键序列及 `when` 条件，并提供序列化和显示标签。
2. 根据条件、规则来源、优先级和注册顺序匹配命令或阻止规则，返回命令、等待后续按键、阻止或不匹配。
3. 编译各端提供的用户规则，校验字段、平台覆盖、命令和条件，报告重复规则；不读写文件、不执行命令。

## 文件与调用方

| 文件 | 内容 |
| --- | --- |
| `key.rs` | 按键、修饰键和按键序列类型 |
| `parser.rs` | 按键序列解析、序列化和标签 |
| `context.rs` | 条件表达式解析和求值 |
| `binding.rs` | 规则集合、来源和优先级 |
| `resolver.rs` | 条件与按键序列匹配 |
| `user.rs` | 用户规则编译、平台覆盖和重复诊断 |

[App Workbench](../../app-rs/workbench/platform/keybindings.rs) 和 [Ash Code TUI](../../code/tui/src/keymap.rs) 在本端转换输入事件，再调用本库。两端的命令和配置相互独立。TypeScript 端保留自己的实现，通过同一份 [一致性测试向量](../../resources/keybindings/conformance.json) 验证共同规则。

完整的端侧边界、配置格式与优先级见[快捷键架构](../../docs/keybindings.md)。

## 验证

```sh
just check ash-keybinding
just test ash-keybinding
```

现有测试覆盖解析和序列化、条件、优先级、阻止规则、多段匹配、严格用户配置编译及跨语言一致性向量。
