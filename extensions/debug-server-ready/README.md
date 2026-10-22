# Server Ready Action

独立 Rust 工作流，通过现有 SDK 观察 DAP tracker 和所属会话的集成终端输出。它不持有第二份 DAP 会话状态，也不扫描其他终端。

`serverReadyAction` 支持 `openExternally`、`startDebugging`、`debugWithChrome` 和 `debugWithEdge`。`pattern` 使用 Rust `regex` 语法，至少一个捕获组；不支持反向引用与 lookaround。`uriFormat` 恰好包含一个 `%s`，外部 URI 限 HTTP(S)。命名 `name` 和内联 `config` 二选一，`killOnServerStop: true` 通过既有父子会话契约绑定子配置。

适配器创建的子会话共享父配置的单次触发代次；分块／ANSI 输出在有界缓冲中匹配。tracker 回调只匹配及入队，可能重入 Debug 的启动／Opener 操作放在有界后台队列。重启重置触发代次；结束、停用、撤权和断连取消在途调用并释放队列。

配置示例见 [调试系统](../../docs/debugging.md#javascript-调试自动附加与服务就绪)。验证：`just verify ash-debug-server-ready`；真实 Desktop 的控制台／集成终端、命名子配置和原生 Opener 场景在 `test/smoke/areas/debug/debug-workflows.spec.ts`。
