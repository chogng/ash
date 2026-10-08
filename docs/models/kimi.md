# Kimi Code 连接

Ash 将自己的 Kimi Code 登录与本机 Kimi Desktop、Kimi Code CLI 的连接分开。三者的模型分别使用 `kimi/<型号>`、`kimi-desktop/<型号>` 和 `kimi-cli/<型号>`；凭据各自独立。其他订阅的对比见[订阅计划接入与额度](../subscriptions.md)，套餐名称见[订阅套餐一览](plans-and-pricing.md)。

## 登录与凭据

`kimi-subscription`：用户从 `/config → Providers → Kimi` 发起设备码登录。Ash 展示授权地址和一次性代码；登录成功后，`ash-kimi` 把凭据保存在 Ash profile SecretStore，并负责续期和登出。账户接口只返回可展示的状态，不返回 access token 或 refresh token。

模型请求使用固定的 `https://api.kimi.com/coding/v1/chat/completions`。Kimi Code 订阅与 Kimi 开发者 API 使用不同的凭据和请求目标；一次订阅请求失败不会改用 API 密钥。接口和凭据细节见 [`ash-kimi` README](../../crates/kimi/README.md)。

`kimi-desktop`：本机安装并登录 Kimi Desktop 后，Ash 只读使用它写入的 Kimi Code 运行配置。每次模型请求都重新读取当前凭据，请求目标是 `https://agent-gw.kimi.com/coding/v1`。Ash 不导入桌面端 OAuth、不保存这份凭据，也不替桌面端续期或登出。桌面端提供的模型由该网关 `/models` 返回；Ash Code 的 `/model` 列表会读取这些型号，不借用 `kimi-subscription` 的静态模型清单。可以使用 `/model kimi-desktop/k2d8-preview` 选择当前网关返回的该型号；实际可用型号以网关响应为准。

`kimi-cli`：Ash 读取 `KIMI_CODE_HOME` 或 `~/.kimi-code/config.toml` 中 `managed:kimi-code` 的 OAuth 文件引用，并从 `credentials/` 读取当前 access token、从 `device_id` 读取登录设备标识。模型来自 CLI 配置端点的 `/models`。Ash 不修改 CLI 配置或凭据；CLI 负责续期。令牌过期后须在 Kimi Code 中刷新，Ash 会重新读取。只有源码、没有 CLI 登录凭据时，这条连接不会就绪。

Ash Code 的 `/model` 与 Ash Desktop 模型选择器从后台读取当前凭证范围的缓存模型目录；共享后台发现外部连接模型，读取列表本身不发起网络请求。凭证变化时，上一范围的模型会退役；同范围临时网络失败保留已知元数据。可分别用 `kimi-desktop/<型号>`、`kimi-cli/<型号>` 选择。

外部连接只用于模型调用和模型目录。`/config → Providers → Kimi`、账户页和 `/usage` 仍对应 Ash 自己的 `kimi-subscription` 登录。桌面端连接是否可用，以桌面端当前运行配置和实际网关请求为准。

## 套餐与额度

后台账户观察用当前 Ash 登录查询 `/coding/v1/me`，把上游返回的昵称、邮箱和 `user_level_name` 更新到账户页；缺失的套餐保持为空。`account/rateLimits/read` 查询 `/coding/v1/me` 和 `/coding/v1/usages`，`/usage` 显示服务端实际返回的五小时、每周和每月额度窗口及重置时间。某个窗口未返回时不补造数值；月度 Code 用量占月度总量的份额不显示成独立额度。每次运行 `/usage` 都重新查询，登录状态本身不代表套餐或额度已核实。
