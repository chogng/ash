# Backend models

保存 Ash 已接入供应商的后台业务 HTTP 请求与响应类型。类型按接口所属服务组织，保留上游字段、计量单位和可空语义；客户端在发送或接收时负责校验，账户领域负责解释与生命周期。

| 模块 | 合约与单位 |
| --- | --- |
| `chatgpt` | 账户、额度、配置、云任务、费用与报表；额度窗口和重置时间以秒计，微单位整数与十进制金额字符串保持精度 |
| `kimi` | Code 账户与用量；`used_ratio` 为比例，重置时间保留时区，月度 Code 份额独立保留 |
| `supergrok` | 账户、访问设置、credits 账单与模型目录响应；百分比保留小数和超过 100 的值，金额为整数 USD 分 |
| `coding_plan` | BigModel 与 Z.AI 实际共用的业务响应、账户范围、内部请求凭据及额度结构；`nextResetTime` 为毫秒 |
| `zai` | Z.AI 专属业务令牌交换；后续 Coding Plan 查询使用共同合约 |

## 所有权

- 依赖仅为 Serde、JSON 与时间类型，不依赖 HTTP、登录、凭据存储、模型调用或 UI。
- HTTP 路由、认证头、取消、业务状态码检查、账户范围选择、请求／响应 ID 对应检查属于 [`backend-client`](../backend-client/README.md)。
- 上游额度、金额和时间的 JSON 编解码属于本 crate；缺失值不产生零用量或允许状态。Grok proto3 的空金额对象明确表示零，与缺失金额对象不同。
- 云任务文本／差异提取与账户集合排序属于客户端。客户端 `TaskDetails.data` 保存本 crate 的 `TaskDetailsResponse`，解释方法由客户端提供。
- 模型目录中的扩展字段和云任务中的不透明元数据保留 JSON，客户端只解释已接入的字段。模型生成和流式事件合约仍由 `ash-api` 管理。
- Ash 的账户 RPC 类型由 `app-server-protocol` 拥有；本 crate 不生成前端类型，也不替代 Ash 自己的账户、额度或账单契约。
- 套餐、额度窗口、业务状态和云任务不跨供应商合并。`coding_plan` 的共用来自两个区域接口现有的同一合约。
- 凭据交换类型不派生 `Debug`，避免通过对象打印泄露令牌或请求密钥。

## 类型来源与验证

当前是从 `backend-client` 迁出的手写合约，未接入 OpenAPI 自动生成，也不声称覆盖供应商完整后台 API。ChatGPT 合约参照同级 Codex 仓库 `90abcfac02665ad882853a04155591cd863b2ca7` 的 `codex-backend-openapi-models` 与 `backend-client`；Grok 合约的上游版本与接口依据记录在客户端 README。Kimi 与 Coding Plan 合约沿用 Ash 现有接口实现及其传输测试。

有可靠上游 schema 时，在相应供应商模块固定 schema 和生成器版本，独立管理生成文件；手写类型与生成文件分别维护。未提供 schema 的接口继续以明确类型和响应样本验证，不自行编造完整 OpenAPI 文档。

`tests/fixtures` 是合成的合约样本，不含真实账户或凭据。样本覆盖开放套餐与功能名、超额用量、缺失与空值、秒与毫秒的差别、时区、超出 JavaScript 精确整数范围的金额，以及 proto3 的明确零值。`contract_tests.rs` 验证独立解码和请求序列化；客户端测试继续覆盖路由、认证、取消、响应校验、写入不重放及实际 HTTPS 调用链。

```sh
just check ash-backend-models -p ash-backend-client
just test ash-backend-models -p ash-backend-client
just test ash-backend-models -p ash-backend-client --features serde_json/arbitrary_precision
just rust-warnings ash-backend-models -p ash-backend-client
just dependencies
```
