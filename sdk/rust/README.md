# `ash-external-ext-sdk`：Rust 作者 SDK 与能力扩展复用

目标产品同时支持 Electron / Rust-V8 宿主中的 TS/JS 扩展与独立 Rust 程序中的能力扩展。Rust 扩展承接从共享核心拆出的可选业务，通过公开版本化契约供 App 和 TUI 按需使用，不需要 Node/V8，也不链接到核心进程。
本 crate 的公共 `Extension`、typed DataChannels、activation-scoped Services 和 stdio runtime 已用于 [`GitHub authentication`](../../extensions/github-authentication/README.md) 的独立 Rust 试点。具体 Provider 不链接进 App Server；通用认证契约由 `ash-login::extension` 定义，GitHub 消费者契约保留在 `ash-github`。
确定的职责、GitHub 示例和权限边界见
[`扩展架构与编辑器接入`](../../docs/editor-extensions.md#0-确定的产品方向)。

Rust SDK 是[统一后端扩展接口](../../docs/editor-extensions.md#统一后端扩展接口规范)的 Rust 语言封装，与 TS/JS 的 [`@ash/sdk`](../typescript/README.md) 共用 Host RPC、能力契约、授权及生命周期。`ExtensionContext.client` 请求发起客户端的服务，`services` 请求获授权的后端服务，typed `data_channels` 承载领域 Provider 契约；它们是同一双向协议的端口，不是独立后端 API。Workbench 通过产品 adapter 消费同一契约，不直接链接 Rust SDK 或扩展实现。新增绑定遵循[SDK 能力开放原则](../../docs/editor-extensions.md#sdk-能力开放原则)，由现有扩展的具体需求驱动并经该消费者验证；当前 TS/Rust 覆盖差异本身不形成补齐任务。

本 crate 已迁入根目录 `sdk/rust`，包名为 `ash-external-ext-sdk`，Rust 导入名为 `external_ext_sdk`；TS/JS 作者改用 `@ash/sdk` 和 `ash.*`。两个语言 SDK 共享接入与监管语义，不使 Rust 扩展依赖 V8 或 App Server。旧作者兼容层、Open VSX下载和VSIX运行入口已删除；只读退休metadata保留原身份供停用和卸载，不提供执行或重新授权。确定的命名与目录见[共享接入与语言适配的 crate 边界](../../docs/editor-extensions.md#共享接入与语言适配的-crate-边界)。

## 独立开发

[独立扩展开发](../docs/development.md) 提供 SDK 导出、仓库外 Academy 项目、构建检查、本地加载／重载诊断及中立提交包流程。公开 `editor_client` 模块承载文档客户端 v1 的请求和经过校验的声明，Academy 已直接消费；源码 workspace 仍集中维护，导出时将依赖与 package 元数据物化为独立 Cargo manifests。导出 SDK 不携带生产 Host 实现或签名密钥。

## 当前源码及验证状态

此前实现了命令、Hover、文档快照、Output、合作式取消和激活作用域释放。
`debug.rs` 通过现有 Host RPC 注册配置 Provider 与 executable adapter factory；一个配置注册处理模板、变量替换前解析和替换后解析，不持有 DAP 会话。产品消费者见 [`debug-lldb`](../../extensions/debug-lldb/README.md)。`window.create_status_bar` 通过同一 Host RPC 发布激活作用域内的状态值，供可取消的运行包准备使用；UI 仍由发起窗口拥有。
`editors.rs` 注册自定义文本编辑器；`languages.rs` 按类型化 operation 注册语言 Provider，
并和 `workspace.rs` 观察客户端文档及配置事件。Markdown 功能扩展使用这些通用接口，
静态视图资源由客户端从所属内置包加载，文档编辑与历史保持客户端所有权。
[`src/bin/review.rs`](src/bin/review.rs) 与 [`tests/host.rs`](tests/host.rs) 保留独立扩展进程的示例和测试，
基础能力曾通过真实 Supervisor 和 stdio 调用验证。

显式停用和输入 EOF 都先取消调用，并释放 `Client` / `Services` 的等待者，再等待扩展任务退出。
已经发送的客户端请求保留有界关联以接收迟到回包；共享 token 的并发请求按 call ID 顺序发送。

`Client::show_quick_pick_items` 的 `QuickPickItem::separator` 在该选项前插入分组标题；
标题不可选择，也不改变返回的选项索引，含分组的列表保留作者顺序。
`always_show` 让创建等操作在搜索时仍然可用，并排列在搜索结果之后。标签支持 `$(icon-id)`；用户文本中的
同形内容须转义为 `\$(icon-id)`，避免被当成图标。

调用截止时间在 SDK 请求边界转换为平台 `SystemTime`；超出可表示范围时返回
`InvalidRequest`，不执行回调，进程继续处理后续请求。可表示但已过期的时间仍返回
`DeadlineExceeded`，不将溢出时间截断或改成无限等待。

`BackgroundClient::wait_for_backend_state` 按已有 sequence 等待获授权的通知，通知到达即返回，
空闲时仍有有界 tick；关闭 activation 会中断等待。原 `backend_state` 保留立即读取的行为，
没有订阅要求的调用无需携带可选的 `waitForChange` 字段。

`data_channels.rs` 复用现有 DataChannel 注册和 `receiveData` 调用，要求闭合的请求／响应类型。`services.rs` 复用有界反向请求，绑定 profile activation 的 incarnation／generation；Host 逐 Provider 授予秘密命名空间与 HTTP 端点，不开放完整后端连接。现有 `client.rs` 的窗口编辑器调用仍需按各自能力独立验证。

普通 profile JSON 状态使用 `Client::storage_get(key, token)` 和
`Client::storage_update(key, value, token)`；`None` 删除，`Some(Value::Null)` 保存 JSON null。
SQLite 对最新数据执行单 key 事务，不让不同窗口的不同 key 更新互相覆盖；没有值缓存、
公开快照、revision/CAS 或变更等待接口。

`Client::secret_load/secret_store/secret_delete` 复用已有 profile SecretStore，返回/接收
不透明 bytes；TS 接口只读写 UTF-8 字符串。Host 绑定扩展自己的命名空间，不允许选择产品
或其他包的凭据。key 最多 256 UTF-8 字节，单个秘密最多 64 KiB。
调用继承取消、deadline 与具体实例隔离；撤权/停用/卸载保留值，重新精确授权只准入新实例。
失败不降级存储，不重放不确定写入；没有秘密通知日志、cursor 或 reset 作者接口。

| 现有部分                                  | 当前职责                               | 目标处理                                                                    |
| ----------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------- |
| `src/lib.rs`、`languages.rs`、`window.rs` | Rust 回调、注册与 Output 接口          | 能力注册用于 Rust Provider；编辑器模型与 UI 保持客户端所有权                |
| `runtime.rs`、`cancellation.rs`           | Rust 程序的 stdio 分发、并发回调与取消 | 独立 Rust 程序 runtime 已供产品 Provider 复用；进程监管与权限由共享宿主拥有 |
| `client.rs`                               | 绑定发起窗口的编辑器服务调用           | 按公开能力接口补验证；不开放 App Server 私有方法或完整后端连接              |
| `ash-external-ext-protocol`               | 现有可执行 Host v1 的共享 wire 定义    | 按生产调用方清理；目标业务协议继续由 Rust owner 生成                        |

包安装、授权记录和资源目录继续由共享基础设施拥有。GitHub 认证和 API 业务分别由现有 `github-authentication` 与 `github` 扩展提供；通用 Git、存储、SecretStore 和最终授权仍由共享服务拥有。静态目录实现属于
[`ash-external-ext::packages`](../../crates/external-ext/src/packages/README.md)；现有进程 Host 的记录属于
[`ash-external-ext`](../../crates/external-ext/README.md)。

## 迁移与验证要求

后续接口或模块迁移仍需同批处理 Cargo workspace 和 lockfile、Bazel、CI、Host 的依赖和调用方、示例与测试；不以 SDK 目录搬迁代替具体能力验证。
保留其他领域的系统工具和外部进程能力，不以新方向为由删除无关运行时。
验证应分别覆盖真实 TS/JS 包与独立 Rust 程序的注册、调用、取消、释放和授权拒绝；现有 Node 路径按当前实现验证，不能当作目标 Rust/V8 兼容层已经完成。Rust Provider 需检查 App/TUI 共用语义，以及未启用可选登录扩展时 TUI 没有启动依赖；旧 Rust 命令或 Hover 示例通过不能证明认证能力完成。

Rust 调试扩展可通过 `BackgroundClient::create_terminal` 创建归属当前激活的集成终端，使用 `read_terminal` 的输出游标和关闭标记观察其生命周期，再以 `dispose_terminal` 释放。句柄绑定激活代次，其他激活无法读取或关闭；扩展退役和工作区切换时由终端桥回收。输出保留有界，`output_gap` 表示游标前的数据已被淘汰。
