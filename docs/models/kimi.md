# Kimi Code 订阅账户

Kimi Code 通过设备码登录。Ash 保存并更新这次登录的凭据，再用它访问固定的 Kimi Coding API。账户使用 `kimi-subscription` 标识，模型仍归在 `kimi` 厂商下。其他订阅的对比见[订阅计划接入与额度](../subscriptions.md)，套餐名称见[订阅套餐一览](plans-and-pricing.md)。

## 登录与凭据

用户从 `/config → Providers → Kimi` 发起登录。Ash 展示授权地址和一次性代码；登录成功后，`ash-kimi` 把凭据保存在 Ash profile SecretStore，并负责续期和登出。账户接口只返回可展示的状态，不返回 access token 或 refresh token。

模型请求使用固定的 `https://api.kimi.com/coding/v1/chat/completions`。Kimi Code 订阅与 Kimi 开发者 API 使用不同的凭据和请求目标；一次订阅请求失败不会改用 API 密钥。接口和凭据细节见 [`ash-kimi` README](../../ash-rs/kimi/README.md)。

## 套餐与额度

目前 Ash 无法从 Kimi 查询具体套餐等级，因此账户页不显示“计划”，账户快照中的 `plan` 为 `null`。`account/rateLimits/read` 也不支持 Kimi，`/usage` 不显示 Kimi 额度。登录成功只表示凭据可用，不代表 Ash 已核实用户购买的套餐。
