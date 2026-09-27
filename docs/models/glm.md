# GLM：BigModel 与 Z.AI 接入

BigModel 和 Z.AI 各有 Coding Plan 与开发者 API 两种接入，共四个独立连接。两个 Coding Plan 会只读使用本机 ZCode 已登录的个人版 Coding Plan 账号；没有对应账号时，按[官方 ZCode](https://zcode.z.ai/en/docs/configuration) 的流程打开浏览器，在 Ash 内登录并保存请求凭据。订阅页不要求填写 Key。开发者 API 仍单独录入 API key。Ash 尚不能读取 Coding Plan 的实际套餐或额度。其他订阅的对比见[订阅计划接入与额度](../subscriptions.md)。

## 连接与请求目标

| 入口 | 连接 ID | 请求目标 |
| --- | --- | --- |
| BigModel Coding Plan | `bigmodel-coding-plan` | `https://open.bigmodel.cn/api/coding/paas/v4` |
| Z.AI Coding Plan | `zai-coding-plan` | `https://api.z.ai/api/coding/paas/v4` |
| BigModel API | `bigmodel` | BigModel 标准 API 端点 |
| Z.AI API | `zai` | Z.AI 标准 API 端点 |

ZCode 登录保存在其用户目录的 `~/.zcode/v2/credentials.json`，Ash 每次调用前直接读取当前账号和请求密钥，不复制到 Ash，也不修改 ZCode 文件；若设置了 `ZCODE_DATA_BASE_DIR`，则读取该目录下的 `.zcode/v2/credentials.json`。Ash 自己发起的登录分别保存账户和内部请求凭据。两个开发者 API 连接各自保存用户输入的密钥。模型引用统一使用 `glm` 厂商 ID；四条连接按 BigModel 订阅 > Z.AI 订阅 > BigModel API > Z.AI API 选择已就绪的一条。已有的 Z.AI API 密钥不会自动用于 Coding Plan。选择与请求规则见[供应商凭据边界](../model-provider.md#6-供应商凭据边界)。

自动获取 Ash 内部请求密钥时，只有一个机构或项目就直接使用；有多个时只接受名称恰好为“默认机构”或“默认项目”的唯一条目。无法明确选择时登录失败，不会按列表顺序创建密钥。

## 状态与退出

Ash 目前不能查询这两个 Coding Plan 的实际套餐等级或账户额度。它们不支持 `account/rateLimits/read`，也不会出现在 `/usage` 中；上游是否允许请求，要以实际调用结果为准。

在订阅页按 `l` 退出 Ash 自己登录的 Coding Plan 时，Ash 删除该订阅保存的账户和内部请求凭据。复用 ZCode 账号时，需在 ZCode 退出登录；Ash 不删除外部凭据。另一个 Coding Plan 账户和两个 API 连接的密钥不受影响。配置和选择规则见[登录与账户系统](../login.md#订阅入口与-api-入口)。
