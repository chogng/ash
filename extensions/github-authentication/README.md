# GitHub authentication Rust 扩展

`ash-github-authentication` 是独立 Rust 程序，拥有 GitHub.com／Enterprise 的 OAuth、账号目录、令牌刷新和授权有效性。它不需要 Node、V8 或 App Server 的私有接口。GitHub REST／GraphQL 业务暂留在 [`ash-github`](../../crates/github/README.md)，通过现有账号与凭据接口消费此 Provider。

App 的产品启动入口显式选定安装目录中的扩展 executable；`LocalProfileRuntime` 为一个 profile 保留唯一监管器与扩展进程，各目录和窗口只持有代理。没有 profile runtime 的单实例 App Server 由自己的生命周期持有它。默认 `AppServerOptions` 和 TUI 的 in-process 组合不选定扩展，也不启动 GitHub 或 Node。缺少已选定的 executable 会明确失败，不回退到核心 OAuth 或 PATH 中的程序。

## 公共接口与运行链

| 边界          | 复用接口                                                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 注册与调用    | `external_ext_sdk::Extension`、`ExtensionContext.data_channels`，注册 `authentication.github`；Host RPC v1 的 `receiveData` 承载闭合的 typed request／response |
| 通用认证能力  | `ash-login::extension::{AuthenticationRequest, AuthenticationResponse}`：读账号、开始登录、取消、注销与读取终态                                              |
| GitHub 消费者 | `GitHubAccountManager`、`GitHubCredentialProvider` 与 `GitHubAuthenticationRequest`；grant 引用绑定主机、账号和授权代次                                      |
| 通用核心服务  | `ExtensionContext.services` 与 `CoreServiceRequest`：SecretStore、一次 HTTP 请求；不开放 App Server method 或通用 IPC                                        |
| 进程          | `ExtensionHostSupervisor`、`ProductExecutableLauncher`：握手、注册、配额、deadline、取消、重启和关闭                                                         |

App 的 `account/*` 和 `github/account/*` 契约保持不变。Renderer 不保存另一份 token；仓库请求在受信任后端通过 grant 取得凭据，并在每次请求时核对授权。核心 SecretStore／HTTP 服务消息只在 Rust 扩展的私有 stdio 通道传输，不进入 App Server 的 Renderer schema 或生成的 TS 请求类型。兼容第三方 `AuthenticationSession.accessToken` 的授权桥仍未实现。

扩展只经核心服务访问 `provider/github/accounts` 和旧 `provider/github/current/oauth` 两个密钥。旧单账号迁移逻辑随实现移动，命名空间保持一致。HTTP 仍由共享产品客户端执行，沿用代理、TLS 与网络策略；认证服务只准许获授权主机的用户身份端点和产品 OAuth token broker，拒绝重定向。loopback OAuth 回调监听器由扩展拥有。

当前 launcher 面向产品发行的受信任 Rust 程序，绑定安装路径与 executable digest；`AuthorizedProduct` 不宣称操作系统沙箱隔离。此试点不开放任意第三方 Rust 包安装或执行，后续安装授权应接入现有 Manager。

## 会话与生命周期

唯一扩展实例串行保护账号目录与刷新。登录请求在代理处转换为 profile 内唯一 ID，核心在驱动启动前绑定发起连接；路由键包含目录 scope 与本地 ID，完成通知只发送给该连接；其他窗口只收到重读后的脱敏账号变化。它们保留的是 UI control plane 视图，不拥有凭据或刷新任务。

取消停止确切登录；窗口／目录释放取消该调用方仍持有的尝试，不停止其他调用方共享的 profile Provider。注销清理对应账号并使旧 grant 失效，也停止在途登录。扩展重启恢复既有凭据与公开配置，旧进程的登录尝试失败，不重放 token 连接或其他结果不确定的写入。profile 最后一个 owner 释放时关闭监管器及子进程。

公开 OAuth 配置在 profile Provider 创建时绑定；同一 profile 的冲突配置拒绝创建另一实例，调整配置需重启该 profile 的后端。

生产和 Desktop 开发打包都构建独立 executable，放入 `bin/ash-github-authentication{.exe}`；根 `extensions/github-authentication/package.json` 随预装资源分发，Rust 源码与 Cargo 构建文件不作为运行入口。

验证入口：`just verify ash-github-authentication`。认证单测覆盖既有 OAuth 与账号迁移；`tests/runtime.rs` 通过 Cargo 构建的真实 executable 和 App Server 的实际代理验证多调用方、回调、取消和注销。`test/smoke/areas/github/githubAuthentication.spec.ts` 经 Web／Electron 的实际 profile daemon 创建不同目录消费者，验证共享登录、连接取消权限与断连清理。
