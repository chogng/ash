# `app-rs`：Rust 桌面端

`app-rs/` 拥有 `app` 窗口程序及其端内交互。它使用 `ash-rs/` 的 App Server
读取和修改 Agent 会话，通过同一个 `ASH_HOME` profile 与 Electron 桌面端、TUI 和 CLI
连接同一个后台进程；它不调用 `ash-cli/` 的 `ash` 命令。

| 目录 | 职责 |
| --- | --- |
| `zui/`、`ui-components/`、`icons/` | 窗口、绘制、通用组件和图标 |
| `workbench/`、`session/` | 窗口布局、Agent 会话与输入 |
| `editor/`、`editor-core/`、`text-file/`、`files/` | 编辑器状态、文件生命周期与文件界面 |
| `terminal/`、`terminal-runtime/` | 端内终端语义与外部命令的宿主接线 |
| `settings/`、`theme/`、`keybindings/` | 本端设置、主题与快捷键 |

窗口、编辑器和终端网格留在本目录；会话、线程、执行与持久化通过共享 App Server
提供。跨产品的边界见 [产品线说明](../docs/product-lines.md)，详细设计见
[本端文档](docs/README.md)。

从仓库根运行 `just build-app` 构建，`just app` 启动，`just check app` 和
`just rust-warnings app` 验证 Rust 包。
