# guardian-reviewer

- 定义版本化审核提示、响应 schema、大小限制与结果绑定。
- 通过隔离模型生成建议，拒绝权限扩大和无效响应。
- 管理审核并发、异步任务、期限、取消和暂时性失败重试。
- 不执行被审核的动作、不签发授权、不改变沙箱策略。

`ReviewModel` 必须观察取消并限制响应；`ReviewerPool` 默认最多四个并发任务、90 秒总期限，仅暂时性服务失败最多重试三次。`LlmActionClassifier` 对输入 JSON、审核提示和响应 schema 的内容总和限制为 64 KiB、估算 16K token（UTF-8 字节数除以三并向上取整），响应限制为 16 KiB。请求预算由 `guardian-context` 移除较早的可选观察，保留完整用户指令、回答、委托与已准备动作；必要内容超限时拒绝调用模型。评估样本和端到端权限契约位于 `evals/` 与 `tests/eval_contract.rs`。

系统职责、接口和配置见 [Agent 扩展](../../docs/extensions.md)。
