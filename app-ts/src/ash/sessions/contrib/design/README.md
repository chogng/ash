# Design 编辑器

Design 是 Sessions 专属的二维设计编辑器。本目录拥有设计文档、编辑操作、画布和文件生命周期，Sessions 通过页面契约挂载它。配置、主题、快捷键、文件访问、对话框和窗口生命周期复用已有服务。

这份文档说明目录归属、状态与生命周期约定。Sessions 的页面装配见 [Sessions README](../../README.md)，窗口分层见 [LAYERS.md](../../LAYERS.md)。

## 目录与命名

文件命名参考 [Editor](../../../editor/README.md) 的职责划分：`document.ts` 表达文档，`designModel.ts` 对应文本编辑器的 `textModel.ts`，`documentCommands.ts` 承接编辑操作，`browser/widget` 放置编辑器组件。Design 的空间坐标、选区和历史由本目录实现。

| 文件 | 拥有的职责 |
| --- | --- |
| [common/core/geometry.ts](common/core/geometry.ts) | 点、对象框、坐标变换、贝塞尔计算和包围框；仅处理空间数学 |
| [common/model/document.ts](common/model/document.ts) | 设计文档与对象类型、不可变快照、文件解析和序列化 |
| [common/model/designModel.ts](common/model/designModel.ts) | `DesignModel`，已提交文档和撤销重做历史的唯一持有者 |
| [common/model/hitTest.ts](common/model/hitTest.ts) | 根据对象种类、绘制顺序和几何判断命中 |
| [common/commands/documentCommands.ts](common/commands/documentCommands.ts) | `DocumentCommands`，创建、修改、删除、分组和解组操作 |
| [common/config/editorConfiguration.ts](common/config/editorConfiguration.ts) | Design 的配置键、默认值、作用域和校验 |
| [common/selection.ts](common/selection.ts)、[common/viewport.ts](common/viewport.ts) | 每个编辑器实例的对象选区、路径节点选择和视口状态 |
| [browser/widget/designEditorWidget.ts](browser/widget/designEditorWidget.ts) | `DesignEditorWidget`，根 DOM、工具栏、属性编辑、输入、拖拽和画布渲染；样式与组件同目录 |
| [browser/svgRenderer.ts](browser/svgRenderer.ts) | 画布与 SVG 导出共用的对象渲染 |
| [browser/designDocumentController.ts](browser/designDocumentController.ts) | `DesignDocumentController`，文件身份、读取版本、保存基准和异步文件操作 |
| [browser/designEditorPage.ts](browser/designEditorPage.ts) | `DesignEditorPage`，Sessions 页面装配、布局、焦点和关闭检查 |
| [browser/design.contribution.ts](browser/design.contribution.ts) | 页面、快捷键、无障碍帮助与内容视图的注册 |

一个文件可以承接紧密相关的完整职责。几何和文档序列化目前各自保持在小模块中；新增能力时按实际职责拆分。

## 与 Editor 的关系

Design 与 Editor 共用 Base、Platform 提供的生命周期、控件、配置、主题和快捷键设施。文件与窗口关闭通过已有服务接入 Sessions。`DesignModel` 使用对象层级、空间变换和路径节点表达内容；Editor 的 `TextModel` 使用文本位置与文本编辑语义，两者各自拥有模型和历史。

当前文字内容通过属性面板的文本输入编辑，内容、字号和对象几何保存在 Design 文档中。Editor 的文字编辑组件尚未接入 Design。

## 依赖与状态归属

`common/core` 只定义空间值与计算，文档类型和可变模型依赖它。`common/model` 拥有文档及历史，命令依赖模型。`common` 使用基础 JavaScript 与所属公共服务契约；DOM、文件操作和页面装配留在 `browser`。

编辑器组件使用本目录的公共模型、命令、渲染器和文件控制器。Sessions 页面创建组件与控制器，负责将页面布局和焦点传给组件。组件持有自己的 DOM 与样式，页面通过组件接口操作它。

| 状态 | 持有者 | 保存进文件 |
| --- | --- | --- |
| 对象内容、几何、层级和绘制顺序 | `DesignModel` 的文档快照 | 是 |
| 撤销重做历史 | `DesignModel` | 否 |
| 选中对象、当前路径节点 | 每个 Widget 的 `DesignSelection` | 否 |
| 缩放和平移 | 每个 Widget 的 `DesignViewport` | 否 |
| 拖拽起点、指针捕获和预览 | `DesignEditorWidget` | 否 |
| 文件 URI、读取版本、已保存内容和操作状态 | `DesignDocumentController` | 否 |

多个 Widget 可以使用同一个文档控制器，共享已提交内容与历史，同时保留各自的选区和视口。Widget 借用控制器的模型；单独释放 Widget 会清理它的订阅、指针捕获和命令查找记录，文档仍由控制器持有。页面随 Sessions Part 释放；切换页面时 Part 保留实例。

Design 通过 `sessions.common.main.ts` 加载，当前使用方是 Sessions。Workbench 使用自己的编辑器注册；其基础层和共享服务保持既有依赖方向，不能导入本目录。

## 编辑与几何约定

文档坐标使用设计像素，100% 缩放时一个设计单位对应一个 CSS 像素。网格间隔为 12 个设计单位，显示设备的像素密度不改变文档几何。对象按数组顺序从后向前绘制，命中检测从前向后查找。旋转使用绕对象中心的顺时针角度。

路径节点及其控制点保存为对象宽高的比例；属性面板显示路径局部像素。这样改变对象尺寸时，曲线随对象一起缩放。分组子对象使用组内坐标；当前文件格式支持组的旋转与等比缩放，解组时将组变换合并进子对象的位置、尺寸和旋转。等比缩放保证解组后的子对象仍能用现有几何字段表达。

工具栏、属性面板和键盘修改通过 `DocumentCommands` 到达 `DesignModel.applyEdit`。模型每次提交一个不可变快照，清除 redo 分支并通知 Widget 更新。撤销与重做由同一个模型执行。

拖拽过程中，Widget 只更新预览。指针释放时一次提交全部受影响对象；Escape、取消捕获或取消手势丢弃预览。其他视图提交文档或开始文件操作时，会取消当前视图的预览，保持渲染与已提交状态一致。文件替换会清空编辑历史并重置每个视图的选区；普通编辑保留仍存在的对象选择。

## 文件与导出

可编辑文件使用严格的版本 1 JSON，建议扩展名为 `.ash-design.json`。文件读取先验证完整文档，再替换当前模型；失败保留当前内容。保存比较当前文档序列化结果与已保存内容来判断脏状态，并使用读取版本检查写入冲突。配置和 UI 存储各自保存偏好，不承接文档内容。

`DesignDocumentController` 调用已有文件与对话框服务。桌面和连接 App Server 的浏览器沿已有文件服务访问工作区；独立浏览器通过用户选定的文件夹访问文件。打开其他文档和桌面关闭会提供保存、放弃或取消；浏览器关闭使用同步的未保存提示。当前没有自动保存或跨窗口合并。

画布和 SVG 导出都使用 `svgRenderer.ts`。对象从文档读取，用户文字作为文本节点写入；导出仅包含作品，省略网格与选区，并保留可编辑文档的保存状态。

## 当前能力与验证入口

已具备矩形、椭圆、文字、贝塞尔路径、多选、分组、几何与属性编辑、撤销重做、文件打开保存和 SVG 导出。组尺寸按比例变化。Frames 和嵌入资源尚未实现，文字内容目前通过属性面板编辑。

无障碍入口由 contribution 注册：帮助说明可用工具和快捷键，内容视图以文本描述文档，关闭后恢复原焦点。Widget 提供键盘操作、属性输入标签和选区状态播报；文案沿现有 NLS 加载。

从仓库根目录运行：

```sh
pnpm --dir app-ts run typecheck:renderer
pnpm --dir app-ts run build:renderer
pnpm --dir app-ts run test:unit --run src/ash/sessions/test/common/designModel.test.ts --run src/ash/sessions/test/browser/designEditorWidget.test.ts --run test/architecture/layer-boundaries.test.ts --run test/architecture/ui-styling-ownership.test.ts
pnpm --dir app-ts run test:smoke:browser --grep 'Sessions Design'
pnpm --dir app-ts run test:smoke:ui --grep 'Sessions Design'
pnpm --dir app-ts run test:smoke:desktop --grep 'Sessions Design'
```

单元测试覆盖文档校验、历史、分组变换、命中检测、文件冲突、中文标签、多个视图的状态隔离和释放。Playwright 场景覆盖页面切换、主题与配置、键盘和指针操作、文件保存与 SVG 导出；每个运行目标只执行适用的场景。分层检查约束空间数学、模型和页面之间的依赖。
