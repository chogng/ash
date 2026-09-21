# Backend client

- 封装 OpenAI/Codex 后端业务 HTTP API，与模型协议和 Ash 自有服务分开。
- 查询账号套餐、主次额度窗口、附加模型额度与余额；缺失信息保持为空。
- 显式选择 `/api/codex` 或 `/wham` 路由，使用调用方提供的当前账号认证。
- 复用 `ash-client` 和 `ash-http-client`；不读取凭据、不刷新 token、不维护登录状态。
- 错误仅保留分类与 HTTP 状态，不暴露地址、认证头或响应正文；支持调用方取消。
- 生产 transport 必须拒绝重定向；Ash 默认 HTTP 配置满足此要求。
- 验证：`just test ash-backend-client`。
