# Terminal 进程接入

此目录提供 Renderer 与交互式 PTY 后端之间的进程契约。Shell 进程、授权目录、输出缓冲和重连租约的最终判定由 Rust 后端拥有；这里不保存终端屏幕、Tab 或活动实例。

`common/terminal.ts` 同时提供宿主输出 PTY 的启动配置、进程事件、标题属性和启动/关闭契约，供 `services/terminal/common/embedderTerminalService.ts` 与 Terminal contribution 共享。这部分只覆盖宿主输出生命周期；完整 VS Code child process 的输入、signal、通用属性和解析后数据确认仍待接入 Rust 能力，没有添加空操作实现。

| 文件 | 职责与生产入口 |
| --- | --- |
| `common/terminal.ts` | 前端进程契约：profile、带真实 PID/启动目录的创建、文本或原始字节输入、尺寸、增量字节输出、关闭和连接状态；退出码使用 `undefined` 表达未知，由 `IRendererHost.terminal` 提供给 Workbench |
| `browser/appServerTerminalProcessService.ts` | 本地 Electron 与已连接 Web 的协议适配；通过现有 Renderer protocol client 调用 `terminal/*`，创建 `connectionOwned` 进程 |
| `browser/reconnectableTerminalProcessService.ts` | SSH Electron 的完整进程适配器：保存和旋转 token，在新 connection generation attach 原 PTY，恢复最后尺寸；宿主直接选择这个服务对象 |
| `browser/disconnectedTerminalProcessService.ts` | 无后端的 UI 运行环境明确拒绝进程操作；不创建模拟 Shell |

两个适配器消费同一个 `AppServerProtocolClient`。创建结果的 ready 信息来自 Rust；文本走 `terminal/write`，原始字节只在适配边界编码为 base64 后走 `terminal/writeBinary`，不经过 UTF-8 转换。普通与 SSH 读取都经过同一 DTO 转换入口，在适配边界把 base64 解码为原始 `Uint8Array`，把 nullable 退出码转为前端 `undefined`；多字节字符和控制字节不会经过逐块文本解码。重连租约管理复用该 client 的状态和代次，只恢复已有 PTY，不自行建立连接。Main 负责 connection acquisition、透明 relay，以及运行时更换通知，不解析 `terminal/*`，也不保存终端 token。

`terminalId` 与 `dirId` 一起定位对应后端资源；多根 Workspace 必须保留创建时的 `dirId`。本地进程随 connection 关闭而结束。SSH 的 `reconnectable` 进程可在同一后端内保留 30 秒，成功 attach 会旋转 token；后端进程重启、租约过期或明确 runtime replacement 后不能恢复原 PTY。token 只存在于 Renderer 的进程适配层，不进入 Workbench 实例契约、日志、持久化或 Main 的业务状态。

`common/terminal.ts` 导出 `ITerminalProcessService` 的 DI 标识。Workbench 与 Sessions 注册 `IRendererHost.terminal` 后，Terminal contribution 经容器注入进程服务与 Workspace。SSH 宿主不再把普通服务和租约管理的方法拼成另一份对象。三处适配器没有上游同职责的 Rust 协议或 Ash 宿主文件，用户已确认保留这些专属职责；通用 backend、child process 和 process manager 仍须在对应上游路径实现。当前创建、分页读取与命令游标仍为 Ash 现有契约，尚未等同 VS Code 的事件型 API，见 [Terminal 对齐台账](../../../../docs/terminal-api-alignment-status.md)。

后端链路是 `app-server/src/server/terminal_operations.rs` → `exec-server/src/terminal.rs` → `utils/pty`；App Server 只校验和分发协议，`exec-server` 拥有交互进程，PTY 工具层拥有操作系统句柄、原始字节、尺寸和进程终止。协议及 decoder 由 `app-server-protocol` 生成，不能在此手改生成物。

重连测试当前仍位于 `test/electron-main/reconnectableTerminalMainService.test.ts`，正文已经测试 Renderer 实现；路径与职责不一致，迁移涉及旧文件退出，须取得准确路径确认。
