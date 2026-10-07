# sleep

- 提供最长 12 小时、随 Turn 取消的计时等待工具。
- 复用运行时等待内核，不启动 shell，不轮询时钟，不调用模型。
- 返回实际耗时并发布结构化等待结果。

系统职责、接口和配置见 [Agent 扩展](../../docs/extensions.md)。
工具参数、取舍和 Codex 对照见 [Agent 时间与等待](../../docs/agent-wait.md)。
