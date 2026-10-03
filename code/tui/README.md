# `ash-tui`

`ash-tui` 是 Ash Code 的 Ratatui 界面 crate，接收 CLI 交付的已初始化 `AppServerSession`。

- [Ash Code README](../README.md)：实现入口、输入与功能接入、配置、主题和测试。
- [LAYOUT.md](../LAYOUT.md)：fullscreen 与 inline 的页面区域、历史输出、面板、状态归属和终端生命周期。
- [lib.rs](src/lib.rs)：crate 的公开接口。

从仓库根目录运行 `just ash`；验证入口见 [Ash Code 测试](../README.md#测试与支持边界)。

终端文本快照统一放在 [`snapshots/`](snapshots)，按实际绘制的模式和功能目录查证：

| 目录 | 内容 |
| --- | --- |
| `snapshots/fullscreen/` | 全屏页面、模态框及模式切换后绘制的全屏画面 |
| `snapshots/inline/` | Inline 页面、临时面板及模式切换后绘制的 inline 画面 |
| `snapshots/shared/` | 不依赖屏幕模式的组件、正文渲染及提示文字 |

各目录再按 `home`、`header`、`composer`、`mode`、`widgets` 等测试所属功能划分。文件名只保留场景名，例如 `fullscreen/home/help_chinese.snap`；快照头部的 `source` 指向测试源码，测试仍放在所属实现旁边。

完整 App 画面使用 `crate::tui_assert_snapshot!(app = &app; "场景名", rendered)`，由该 App 的 `screen_mode()` 决定目录，不能按测试源码位置或场景名猜测模式。单独绘制模式专属组件或汇集同一模式的多帧时使用 `mode = ScreenMode::Fullscreen` 或 `mode = ScreenMode::Inline`。共享组件使用不带模式参数的同一宏。短小的源码内快照仍留在测试中。

迁移或修改快照后运行 `just test ash-tui --lib`；包含进程内 App Server 的测试另运行 `just test ash-tui --lib --features in-process-tests`。按 [test-tui](../../.agents/skills/test-tui/SKILL.md) 审阅并接受具体基线。
