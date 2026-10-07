# Super Grok 订阅账户

Super Grok 可以在 Ash 中通过设备码登录。如果运行 Ash 后端的主机已有可用的 Grok 登录，Ash 也可以只读使用它。账户使用 `xai-subscription` 标识，模型仍归在 `xai` 厂商下；开发者 API 密钥是另一种接入。其他订阅的对比见[订阅计划接入与额度](../subscriptions.md)，套餐名称见[订阅套餐一览](plans-and-pricing.md)。

## 登录与凭据

用户从 `/config → Providers → Super Grok` 发起连接。已有可用的 Grok 登录时，Ash 直接连接；否则展示设备授权地址和一次性代码。Ash 自己登录的凭据保存在 profile SecretStore，由 `ash-supergrok` 刷新和登出。

没有 Ash 登录凭据时，Ash 可以读取后端主机的 `~/.grok/auth.json`。它只使用当前登录的 access token，不复制或刷新 Grok 的 refresh token，也不写回该文件。用户在 Ash 中断开这种借用的登录，只会在 Ash 保存停用状态；Grok 自己的登录不受影响。之后在 Ash 登录的凭据优先于 Grok 文件。细节见 [`ash-supergrok` README](../../crates/supergrok/README.md)。

## 套餐、额度与模型

后台账户观察从当前账户和 Grok Build 设置中读取套餐名称，优先显示服务端返回的完整名称。借用 Grok 登录时，Ash 只在内存里保留与当前 token 对应的账户资料；token 变化后，后台自动读取新资料。

`account/rateLimits/read` 查询当前订阅的使用比例、周期和余额。每次打开 `/usage` 都会重新查询，与 ChatGPT 额度分开显示。账户就绪后，订阅页通过 `provider/models/list` 读取该账户可用的模型；内置 `model/list` 目录不代表账户已经有使用权限。xAI 开发者 API 的密钥、模型目录和请求目标与 Super Grok 订阅分开。

订阅后台观察器会检查 Grok 凭据变化，并定期刷新已登录账户资料和模型目录。账户或模型发生变化时通过 App Server 向客户端发送通知；再次进入订阅页直接显示已知状态，不因导航重复请求远端。

模型目录系统把发现结果写入 profile 的 `cache/models/xai.json`，按账户和连接分开保存。xAI API 密钥连接从 Platform 的 `/v1/language-models` 读取模型，并写入同一文件中的 API 部分。目录读取失败时，界面会分别显示密钥保存和模型列表的结果。
