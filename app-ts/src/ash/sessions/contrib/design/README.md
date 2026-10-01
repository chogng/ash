# Design 编辑器

Design 是 Sessions 专属的二维设计编辑器。本目录拥有设计文档、编辑操作、画布和文件生命周期，画布通过共享编辑器注册进入 `EditorPart`，图层和属性通过 Sessions 视图注册分别进入 `SidebarPart` 和 `AuxiliaryBarPart`。配置、主题、快捷键、文件访问、对话框和窗口生命周期复用已有服务。

这份文档说明目录归属、状态与生命周期约定。Sessions 的页面装配见 [Sessions README](../../README.md)，窗口分层见 [LAYERS.md](../../LAYERS.md)。

## 目录与命名

职责划分参考 [Editor browser](../../../editor/browser/README.md)：主 Widget 拥有编辑器实例与组件组合，View 拥有内容显示，Controller 拥有输入。`document.ts` 表达文档，`designModel.ts` 对应文本编辑器的 `textModel.ts`，`documentCommands.ts` 承接编辑操作。Design 的空间坐标、选区和历史由本目录实现。

`browser/widget` 放主编辑器和共享工具栏，`browser/view.ts` 放画布，`browser/controller` 放共享输入。绘制、属性、Motion 和 Code 的具体能力及能力专属 widget 位于 `contrib`；这与 Editor 的 Find、Suggest widget 跟随各自贡献的归属相同。归属取决于组件拥有的职责、状态和生命周期。

核心 Widget、View 和输入控制器只消费 [designEditorBrowser.ts](browser/designEditorBrowser.ts) 的公共能力契约。产品入口 [design.main.ts](design.main.ts) 创建各个能力，由编辑器 Pane 传给 Widget；核心组件不导入能力实现或装配入口。贡献更新文档或提供显示数据，画布统一呈现这些数据。文档与历史仍由公共模型统一持有。

| 文件 | 拥有的职责 |
| --- | --- |
| [common/core/geometry.ts](common/core/geometry.ts) | 点、对象框、坐标变换、贝塞尔计算和包围框；仅处理空间数学 |
| [common/model/document.ts](common/model/document.ts) | 设计文档与对象类型、不可变快照、文件解析和序列化 |
| [common/model/designModel.ts](common/model/designModel.ts) | `DesignModel`，已提交文档和撤销重做历史的唯一持有者 |
| [common/model/hitTest.ts](common/model/hitTest.ts) | 根据对象种类、绘制顺序和几何判断命中 |
| [common/commands/documentCommands.ts](common/commands/documentCommands.ts) | `DocumentCommands`，创建、修改、删除、分组和解组操作 |
| [common/config/editorConfiguration.ts](common/config/editorConfiguration.ts) | Design 的配置键、默认值、作用域和校验 |
| [common/selection.ts](common/selection.ts)、[common/viewport.ts](common/viewport.ts) | 每个编辑器实例的对象选区、路径节点选择和视口状态 |
| [browser/widget/designEditorWidget.ts](browser/widget/designEditorWidget.ts) | `DesignEditorWidget`，编辑器根 DOM、组件组合、实例状态、公共快捷键和贡献生命周期 |
| [browser/widget/designToolsWidget.ts](browser/widget/designToolsWidget.ts) | 底部单行悬浮工具栏、工具与模式选择、键盘导航 |
| [browser/view.ts](browser/view.ts)、[view.css](browser/view.css) | `DesignView`，画布 DOM、网格、对象、绘制预览、选框、路径控制点、视口变换和光标呈现；只显示输入数据，不提交文档编辑 |
| [browser/controller/designInputController.ts](browser/controller/designInputController.ts) | 共享输入、指针捕获、坐标换算、对象选择、移动、路径控制点及画布平移与缩放手势；通过输入契约调用绘制贡献 |
| [browser/designEditorBrowser.ts](browser/designEditorBrowser.ts)、[design.main.ts](design.main.ts) | 前者定义核心与贡献之间的契约，后者装配产品所需的能力实例 |
| [contrib/drawing/browser/designDrawingController.ts](contrib/drawing/browser/designDrawingController.ts) | 矩形、椭圆、文字放置、钢笔锚点及自由线条的绘制预览和提交 |
| [contrib/properties/browser/designPropertiesWidget.ts](contrib/properties/browser/designPropertiesWidget.ts) | 几何、填色、文字和路径属性控件与节点操作 |
| [contrib/motion/browser/designMotionWidget.ts](contrib/motion/browser/designMotionWidget.ts) | 关键帧编辑、时间线、播放时钟和动画采样数据；插值位于同贡献的 `common/motion.ts`，画布呈现由共享 View 负责 |
| [contrib/code/browser/designCodeWidget.ts](contrib/code/browser/designCodeWidget.ts)、[designCodeGenerator.ts](contrib/code/browser/designCodeGenerator.ts) | 从已提交文档生成、显示和导出可运行代码 |
| [browser/svgRenderer.ts](browser/svgRenderer.ts) | 画布与 SVG 导出共用的对象渲染 |
| [browser/designDocumentController.ts](browser/designDocumentController.ts) | `DesignDocumentController`，文件身份、读取版本、保存基准、异步文件操作和共享 `IWorkingCopy` 契约 |
| [browser/designEditorPage.ts](browser/designEditorPage.ts) | `DesignEditorPage`，实现 `IEditorPane`，借用窗口文档，拥有编辑器装配、布局、焦点和浏览器关闭检查 |
| [browser/designEditorService.ts](browser/designEditorService.ts)、[designViews.ts](browser/designViews.ts) | 窗口 Design 文档、工作副本注册与当前编辑器的可观察引用，以及借用该实例文档、选区和属性组件的 Layers 与 Shape properties 视图 |
| [browser/design.contribution.ts](browser/design.contribution.ts) | 编辑器 Pane、左右面板视图、快捷键、无障碍帮助与内容视图的注册 |

一个文件可以承接紧密相关的完整职责。几何和文档序列化目前各自保持在小模块中；新增能力时按实际职责拆分。

## 与 Editor 的关系

Design 与 Editor 共用 Base、Platform 提供的生命周期、控件、配置、主题和快捷键设施。文件与窗口关闭通过已有服务接入 Sessions。`DesignModel` 使用对象层级、空间变换和路径节点表达内容；Editor 的 `TextModel` 使用文本位置与文本编辑语义，两者各自拥有模型和历史。

当前文字内容通过属性面板的文本输入编辑，内容、字号和对象几何保存在 Design 文档中。Editor 的文字编辑组件尚未接入 Design。

## 依赖与状态归属

`common/core` 只定义空间值与计算，文档类型和可变模型依赖它。`common/model` 拥有文档及历史，命令依赖模型。`common` 使用基础 JavaScript 与所属公共服务契约；DOM、文件操作和页面装配留在 `browser`。

编辑器组件使用本目录的公共模型、命令和文件控制器，通过公共契约调用贡献。窗口 Design 服务创建并注册唯一文档控制器；`EditorPart` 通过注册的 Pane 借用该文档，把能力装配函数传给 Widget，并转交编辑器布局与焦点。左右面板读取当前 Pane 的同一份文档和选区；属性 View 只挂载 Widget 拥有的属性组件，视图切换不会创建第二份文档、选区或属性状态。Widget 创建 View、共享工具栏、输入控制器和一组贡献实例；各组件持有自己的 DOM、样式和订阅。宿主只定位直接挂载的组件根节点。

| 状态 | 持有者 | 保存进文件 |
| --- | --- | --- |
| 对象内容、几何、层级和绘制顺序 | `DesignModel` 的文档快照 | 是 |
| 撤销重做历史 | `DesignModel` | 否 |
| 选中对象、当前路径节点 | 每个 Widget 的 `DesignSelection` | 否 |
| 缩放和平移 | 每个 Widget 的 `DesignViewport` | 否 |
| 拖拽起点与指针捕获 | `DesignInputController` | 否 |
| 未提交绘制预览 | 绘制 contribution | 否 |
| 动画播放时间 | Motion contribution | 否 |
| 当前工具与模式 | 每个 Widget | 否 |
| 文件 URI、读取版本、已保存内容和操作状态 | `DesignDocumentController` | 否 |

多个 Widget 可以使用同一个文档控制器，共享已提交内容与历史，同时保留各自的选区和视口。Widget 借用控制器的模型；单独释放 Widget 会取消手势，释放 View、输入控制器、共享工具栏及该实例的全部贡献，并清理订阅和命令查找记录。View 释放画布的主题与配置订阅，Motion 释放播放时钟；文档仍由控制器持有。活动页切换只隐藏对应 Part，`EditorPart` 保留 Pane 实例；隐藏画布会取消手势并停止动画播放。关闭编辑器 Tab 时，`EditorPart` 通过工作副本确认保存、放弃或取消；确认后释放 Pane 和 Widget，并清除面板的当前编辑器引用。文档由窗口服务保留，重新打开 Design Tab 会继续使用它；窗口关闭时释放文档。多个编辑器分组打开同一画布时共享文档及历史，每个 Pane 保留自己的选区和视口。

Design 通过 `sessions.common.main.ts` 加载，当前使用方是 Sessions。Design 消费 Workbench 的编辑器注册和工作副本契约；其基础层和共享服务保持既有依赖方向，不能导入本目录。

## 编辑与几何约定

文档坐标使用设计像素，100% 缩放时一个设计单位对应一个 CSS 像素。网格间隔为 12 个设计单位，显示设备的像素密度不改变文档几何。对象按数组顺序从后向前绘制，命中检测从前向后查找。旋转使用绕对象中心的顺时针角度。

路径节点及其控制点保存为对象宽高的比例；属性面板显示路径局部像素。这样改变对象尺寸时，曲线随对象一起缩放。分组子对象使用组内坐标；当前文件格式支持组的旋转与等比缩放，解组时将组变换合并进子对象的位置、尺寸和旋转。等比缩放保证解组后的子对象仍能用现有几何字段表达。

共享工具栏、属性贡献和键盘修改通过 `DocumentCommands` 到达 `DesignModel.applyEdit`。模型每次提交一个不可变快照，清除 redo 分支并通知 Widget 更新。撤销与重做由同一个模型执行。

拖拽过程中，共享输入层和绘制贡献只更新预览。指针释放时一次提交全部受影响对象；Escape、取消捕获或取消手势丢弃预览。其他视图提交文档或开始文件操作时，会取消当前视图的预览，保持渲染与已提交状态一致。文件替换会清空编辑历史并重置每个视图的选区；普通编辑保留仍存在的对象选择。

## 文件与导出

可编辑文件使用严格的版本 1 JSON，建议扩展名为 `.ash-design.json`。文件读取先验证完整文档，再替换当前模型；失败保留当前内容。保存比较当前文档序列化结果与已保存内容来判断脏状态，并使用读取版本检查写入冲突。配置和 UI 存储各自保存偏好，不承接文档内容。对象可携带 `motion`，包含毫秒时长、循环标记及从 0 到 1 严格递增的关键帧；每帧保存父坐标系中的位置、旋转和透明度。旧的版本 1 文档可以省略动画。所有关键帧编辑经过同一个撤销历史。

`DesignDocumentController` 调用已有文件与对话框服务。桌面和连接 App Server 的浏览器沿已有文件服务访问工作区；独立浏览器通过用户选定的文件夹访问文件。打开其他文档和桌面关闭会提供保存、放弃或取消；浏览器关闭使用同步的未保存提示。当前没有自动保存或跨窗口合并。

画布和 SVG 导出都使用 `svgRenderer.ts`。对象从文档读取，用户文字作为文本节点写入；导出仅包含作品，省略网格与选区，并保留可编辑文档的保存状态。

## 模式与 Agent 使用

底部工具栏位于画布中央，依次提供选区、移动画布、缩放、矩形和椭圆、钢笔、文字与模式切换。绘制模式的钢笔拖动生成自由线条；设计模式的钢笔点击放置锚点，拖动生成对称曲线控制点，Enter 完成，Escape 取消。图形工具拖动绘制，文字工具点击放置。绘制预览不进入模型，完成时只提交一次。

Motion 模式选中对象后可添加起止帧、拖动时间滑块添加中间帧、编辑位置、旋转和透明度，设置时长与循环，并播放文档。帧间采用线性插值，拖动时间不产生文档编辑。移动或组合对象时同步转换其关键帧坐标。组合有自身动画时需先移除该动画才能解组，因为现有格式不能无损合并父级和子级动画。播放状态与时间属于每个贡献实例，切换模式、隐藏页面或释放组件停止播放。

Code 模式从同一已提交快照生成 HTML/CSS/SVG：矩形和椭圆使用 HTML/CSS，曲线和文字复用画布 SVG，组合保留层级和坐标变换，动画输出 CSS `@keyframes`。导出的 HTML 可直接打开，不依赖 Ash 运行时。对象具有稳定的 `data-design-id`，原始设计 JSON 嵌入 `ash-design-document`，Agent 可读取几何、文本、路径和关键帧，再通过保存的 `.ash-design.json` 继续编辑。用户文本作为文本节点输出，嵌入 JSON 转义标签字符。

代码导出保留自由布局的实际像素和动画，不推断响应式布局或业务组件。生成代码是单向输出，修改导出的 HTML 不会同步修改设计文档。导出不改变可编辑设计的保存状态；操作系统的减少动态效果设置会停止导出代码中的自动动画。

## 当前能力与验证入口

已具备矩形、椭圆、文字、贝塞尔路径、多选、分组、几何与属性编辑、撤销重做、文件打开保存、关键帧动画编辑与播放、SVG 和 HTML 代码导出。组尺寸按比例变化。Frames 和嵌入资源尚未实现，文字内容目前通过属性面板编辑。

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
