# `ash-external-ext-sdk`：Rust 作者 SDK 与能力扩展复用

目标产品同时支持 Electron / Rust-V8 宿主中的 TS/JS 扩展与独立 Rust 程序中的能力扩展。Rust 扩展承接从共享核心拆出的可选业务，通过公开版本化契约供 App 和 TUI 按需使用，不需要 Node/V8，也不链接到核心进程。
本 crate 的公共 `Extension`、typed DataChannels、activation-scoped Services 和 stdio runtime 已用于 [`GitHub authentication`](../../extensions/github-authentication/README.md) 的独立 Rust 试点。具体 Provider 不链接进 App Server；通用认证契约由 `ash-login::extension` 定义，GitHub 消费者契约保留在 `ash-github`。
确定的职责、GitHub 示例和权限边界见
[`扩展架构与编辑器接入`](../../docs/editor-extensions.md#0-确定的产品方向)。

本 crate 已迁入根目录 `sdk/rust`，包名为 `ash-external-ext-sdk`，Rust 导入名为 `external_ext_sdk`；TS/JS 作者接口放在 `sdk/typescript`。两类扩展共享接入与监管语义，TS/JS 的 VS Code/Node API 兼容不并入 SDK，也不使 Rust 扩展依赖 V8 或 App Server。确定的命名与目录见[共享接入与语言适配的 crate 边界](../../docs/editor-extensions.md#共享接入与语言适配的-crate-边界)；本次保留原有 API 与通信行为，运行时兼容改造另行实施。

## 当前源码及验证状态

此前实现了命令、Hover、文档快照、Output、合作式取消和激活作用域释放。
[`src/bin/review.rs`](src/bin/review.rs) 与 [`tests/host.rs`](tests/host.rs) 保留独立扩展进程的示例和测试，
基础能力曾通过真实 Supervisor 和 stdio 调用验证。

`data_channels.rs` 复用现有 DataChannel 注册和 `receiveData` 调用，要求闭合的请求／响应类型。`services.rs` 复用有界反向请求，绑定 profile activation 的 incarnation／generation；Host 逐 Provider 授予秘密命名空间与 HTTP 端点，不开放完整后端连接。现有 `client.rs` 的窗口编辑器调用仍需按各自能力独立验证。

| 现有部分                                  | 当前职责                               | 目标处理                                                                    |
| ----------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------- |
| `src/lib.rs`、`languages.rs`、`window.rs` | Rust 回调、注册与 Output 接口          | 能力注册用于 Rust Provider；编辑器模型与 UI 保持客户端所有权                |
| `runtime.rs`、`cancellation.rs`           | Rust 程序的 stdio 分发、并发回调与取消 | 独立 Rust 程序 runtime 已供产品 Provider 复用；进程监管与权限由共享宿主拥有 |
| `client.rs`                               | 绑定发起窗口的编辑器服务调用           | 按公开能力接口补验证；不开放 App Server 私有方法或完整后端连接              |
| `ash-external-ext-protocol`               | 现有可执行 Host v1 的共享 wire 定义    | 按生产调用方清理；目标业务协议继续由 Rust owner 生成                        |

包安装、授权记录和资源目录继续由共享基础设施拥有。GitHub 认证已进入产品 Rust 扩展，API 业务拆分仍是后续工作；通用 Git、存储、SecretStore 和最终授权仍由共享服务拥有。静态目录实现属于
[`ash-external-ext::packages`](../../crates/external-ext/src/packages/README.md)；现有进程 Host 的记录属于
[`ash-external-ext`](../../crates/external-ext/README.md)。

## 迁移与验证要求

后续接口或模块迁移仍需同批处理 Cargo workspace 和 lockfile、Bazel、CI、Host 的依赖和调用方、示例与测试；不以 SDK 目录搬迁代替具体能力验证。
保留其他领域的系统工具和外部进程能力，不以新方向为由删除无关运行时。
验证应分别覆盖真实 TS/JS 包与独立 Rust 程序的注册、调用、取消、释放和授权拒绝；现有 Node 路径按当前实现验证，不能当作目标 Rust/V8 兼容层已经完成。Rust Provider 需检查 App/TUI 共用语义，以及未启用可选登录扩展时 TUI 没有启动依赖；旧 Rust 命令或 Hover 示例通过不能证明认证能力完成。
