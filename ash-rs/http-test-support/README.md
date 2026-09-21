# HTTP test support

- 提供本地 HTTPS 测试服务器、请求记录和原始 HTTP 响应构造。
- 管理随机回环端口、连接等待上限和服务线程回收。
- 持有测试 CA、服务端证书与密钥；对调用方只暴露 CA 字节和标准 `Write` 接口。
- 仅通过 `dev-dependencies` 使用，Bazel 目标标记为 `testonly`。
- 只依赖 `rustls` 和标准库，不依赖产品 HTTP 客户端、操作层或业务协议。

## 使用方与验证

| 使用方 | 验证职责 | 命令 |
| --- | --- | --- |
| `http-client` | HTTPS 重定向、超时和响应截断 | `just test ash-http-client transport_tests` |
| `ash-client` | 实际传输中的取消与禁止重试策略 | `just test ash-client operation::tests` |
| `backend-client` | 后端路由、认证、JSON 与业务错误映射 | `just test ash-backend-client transport_tests` |

- 测试服务每个连接处理一个带 `Content-Length` 的请求；响应关闭连接。它是受控测试设施，不作为通用 HTTP 服务使用。
- `Server::start` 接受写入回调，允许测试保持响应未完成；`Server::request` 等待请求后，测试可用通道协调取消或超时。
- 实际 TLS 握手、请求读取、响应写入和服务回收由上述三个使用方的集成测试覆盖。
- `fixtures` 中的证书原来自 `livekit-client/tests/fixtures`，覆盖 `localhost` 与 `127.0.0.1`，有效期为 2026-09-16 至 2036-09-13。
- 私钥是公开测试数据。CA 只加入每个测试客户端的配置，不修改系统信任或环境代理。
