# Kimi Code 订阅账户

Kimi Code 通过设备码登录。Ash 保存并更新这次登录的凭据，再用它访问固定的 Kimi Coding API。账户使用 `kimi-subscription` 标识，模型仍归在 `kimi` 厂商下。其他订阅的对比见[订阅计划接入与额度](../subscriptions.md)，套餐名称见[订阅套餐一览](plans-and-pricing.md)。

## 登录与凭据

用户从 `/config → Providers → Kimi` 发起登录。Ash 展示授权地址和一次性代码；登录成功后，`ash-kimi` 把凭据保存在 Ash profile SecretStore，并负责续期和登出。账户接口只返回可展示的状态，不返回 access token 或 refresh token。

模型请求使用固定的 `https://api.kimi.com/coding/v1/chat/completions`。Kimi Code 订阅与 Kimi 开发者 API 使用不同的凭据和请求目标；一次订阅请求失败不会改用 API 密钥。接口和凭据细节见 [`ash-kimi` README](../../ash-rs/kimi/README.md)。

## 套餐与额度

`account/read` 用当前 Ash 登录查询 `/coding/v1/me`，把上游返回的昵称、邮箱和 `user_level_name` 显示在账户页；缺失的套餐保持为空。`account/rateLimits/read` 查询 `/coding/v1/me` 和 `/coding/v1/usages`，`/usage` 显示服务端实际返回的五小时、每周和每月额度窗口及重置时间。某个窗口未返回时不补造数值；月度 Code 用量占月度总量的份额不显示成独立额度。每次运行 `/usage` 都重新查询，登录状态本身不代表套餐或额度已核实。
