# Response debug context

- 提取响应头中的请求 ID、边缘链路 ID 和认证错误码。
- 只保留选定字段；拒绝重复头、过长值和非标识符文本，限制编码错误头的解析大小。
- 定义每次调用的首次失败、首次 HTTP 401、最后一次请求及凭据恢复结果。
- 只记录认证头名称、固定结果分类；不保存密钥、URL、请求正文或响应正文。
- 提供诊断接收接口；不依赖模型 API、Core、凭据存储、传输实现或日志后端。

## 调用边界

`model-provider` 在 HTTP／SSE 操作返回后、API 错误转换前收集证据，供模型生成、OpenAI 兼容模型目录、连接探测和远端输入计数共用。
每次调用独立记录；认证恢复后的请求只更新 `latest`，不会覆盖 `firstFailure` 或 `firstUnauthorized`。
`credentialsRecovered` 只表示取得可重试的凭据，调用最终结果由 `outcome` 表示。

`attempts` 统计调用方提交的操作次数，包含认证恢复后的调用；底层客户端内部的传输重试不逐次展开。
认证头名称表示客户端提交给操作接口的认证信息，不证明上游已经收到该头。
WebSocket 握手及 OAuth token 端点没有通过此 HTTP／SSE 调用包装器；不将其结果冒记为模型响应。

宿主通过 `with_response_diagnostics` 注入接收接口。App Server 将最近 64 次调用保存在内存诊断快照中，
`diagnostics/read` 和 `feedback/prepare` 读取同一份证据；反馈上传仍由用户审阅后授权。

## 验证

```sh
just test ash-response-debug-context
just test ash-model-provider
just test ash-diagnostics
just test ash-app-server local_provider_diagnostics_reach_the_reviewed_feedback_bundle
```
