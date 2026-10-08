# `ash-kimi`

`ash-kimi` 管理 Ash 自己的 Kimi Code 订阅登录，也只读接入本机 Kimi Desktop 和 Kimi Code CLI 的独立连接。订阅登录实现 device authorization、token polling、refresh、SecretStore envelope、provider-scoped logout 和构造 Kimi Coding API 所需的 authenticated `ResolvedApiTarget`。

它通过 `InteractiveLoginDriver` 只向 `ash-login` 返回授权 URL、一次性 user code 与脱敏账户状态。access token、refresh token、device code 和内部 SecretKey 不进入 App Server RPC、普通配置、Thread 事件、日志或 telemetry。

模型路径使用 `https://api.kimi.com/coding/v1/chat/completions`。Ash 发送自己的 `User-Agent`、`X-Msh-Platform`、版本和随机 device ID，不复用其他客户端的品牌 identity。OAuth wire 以 [官方 Kimi CLI OAuth 源码](https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/auth/oauth.py) 为依据，并与 [CLIProxyAPI 的 Kimi adapter](https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/auth/kimi/kimi.go) 交叉验证。

账户 ID 是当前登录 device ID 的单向 SHA-256 摘要，不是固定的 `current`。重新登录产生新的设备身份，即使 token 和 credential revision 相同也会退役旧账户；正常 token 续期保持账户 ID。额度查询、资料刷新和单账户登出必须使用当前 `account/read` 返回的 ID；旧 ID 的请求在读取新账户资料前拒绝。私有 device ID 不进入账户 RPC，已有 credential envelope 无需迁移。

当前 credential key 是 `provider/kimi/current/oauth`。value 是由本 crate 私有解释并在 token rotation 时整体替换的 JSON envelope；`ash-secrets` 只把它作为 opaque bytes 保存。

`KimiDesktop` 读取 Kimi Desktop 的 `daimon-share/daimon/runtime/kimi-code/config.toml` 中 `daimon-kimi-code` 凭据，限定目标为 `https://agent-gw.kimi.com/coding/v1`。每次请求重新读取，由 Kimi Desktop 负责凭据轮换和删除；Ash 不写入这个文件、不把它复制到 SecretStore，也不将它当作 Ash 的 OAuth 账户。桌面端模型目录来自该网关 `/models`。

`KimiCli` 读取 `KIMI_CODE_HOME` 或 `~/.kimi-code` 的 `config.toml`，按 `managed:kimi-code` OAuth 引用选择 `credentials/<name>.json`。每次请求重新读取 access token 和 CLI 的 `device_id`；CLI 负责刷新和删除凭据，Ash 不写回。过期 token 不用于调用。CLI 模型目录来自配置端点的 `/models`。

Desktop Models 设置页经窄 account IPC 启动登录；系统浏览器和剪贴板副作用由 Electron main 持有。Renderer 不接收 token，refresh 后的 credential revision 通过 `LoginService` 主动更新脱敏账户状态。

后台账户观察通过当前凭据查询 Kimi Coding API `/me`，只缓存与当前 credential revision 对应的昵称、邮箱和套餐；`account/read` 读取当前脱敏账户状态，`account/rateLimits/read` 查询 `/me` 与 `/usages`。后端请求由 `backend-client::kimi` 发送，取消、切换账号或登出后的结果不会作为当前账户资料发布。

用户看到的两条连接、登录与额度行为见 [Kimi Code 连接](../../docs/models/kimi.md)，套餐名称见[订阅套餐一览](../../docs/models/plans-and-pricing.md)。
