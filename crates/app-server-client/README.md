# `ash-app-server-client`

`ash-app-server-client` 隔离 App Server 连接和 typed protocol 调用，具体职责只有三项：

1. `AppServerSession` 管理 stdio 连接、initialize/schema 校验、事件流和显式 shutdown；通过 `process_id()` 暴露所拥有的子进程身份。进程内连接只在本 crate 测试或显式启用 `in-process` 特性的契约测试中编译。
2. `AppServerClient<T>` 提供由 protocol crate 定义的 typed request/response 接口，不复制路径解析、目录授权或运行时策略。
3. `StdioAppServerCommand` 只携带产品选择的进程参数和环境；目录、cwd 与 capability 通过正式协议传递。

产品宿主使用单独打包的 `ash-app-server` 程序；普通客户端依赖不编译服务实现。协议契约见 [`docs/ash-app-server-api.md`](../../docs/ash-app-server-api.md)。

stdio 命令必须在 stdin EOF 后退出，转发程序必须等待其服务进程结束。`shutdown` 与 stdio 会话的 Drop 先停止并 join 写入线程，关闭其唯一持有的 stdin，再等待命令退出及读取线程结束；initialize 或协议兼容性校验失败也走同一清理路径。不能只杀掉转发程序并把 stdout 读取取消当作服务进程退出，否则 Windows 上服务进程仍可能持有 profile 的 SQLite 文件。进程内会话不拥有子进程，保留原有通知关闭方式。

EOF 清理回归同时覆盖 Windows 与 Unix 的 shutdown、Drop、协议不兼容和服务端拒绝。夹具在连接中持有文件，只在收到 EOF 并关闭文件后写入完成标记；Unix 另要求 PID 已退出且 `lsof` 没有文件占用，再立即删除目录。Linux/macOS 的完整库测试接入 `rust-warnings.yml` 的 `stdio-lifecycle` 作业。

初始化遇到 `-32600` 与 `data.kind = ServerShuttingDown` 时保留为 `ClientError::ServerShuttingDown`，不从消息文字猜测停止状态。连接重试期限与用户提示由 CLI 或其他产品客户端拥有。

```text
just test ash-app-server-client
```
