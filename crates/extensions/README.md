# `ash-extensions`：此前的 Rust 作者 SDK

产品扩展方向已改为 TS/JS 扩展、TS SDK 与 Rust 后端业务接口。本 crate 不再作为产品作者 SDK
继续建设，当前源码和 Cargo 成员仍在，尚未完成退场。扩展作者不应以它为新扩展的开发入口。
确定的职责、GitHub 示例和权限边界见
[`编辑器扩展系统`](../../docs/editor-extensions.md#0-确定的产品方向)。

## 当前源码及验证状态

此前实现了命令、Hover、文档快照、Output、合作式取消和激活作用域释放。
[`src/bin/review.rs`](src/bin/review.rs) 与 [`tests/host.rs`](tests/host.rs) 保留独立扩展进程的示例和测试，
基础能力曾通过真实 Supervisor 和 stdio 调用验证。

之后追加的扩展反向调用服务代码已暂停，尚未完成协议生成和端到端验证；这些改动不能计为可用作者 API。
本 README 不再提供 Rust 作者入门步骤，也不再把补齐 Rust SDK 当作后续计划。

| 现有部分                                  | 当前职责                               | 目标处理                                                                  |
| ----------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------- |
| `src/lib.rs`、`languages.rs`、`window.rs` | Rust 回调、注册与 Output 接口          | 作者能力改由 TS SDK 承担                                                  |
| `runtime.rs`、`cancellation.rs`           | Rust 程序的 stdio 分发、并发回调与取消 | 扩展入口由独立 JS 运行环境执行，生命周期由 TS 宿主管理                    |
| `client.rs`                               | 尚未完成验证的反向服务请求补充         | 不再沿 Rust 作者 SDK 扩展，权限与业务调用在 TS SDK / 宿主 / Rust 服务接入 |
| `ash-editor-extension-protocol`           | 现有可执行 Host v1 的共享 wire 定义    | 按生产调用方清理；目标业务协议继续由 Rust owner 生成                      |

包安装、授权记录、资源目录和 Rust 领域业务具有独立用途。SDK 退场不等于删除这些能力，也不把
GitHub、Git、存储或凭据逻辑搬回扩展包。静态目录实现属于
[`ash-extension-catalog`](../extension-catalog/README.md)；现有进程 Host 的记录属于
[`ash-editor-extension-host`](../editor-extension-host/README.md)。

## 源码退场时的同步要求

清理本 crate 时，同批处理 Cargo workspace 和 lockfile、Bazel、CI、Host 的依赖和调用方、示例与测试。
保留其他领域的系统工具和外部进程能力，不以新方向为由删除无关运行时。
验证应覆盖真实 TS/JS 扩展的注册、调用、取消、释放和授权拒绝，不能用旧 Rust 示例通过来证明新运行方式完成。
