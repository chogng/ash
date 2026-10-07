# `ash-app-server-client`

`ash-app-server-client` 隔离 App Server 连接和 typed protocol 调用，具体职责只有三项：

1. `AppServerSession` 管理 stdio 连接、initialize/schema 校验、事件流和显式 shutdown；通过 `process_id()` 暴露所拥有的子进程身份。进程内连接只在本 crate 测试或显式启用 `in-process` 特性的契约测试中编译。
2. `AppServerClient<T>` 提供由 protocol crate 定义的 typed request/response 接口，不复制路径解析、目录授权或运行时策略。
3. `StdioAppServerCommand` 只携带产品选择的进程参数和环境；目录、cwd 与 capability 通过正式协议传递。

产品宿主使用单独打包的 `ash-app-server` 程序；普通客户端依赖不编译服务实现。协议契约见 [`docs/ash-app-server-api.md`](../../docs/ash-app-server-api.md)。

```text
just test ash-app-server-client
```
