# Design

Design 统一提供视觉编辑、代码查看、HTML 运行预览和 Agent 对话入口，不注册独立 Make 模式。

- [design.contribution.ts](browser/design.contribution.ts) 注册 Design 模式、代码面板贡献和恢复入口。
- [designWorkspace.ts](browser/designWorkspace.ts) 组合共享画布编辑器与 HTML 预览。预览开启时显示代码与运行结果，关闭或隐藏工作区时释放 iframe 执行上下文。
- [designCodeWidget.ts](browser/code/designCodeWidget.ts) 展示当前文档生成的代码，提供导出操作。
- [designCodeGenerator.ts](browser/code/designCodeGenerator.ts) 从同一份文档生成 HTML/CSS/SVG，供代码面板、预览和对话附件使用。

Build with Agent 保留 Design 编辑页，通过现有 SessionsPart 准备附带 `design.html` 的未发送草稿。发送、执行和生成文件仍由既有 Chat 流程负责，不创建第二份对话模型。当前不自动将 Agent 返回的 HTML 反向写入画布对象。

文档、历史、选区、绘图、文本和 SVG 渲染属于 [Artifacts 共享画布编辑器](../artifact/README.md)。空间视口和指针捕获属于 [Canvas](../canvas/README.md)。Design 不持有这些能力的副本。
