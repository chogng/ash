# Diagnostics

- 有界诊断快照、构建身份、固定活动分类、结果和耗时；不读取聊天、文件、环境变量或凭据。
- 通过 `diagnostics/read` 读取快照；本 crate 不上传数据。
- `responses` 保留最近 64 次模型相关调用的诊断证据，首次失败与认证恢复后的结果分别保存；字段与边界见 [response-debug-context](../response-debug-context/README.md)。
- 验证：`just test ash-diagnostics`。

诊断快照接收产品宿主提供的 `BuildInfo`；诊断库不读取 Git，也不持有编译提交号。
