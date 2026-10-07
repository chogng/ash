# `ash-subscriptions`

本 crate 负责订阅账户与模型目录的后台观察周期。它从 `ash-login` 读取脱敏账户状态，按当前账户触发供应商资料和模型目录刷新，并且只在模型结果变化时发出带账户身份的事件。

账户登录、凭据和脱敏状态仍由 `ash-login` 与供应商适配器负责；模型发现由 `SubscriptionCatalog` 的实现负责。App Server 装配观察器，并把 `ModelsUpdate` 转成对外通知，不保存观察周期或重试状态。
