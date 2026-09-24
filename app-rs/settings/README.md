# `ash-settings`

1. 根级 `lib.rs` 是 crate 入口；Settings 页面包含 General、Appearance、Keybindings 和 Remote，Remote 页面直接承载连接列表、Name/SSH Host/Workspace 输入框及 Save/Delete/Connect 操作。
2. `ash-settings` 只拥有输入、焦点、布局和展示状态并返回类型化请求；Remote 目标校验、连接目录、持久化、SSH/runtime 与 Tunnel 生命周期由 `ash-rs/remote*` 提供。
3. 产品宿主只映射主题和工作区信息、转发平台输入，并把 UI 请求交给对应 `ash-rs` 能力；进程、窗口和平台事件仍由宿主组合。

验证：`just test ash-settings`。
