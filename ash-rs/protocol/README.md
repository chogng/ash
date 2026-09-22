# `ash-protocol`

- 定义稳定 ID，以及 Thread、Turn、Item、交互、工具、执行策略、模型调用事实和精确费用字符串等共享领域类型；`Session` 只是按 `session_id` 聚合 Thread 的只读视图。
- `ThreadCommand` 表达意图，`ThreadEvent` 是唯一持久事实，`ThreadUpdate` 服务订阅者；没有 Session command、event、update 或独立 sequence。
- `ModelImageInputPolicy` 表达各图片清晰度的尺寸和 patch 上限，由模型实现提供，Core 在准备请求时消费。
- 本 crate 只拥有共享数据类型及 serde/schema 契约，不拥有 reducer、运行时、数据库或产品 UI。
