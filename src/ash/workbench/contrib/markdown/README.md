# Markdown

通用 Markdown 显示与源码辅助功能。

| 场景                     | 入口与职责                                                                                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat 消息正文            | [`ChatMarkdownContentPart`](../chat/browser/widget/chatContentParts/chatMarkdownContentPart.ts) 使用流式 Markdown 渲染，持有增量片段、DOM 复用与修正回退。 |
| Chat Docs                | [Sessions Docs 的 Arkdown 编辑器](../../../sessions/contrib/docs/ARKDOWN.md) 持有正文编辑与语法投影。                                                      |
| IDE 和 Agent Window Code | [Markdown 扩展](../../../../../extensions/markdown-language-features) 持有 Markdown 文件预览与语言能力，源码编辑使用共用 CodeEditor。                      |

| 文件                                                      | 职责                                   |
| --------------------------------------------------------- | -------------------------------------- |
| `markdown.contribution.ts`                                | 通用样式与图片粘贴贡献注册             |
| `markdownImageDropOrPaste.ts`                             | Markdown 源码中的图片拖放与粘贴        |
| `markdownPreview.ts`                                      | Webview 沙箱中的只读预览与链接事件     |
| `markdownDocumentView.ts`                                 | 产品预览宿主与链接回调，供发行说明使用 |
| `markedKatexSupport.ts`、`common/markedKatexExtension.ts` | 数学公式渲染支持                       |

[`ChatContentMarkdownRenderer`](../chat/browser/widget/chatContentMarkdownRenderer.ts) 持有聊天内容的渲染策略，流式调度位于 [`chatIncrementalRendering`](../chat/browser/widget/chatContentParts/chatIncrementalRendering/chatIncrementalRendering.ts)。通用解析和清理边界由 [`platform/markdown`](../../../platform/markdown/browser/markdownRenderer.ts) 与 [`base/browser/markdownRenderer`](../../../base/browser/markdownRenderer.ts) 持有。
