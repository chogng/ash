# 通用图片编辑服务

`IImageEditorService` 管理外部图片编辑 Provider、呈现请求、取消和输出目标。扩展适配器通过注册标识选择 Provider；内置产品界面可以直接提供可信的呈现，不参与扩展默认 Provider 解析。

Browser 与 Native 适配器分别承载隔离帧和原生窗口。`imageEditorSelection.ts` 读取代码选区、字体和语法样式快照；扩展仅接收快照，不取得编辑器模型。原生窗口、剪贴板和文件输出归 `platform/imageView`。系统权限由 Native 层提供，截图入口协调 Setup，通用图片编辑协议不提供授权操作。

内置截图的配置、选区、标注、代码图片渲染、撤销和界面构建归 [`screenshotTool`](../../contrib/screenshotTool/README.md)。通用服务不注册内置默认 Provider。
