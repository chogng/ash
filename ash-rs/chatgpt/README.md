# `ash-chatgpt`

- `chatgpt-subscription` 复用本机 Codex 登录；产品入口只读凭据，不接管创建、刷新或登出。
- `chatgpt-plan` 使用 Ash 独立 OAuth 注册；profile 的 SecretStore、host ID、刷新锁和注册版本与 Codex 隔离。
- 模型请求绑定连接、用户及工作区身份，凭据变化不得跨账号或跨连接重试。
- 通过 `backend-client::chatgpt` 查询本机登录账号额度；账号改变时拒绝旧结果。
- 订阅目录刷新读取本机账号加速限制，套餐、账号和观察有效期共同决定资格。独立授权不继承 Codex 的权益观察或模型缓存。

[连接优先级、存储与验证](../../docs/models/chatgpt.md)。
