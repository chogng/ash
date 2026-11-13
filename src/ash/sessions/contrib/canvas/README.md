# 公共画布

`canvas` 是与 `artifact` 平级的 Sessions contrib。共享的 Artifact 编辑器使用这份实现，其他空间编辑器也可以通过相同接口挂载自己的内容。

| 模块                                                          | 职责                                                               |
| ------------------------------------------------------------- | ------------------------------------------------------------------ |
| [canvasGeometry](common/canvasGeometry.ts)                    | 点、旋转框、局部坐标转换、贝塞尔采样和包围框；不依赖作品模型       |
| [CanvasViewport](common/canvasViewport.ts)                    | 每个视图的缩放、平移、视口坐标转内容坐标与缩放锚点                 |
| [Canvas](browser/canvas.ts)、[canvas.css](browser/canvas.css) | 空间容器、网格、内容挂载、视口变换、选框、光标、主题订阅和焦点提示 |
| [CanvasInputController](browser/canvasInputController.ts)     | 滚轮导航、指针捕获、坐标换算、手势完成与取消                       |

调用方为每个视图创建 CanvasViewport，创建并释放 Canvas 和输入控制器，向 `setContent` 传入自己拥有的 DOM。`CanvasInputParticipant` 根据点击对象和当前工具选择手势，接收内容坐标，负责编辑预览与提交。共享输入层只在对应指针释放时完成编辑，取消捕获丢弃预览；释放控制器会取消当前手势并移除监听。Canvas 释放主题订阅并移除自己的 DOM。

`CanvasPoint`、`CanvasBounds` 和 `CanvasFrame` 是几何类型的唯一声明。视口、指针输入、选框显示和作品编辑器共用这些类型。`CanvasViewport.fitBounds` 负责缩放和居中；调用方决定要显示的对象、可用视口及工具占用的留白。

文档、选中对象身份、对象命中、路径控制点、编辑命令、撤销历史、保存与资源引用归所属编辑器。内容视图和输入参与者由编辑器组合；公共画布不导入 Artifacts、具体模式或会话 provider。画布本身没有独立菜单或页面入口，随实际调用它的编辑器加载。

编辑器拥有可聚焦的具名区域、键盘操作、无障碍帮助、文本内容视图和状态播报。Canvas 呈现共享焦点提示，装饰性选框对辅助技术隐藏。每个视图拥有独立 CanvasViewport，共享文档不会共享相机。

单元测试位于 [test](test)，验证缩放锚点、捕获与取消约定。实际键盘、滚轮、绘制、主题和多视图行为沿用 [编辑器测试](../../test/browser/artifactEditorWidget.test.ts)；Playwright 的 Sessions Design 与 Artifacts 场景覆盖 Browser 和 Electron UI 调用链。

## 与 Canvases 宿主的边界

本地 VS Code 的 `src/vs/workbench/contrib/canvases` 通过 `ICanvasContextService` 表达会话归属，`ICanvasService` 管页面解析与呈现，`CanvasEditor` 和 `CanvasView` 借用浏览器页面。Ash 对应的 [Canvases 契约](../../../workbench/contrib/canvases/common/canvas.ts) 和 [CanvasView](../../../workbench/contrib/canvases/electron-browser/canvasView.ts) 保持这条职责链，通过 `WebContentsViewHost` 承载网页。

该宿主管页面身份、会话归属、编辑器展示与关闭；空间 Canvas 管几何、相机与指针交互。共享的矢量文档、命中规则、选中对象身份、渲染和编辑事务仍由作品编辑器持有。Artifacts 的目录、固定入口和文件恢复也归所属功能。

Design 当前的 HTML 预览使用 Browser 和 Electron 共用的 sandbox iframe。接入会话 Canvases 时，需要提供页面 URL、会话 owner 和实例生命周期，并分别覆盖 Browser 与 Electron；不能仅替换 DOM 容器就改变页面的归属及关闭语义。
