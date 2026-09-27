# GLM：BigModel 与 Z.AI 接入

BigModel 和 Z.AI 各有 Coding Plan 与开发者 API 两种接入，共四个独立连接。[官方 ZCode](https://zcode.z.ai/en/docs/configuration) 支持通过账号授权使用 Coding Plan，也支持手动填写 Coding Plan Key。**Ash 目前只实现手动填写套餐 Key**，没有 BigModel 或 Z.AI 的账号授权登录，因此不会产生 Ash 登录账户，也无法读取实际套餐。订阅页显示“已启用”只表示密钥和端点配置完成，不表示 Ash 已核实套餐权限。其他订阅的对比见[订阅计划接入与额度](../subscriptions.md)，套餐名称见[订阅套餐一览](plans-and-pricing.md)。

## 连接与请求目标

| 入口 | 连接 ID | 请求目标 |
| --- | --- | --- |
| BigModel Coding Plan | `bigmodel-coding-plan` | `https://open.bigmodel.cn/api/coding/paas/v4` |
| Z.AI Coding Plan | `zai-coding-plan` | `https://api.z.ai/api/coding/paas/v4` |
| BigModel API | `bigmodel` | BigModel 标准 API 端点 |
| Z.AI API | `zai` | Z.AI 标准 API 端点 |

四个连接分别保存密钥和端点，同一 GLM 厂商下只启用一个连接。已有的 Z.AI API 密钥不会自动用于 Coding Plan。模型引用统一使用 `zai` 厂商 ID；连接 ID 决定实际使用哪个服务。选择与请求规则见[供应商凭据边界](../model-provider.md#6-供应商凭据边界)。

## 状态与退出

Ash 目前不能查询这两个 Coding Plan 的实际套餐等级或账户额度。它们不支持 `account/rateLimits/read`，也不会出现在 `/usage` 中；上游是否允许请求，要以实际调用结果为准。

在订阅页按 `l` 退出某个 Coding Plan 时，Ash 只停用该连接，保留其密钥，方便再次连接。另一个 Coding Plan 和两个 API 连接的密钥不受影响。配置和选择规则见[登录与账户系统](../login.md#订阅入口与-api-入口)。
