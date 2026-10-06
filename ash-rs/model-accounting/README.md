# `ash-model-accounting`

> 当前 crate 实现契约；跨组件设计见 [`docs/model-accounting.md`](../docs/model-accounting.md)。

- 加载并校验不可变价目表，内置 2026-09-04 加速公开价目表，按实际模型、服务等级、区域、上下文区间和生效时间选择唯一规则。
- 使用整数金额计算逐项参考成本，明确区分完整、部分和未计价结果。
- 当前内置卡只覆盖公开按量 API 的全局加速价格；订阅套餐、未列区域和其他模型保持未计价。crate 不负责供应商请求、模型选择、持久查询、预算账本或界面。

`checked_record_reference_cost` 根据一次已记录的参考成本计算新的按币种汇总，保留精确金额和
完整度；金额无效或累计溢出时返回失败。Core 的 Thread reducer 调用它并提交结果，本 crate
不修改 Thread 状态。`ash-protocol` 只拥有调用事实和汇总结果的数据格式。
