# ash-utils-stream-parser

这个 crate 负责增量解析模型输出文本。它维护跨 chunk 状态，把可立即显示的文本与隐藏内容分开；网络 SSE/JSON framing 仍由 provider 层负责。

## 契约

- `StreamTextParser` 定义字符串 chunk 的 `push_str` 与流结束时的 `finish`。
- `InlineHiddenTagParser` 按字面量识别跨 chunk 的行内标签并提取内容。
- `CitationStreamParser` 处理 `<oai-mem-citation>`，`AssistantTextStreamParser` 组合 citation 与 `<proposed_plan>` 解析。
- `ProposedPlanParser` 只把独占一行的 `<proposed_plan>` 标签识别为计划边界。
- `Utf8StreamParser` 适配可能拆开 UTF-8 code point 的原始字节流。

所有状态化解析器必须在输入结束时调用 `finish`。未闭合的完整隐藏标签会在结束时自动闭合并作为隐藏内容返回；仅与起始标签前缀相同的普通文本会恢复为可见文本。

当前 `ash-core` 在 assistant 文本流边界使用普通消息模式：citation 不进入 `ThreadUpdate`，最终消息也会使用相同规则清理。Ash 的正式计划状态仍由结构化 `update_plan` 工具维护，不能用 `<proposed_plan>` 替代。

## 验证

运行 `cargo test -p ash-utils-stream-parser` 验证跨 chunk 标签、计划块和 UTF-8 边界。改动 assistant 流接入时同时运行 `cargo test -p ash-core` 中对应的流式测试。
