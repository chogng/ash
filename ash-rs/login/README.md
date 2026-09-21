# `ash-login`

`ash-login` 拥有 Ash 的脱敏多 Provider 交互式账户控制面。它按 stable provider ID 注册 driver、分配稳定的登录 ID、跟踪活动中的尝试、投影带版本的账户集合，并发布登录完成与账户事件。供应商适配器继续拥有 OAuth 协议、回调、凭据持久化、刷新和登出 I/O。

## 所有权与执行

`LoginService` 是状态所有者，`InteractiveLoginDriver` 是由消费方拥有的供应商端口，`LoginEvents` 是产品宿主的输出端口。正常路径如下：

```text
LoginService::begin
→ InteractiveLoginDriver::begin(BeginLoginRequest { exact LoginId, method })
→ BeginLogin::Browser | BeginLogin::DeviceCode
→ provider adapter observes completion
→ LoginService::complete
→ LoginEvents::login_completed
→ LoginEvents::account_updated on success
```

`LoginService::cancel` 只接受仍处于活动状态的精确 `LoginId`，并委托给拥有该 provider 的 driver。`LoginService::logout_provider` 只向对应驱动传递 `AccountRef`，随后清除该 provider 的脱敏投影并递增版本号。`refresh` 读取全部 driver 的脱敏快照，并且只在账户集合变化时发布。

每个供应商独立记录读取版本。读取期间若该供应商完成登录、登出、另一次读取或账户更新，则丢弃旧结果；其他供应商的有效结果仍可更新。

## 失败与安全契约

`LoginErrorKind` 提供稳定的内部分类；产品协议映射这些分类，不转发供应商载荷。公共类型和事件均不得包含 access token、refresh token、API key、cookie、authorization code、PKCE state、secret-store reference 或 credential path。

用户订阅只在供应商提供并允许稳定的交互式 OAuth 时注册为 `LoginMethod`。没有受支持 OAuth 的供应商仍由模型凭据领域接受 API key；API key 不是登录方法，也不能作为 OAuth 失败后的隐式降级。

生产环境的 ChatGPT 与 Kimi 订阅实现分别位于 `ash-chatgpt` 和 `ash-kimi`，都在本机执行 device OAuth、refresh 并使用 SecretStore。本 crate 保持供应商无关，也不依赖这些适配器。这里的测试使用 fake driver，使身份、取消、版本和事件语义不依赖任何供应商网络实现。
