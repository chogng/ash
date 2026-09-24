# `ash-keybindings-host`

Rust GUI 的快捷键运行能力。独立 crate 将输入、规则和连续按键状态与 Workbench 的窗口、会话及命令执行隔开；它只服务 GUI，各端仍负责自己的快捷键。

## 职责

1. 将 `zui` 按键事件转换为标准按键，支持运行时匹配与设置界面的快捷键录入。
2. 管理生效规则、连续按键、超时和阻止规则，返回匹配结果，由 Workbench 执行命令。
3. 编译和修改产品提供的用户规则，保留无关配置项；配置读写与版本检查由 Workbench 负责。

## 为什么独立

[通用规则库](../../ash-rs/keybinding/README.md) 提供按键语法、条件和匹配算法；本 crate 补上 GUI 输入适配及运行状态。Workbench 通过 `KeybindingCatalog` 提供命令、默认绑定和上下文，两者保持单向依赖。本 crate 不依赖 Workbench、Settings、App Server 或配置文件路径。

| 调用方 | 使用的能力 | 自己负责 |
| --- | --- | --- |
| Workbench | `Keybindings`、规则编译和编辑 | 命令目录、焦点上下文、配置读写、命令执行与刷新 |
| Settings | `recording_chord` | 录入界面、录入生命周期和编辑意图 |

## 文件

| 文件 | 内容 |
| --- | --- |
| `catalog.rs` | 产品提供的命令、默认绑定和条件接口 |
| `runtime.rs` | 生效规则、连续按键状态、超时和匹配结果 |
| `input.rs` | GUI 按键事件转换和录入转换 |
| `settings.rs` | 用户规则编译、诊断和内存中的配置编辑 |
| `lib.rs` | 公开接口 |

三端职责和配置格式见[快捷键架构](../../docs/keybindings.md)。TUI 的运行与设置交互由 `ash-code` 自己实现，不经过本 crate。

## 验证

```sh
just check ash-keybindings-host
just test ash-keybindings-host
just test ash-settings
just test ash-workbench keybinding
```
