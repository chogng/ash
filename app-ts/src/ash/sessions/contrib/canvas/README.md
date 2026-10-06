# 公共画布

`canvas` 是与 `creator` 平级的 Sessions contrib。七个 Creator 模式的画布编辑器使用这份实现；其他空间编辑器也可以通过相同接口挂载自己的内容。

| 模块                                                          | 职责                                                               |
| ------------------------------------------------------------- | ------------------------------------------------------------------ |
| [CanvasViewport](common/canvasViewport.ts)                    | 每个视图的缩放、平移、视口坐标转内容坐标与缩放锚点                 |
| [Canvas](browser/canvas.ts)、[canvas.css](browser/canvas.css) | 空间容器、网格、内容挂载、视口变换、选框、光标、主题订阅和焦点提示 |
| [CanvasInputController](browser/canvasInputController.ts)     | 滚轮导航、指针捕获、坐标换算、手势完成与取消                       |

调用方为每个视图创建 CanvasViewport，创建并释放 Canvas 和输入控制器，向 `setContent` 传入自己拥有的 DOM。`CanvasInputParticipant` 根据点击对象和当前工具选择手势，接收内容坐标，负责编辑预览与提交。共享输入层只在对应指针释放时完成编辑，取消捕获丢弃预览；释放控制器会取消当前手势并移除监听。Canvas 释放主题订阅并移除自己的 DOM。

文档、选中对象身份、对象命中、路径控制点、编辑命令、撤销历史、保存与资源引用归所属编辑器。内容视图和输入参与者由编辑器组合；公共画布不导入 Creator、具体模式或会话 provider。画布本身没有独立菜单或页面入口，随实际调用它的编辑器加载。

编辑器拥有可聚焦的具名区域、键盘操作、无障碍帮助、文本内容视图和状态播报。Canvas 呈现共享焦点提示，装饰性选框对辅助技术隐藏。每个视图拥有独立 CanvasViewport，共享文档不会共享相机。

单元测试位于 [test](test)，验证缩放锚点、捕获与取消约定。实际键盘、滚轮、绘制、主题和多视图行为沿用 [编辑器测试](../../test/browser/designEditorWidget.test.ts)；Playwright 的 Sessions Design 与 Creator 场景覆盖 Browser 和 Electron UI 调用链。
