# `ash-kimi`

`ash-kimi` 是 Kimi Code 订阅的本机认证 owner。它实现 device authorization、token polling、refresh、SecretStore envelope、provider-scoped logout 和构造 Kimi Coding API 所需的 authenticated `ResolvedApiTarget`。

它通过 `InteractiveLoginDriver` 只向 `ash-login` 返回授权 URL、一次性 user code 与脱敏账户状态。access token、refresh token、device code 和内部 SecretKey 不进入 App Server RPC、普通配置、Thread 事件、日志或 telemetry。

模型路径使用 `https://api.kimi.com/coding/v1/chat/completions`。Ash 发送自己的 `User-Agent`、`X-Msh-Platform`、版本和随机 device ID，不复用其他客户端的品牌 identity。OAuth wire 以 [官方 Kimi CLI OAuth 源码](https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/auth/oauth.py) 为依据，并与 [CLIProxyAPI 的 Kimi adapter](https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/auth/kimi/kimi.go) 交叉验证。

当前 credential key 是 `provider/kimi/current/oauth`。value 是由本 crate 私有解释并在 token rotation 时整体替换的 JSON envelope；`ash-secrets` 只把它作为 opaque bytes 保存。

Desktop Models 设置页经窄 account IPC 启动登录；系统浏览器和剪贴板副作用由 Electron main 持有。Renderer 不接收 token，refresh 后的 credential revision 通过 `LoginService` 主动更新脱敏账户状态。

用户看到的登录与额度行为见 [Kimi Code 订阅账户](../../docs/models/kimi.md)，套餐名称见[订阅套餐一览](../../docs/models/plans-and-pricing.md)。
