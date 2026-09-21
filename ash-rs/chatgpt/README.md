# `ash-chatgpt`

- 检测 Codex 安装：存在时只读复用凭据，不存在时由 Ash 维护 ChatGPT 登录。
- 按 Codex 格式创建、刷新及重新登录；串行更新并校验现有记录，保留省略的 token 字段与其他元数据。
- 向模型请求和登录控制面提供当前认证状态；断开仅影响 Ash，真实模型测试固定 Luna / low。
- 通过 `backend-client` 查询指定账号额度；复用认证维护，账号改变时拒绝返回旧结果，HTTP 401 最多恢复一次。

[存储约定与验证](../../docs/chatgpt-subscription.md)。
