# JavaScript Debugger

Ash 的独立 Rust 调试 provider，通过现有 SDK 注册配置、连接和生命周期 tracker。具体 JS／TS 调试使用官方 `vscode-js-debug` standalone DAP server，固定版本、大小和 SHA-256 见 `runtime.json`。构建负责下载校验及许可证分发；最终用户使用 Ash 管理的 Node，无需 Rust 工具链。

- `node`／`pwa-node`：Node launch、attach；`chrome`／`pwa-chrome`、`msedge`／`pwa-msedge`：浏览器调试。
- `debug.javascript.autoAttachFilter` 默认 `disabled`；`always`、`smart`、`onlyWithFlag` 对新建集成终端生效。smart 排除路径 glob 由 `debug.javascript.autoAttachSmartPattern` 指定，默认 `node_modules`。
- 命令面板的“调试: 切换自动附加”（`ash.debug-javascript.toggleAutoAttach`）可选择模式及用户／工作区设置；默认写入已有工作区覆盖所在层，否则写入用户设置。启用后状态栏显示当前模式，点击可再次切换。临时禁用／恢复不改设置、不停止已有会话，并对同一终端后续启动的程序生效；临时禁用期间新建的终端也可恢复。自动附加设置变化或扩展重新激活会清除临时禁用状态。
- 自动附加的环境集合不持久化；broker 绑定窗口 workspace 和 loopback Inspector，鉴权、并发、输入和等待均有界。Node preload 只负责 Inspector 运行时交互，策略和启动留在 Rust。
- 停止 attach 只分离终端程序；停用／撤权使旧终端凭据失效。Rust helper 在 broker 失联或拒绝时恢复等待的 Node，避免终端被挂住。
- adapter server 通过既有进程树 owner 启动；最后一个会话 lease 释放后关闭。stdin EOF 同时覆盖 provider 意外退出。

配置示例及工作流边界见 [调试系统](../../docs/debugging.md#javascript-调试自动附加与服务就绪)。验证：`just verify ash-debug-javascript`；真实 Desktop 场景使用 `pnpm run smoketest test/smoke/areas/debug/debug-workflows.spec.ts`。
