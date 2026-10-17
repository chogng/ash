# Diagnostics

- 有界诊断快照、构建身份、固定活动分类、结果和耗时；不读取聊天、文件、环境变量或凭据。
- 通过 `diagnostics/read` 读取快照；本 crate 不上传数据。
- `responses` 保留最近 64 次模型相关调用的诊断证据，首次失败与认证恢复后的结果分别保存；字段与边界见 [response-debug-context](../response-debug-context/README.md)。
- 验证：`just test ash-diagnostics`。

诊断快照接收产品宿主提供的 `BuildInfo`；诊断库不读取 Git，也不持有编译提交号。

生产业务指标由 `Metrics` 的 OpenTelemetry SDK 聚合，与诊断服务共享实例生命周期。
MCP、Skill 和 Guardian 通过宿主注入相同 meter；目录、连接和模型重建不会清空读数。
`DiagnosticSnapshot.metrics` 是累计快照，counter 的 count/total 为累计值，histogram 的 count/total 为采样数和总和，kind 区分两种聚合；distribution 保留直方图的分桶及最小/最大值。
动态标签仅含选定的业务元数据，统一清洗为最多 256 字节 ASCII；每个 instrument 最多 128 组标签，超出后累计到 SDK overflow 时间序列。
`diagnostics/read` 和用户审阅的反馈快照均包含这些指标；不自动上传。Windows 沙箱服务使用独立 meter，通过已有认证管道的 `metrics` 请求读取。
