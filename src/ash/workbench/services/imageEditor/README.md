# 扩展图片编辑服务

`IImageEditorService` 管理外部 Provider、代码图片快照和附件目标。Browser 与 Native 共用 Workbench 内的 Webview 呈现，HTML 使用现有 Webview 的独立来源和文档级消息通道。Native 适配器仅获取当前窗口所在显示器的桌面图片，不创建编辑窗口。

扩展的 initialize、ready、complete 协议保持不变。Pin 和权限操作不属于扩展协议。复制使用 Clipboard Service；保存使用 File Dialog 与 File Service。取消、扩展停用或请求替换时释放本次 Webview。

内置截图不经过 Provider 解析或扩展呈现，选区、标注和原生覆盖窗口由 `screenshotTool` 与 `platform/screenshot` 持有。图片解码、缩放和编码归 `platform/imageResize`；附件身份和草稿归属由 Chat 管理。
