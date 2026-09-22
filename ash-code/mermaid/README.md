# Mermaid

- 将 Mermaid 文本解析并排版成终端字符行，不依赖 Ratatui。
- 支持矩形节点、单向连线、连线标签和四个方向的无环流程图。
- 支持时序图参与者、消息、返回消息与自调用。
- 以终端字符宽度排版，限制输入大小、节点数量和输出面积。
- 不支持的语法、无法无歧义排版的连线或超出宽度时返回错误，由 TUI 保留源码显示。
- TUI 负责 Markdown 围栏完整性、主题、缓存和流式消息。
- 验证：`just check ash-mermaid`、`just test ash-mermaid`、`just rust-warnings ash-mermaid`。
