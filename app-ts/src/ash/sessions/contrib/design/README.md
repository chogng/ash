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
| [browser/designMedia.ts](browser/designMedia.ts) | 媒体备份与导出编码、内容摘要；按设计引用管理每个实例的共享图片资源 |
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
| 素材身份、不可变版本、图片引用和裁切 | `DesignModel` 的文档快照 | 是 |
| 原始图片字节 | `DesignDocumentController` | 素材文件；恢复备份同时保留字节 |
| 图片预览 URL | 每个 Widget 的 `DesignMediaPreview` | 否；不作为永久引用 |
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

普通图片查看的类型识别、显示解码和尺寸读取由 [Platform 图片模块](../../../platform/media/browser/image.ts) 提供；`ImageResource` 创建并释放视图所用的对象 URL。[Workbench 图片预览](../../../workbench/contrib/mediaPreview/browser/imagePreview.ts) 和 Design 共用这套能力。普通文件查看负责适应窗口、原尺寸和缩放。Design 导入通过 [素材服务](../../../platform/assets/common/assetService.ts) 使用 Rust 入库结果，前端不生成正式素材元数据；Design 保留素材版本引用、裁切和文档历史。两种视图分别拥有预览资源，关闭一处不影响另一处；URL 不保存进文件，也不作为素材身份。Library 消费同一模块，预览资源随其页面可见性释放，不需要导入 Design。

Library 面向整个产品收集、查找和整理素材，Design 文档保存采用的确切素材版本及使用方式。设计模型不属于聊天记录，Library 的素材目录也不属于某个 Design Widget。Library 已提供图片目录、导入、搜索、收藏与集合；[Rust 素材领域](../../../../../../ash-rs/assets/src/lib.rs) 已提供原件入库、不可变版本与分块读取，Design 从文件导入时使用该领域，原始字节随设计包保存。Library 的“用于 Design”由窗口装配打开设计页并调用编辑器的素材采用入口；Design 通过共享素材服务读取确切版本，将原件纳入工作副本。同一素材版本可产生多个独立图片对象，文档只保存一份素材版本条目。Design 不持有另一份全局目录，Library 不导入 Design 的编辑模型。规划见 [DESIGN.md](DESIGN.md#library-与编辑器的归属)。

## 编辑与几何约定

文档坐标使用设计像素，100% 缩放时一个设计单位对应一个 CSS 像素。网格间隔为 12 个设计单位，显示设备的像素密度不改变文档几何。对象按数组顺序从后向前绘制，命中检测从前向后查找。旋转使用绕对象中心的顺时针角度。

路径节点及其控制点保存为对象宽高的比例；属性面板显示路径局部像素。这样改变对象尺寸时，曲线随对象一起缩放。分组子对象使用组内坐标；当前文件格式支持组的旋转与等比缩放，解组时将组变换合并进子对象的位置、尺寸和旋转。等比缩放保证解组后的子对象仍能用现有几何字段表达。

画板是固定交付范围，拥有背景和裁切开关；子对象使用画板局部坐标。改变画板宽高不缩放子对象，移动或旋转画板带着其内容一起变化。图层视图可选择画板内的子对象，画布方向键和拖动使用同一世界坐标方向。分组仍作为整体选中，解组后恢复子对象编辑。

导入支持 PNG、JPEG 和 WebP。图片对象引用素材及其版本，保存自己的位置、尺寸、旋转和归一化源图裁切范围。裁切通过属性区的百分比输入修改，保持原图字节完整；复制图片产生新对象身份，共享同一个素材版本，各处可以独立裁切。当前尚未实现 SVG 素材、视频导入、素材版本替换或 Library 选择器。

共享工具栏、属性贡献和键盘修改通过 `DocumentCommands` 到达 `DesignModel.applyEdit`。模型每次提交一个不可变快照，清除 redo 分支并通知 Widget 更新。撤销与重做由同一个模型执行。

拖拽过程中，共享输入层和绘制贡献只更新预览。指针释放时一次提交全部受影响对象；Escape、取消捕获或取消手势丢弃预览。其他视图提交文档或开始文件操作时，会取消当前视图的预览，保持渲染与已提交状态一致。文件替换会清空编辑历史并重置每个视图的选区；普通编辑保留仍存在的对象选择。

## 文件与导出

可编辑文件使用目录形式的 `.ash-design` 包，`manifest.json` 保存严格的 `schemaVersion: 2` 结构，`assets/<sha256>` 保存原始图片字节。当前一个文档包含一个排版成果；清单保存文档与成果身份、根对象顺序、按身份索引的对象表和素材版本。运行时只保留一个不可变对象树，解析和序列化负责对象表与树的转换，不维护两份可变内容。解析拒绝重复归属、包含环、未归属对象、缺失素材版本及包外路径。打开先验证完整结构和媒体摘要，再替换当前模型；失败保留当前内容。

保存固定当前快照，先写不可变媒体，再以读取版本条件写入清单。清单成功写入后才更新保存基准；保存失败保留未保存内容。保存期间后续编辑保持脏状态，撤销到保存基准时恢复为未修改状态。另存为创建新文档身份，保留对象身份和编辑历史；移动整个包保留原文档身份和图片引用。文件变化通知触发外部清单版本检查，保存使用文件服务的冲突检查。

未命名文档的图片字节由工作副本保留，恢复备份包含清单和媒体字节。Widget 只持有可释放的预览 URL，关闭某个编辑器不会删除素材；删除图片也不立即清理素材，因为撤销历史仍可能引用它。当前媒体随窗口文档释放，不提供全局素材清理。

版本 1 的 `.ash-design.json` 仍可导入，保留原对象、分组、文字、路径和动画；首次保存选择版本 2 包，不改写旧文件。配置和 UI 存储各自保存偏好，不承接文档内容。对象可携带 `motion`，包含毫秒时长、循环标记及从 0 到 1 严格递增的关键帧；每帧保存父坐标系中的位置、旋转和透明度。所有关键帧编辑经过同一个撤销历史。格式版本、模型编辑令牌和磁盘读取版本分别表示文件结构、当前编辑状态和文件写入依据。

`DesignDocumentController` 调用已有文件与对话框服务。桌面和连接 App Server 的浏览器沿已有文件服务访问工作区；独立浏览器通过用户选定的文件夹访问文件。打开其他文档和桌面关闭会提供保存、放弃或取消；浏览器关闭使用同步的未保存提示。当前没有自动保存或跨窗口合并。

画布和 SVG 导出都使用 `svgRenderer.ts`。对象从文档读取，用户文字作为文本节点写入；导出仅包含作品，省略网格与选区，并保留可编辑文档的保存状态。图片导出为内嵌数据，离开 Ash 后仍可显示；关闭画板裁切时，导出范围包含伸出画板的内容。

## 模式与 Agent 使用

底部工具栏位于画布中央，选区与移动画布、矩形与椭圆分别通过组合下拉按钮选择，各组保留最近使用的工具。钢笔、文字与四个模式使用图标按钮，模式切换发生在当前设计标签页内。缩放使用 Ctrl 加滚轮或加减号快捷键。绘制模式的钢笔拖动生成自由线条；设计模式的钢笔点击放置锚点，拖动生成对称曲线控制点，Enter 完成，Escape 取消。图形工具拖动绘制，文字工具点击放置。绘制预览不进入模型，完成时只提交一次。

工具栏提供添加画板和导入图片，快捷键分别为 F 和 I；Motion 和 Code 模式禁用这两个操作。选中画板后导入放在其中心，否则放在当前视口中心。对象中心落入画板时，新对象转换为对应画板的局部坐标。

Motion 模式选中对象后可添加起止帧、拖动时间滑块添加中间帧、编辑位置、旋转和透明度，设置时长与循环，并播放文档。帧间采用线性插值，拖动时间不产生文档编辑。移动或组合对象时同步转换其关键帧坐标。组合有自身动画时需先移除该动画才能解组，因为现有格式不能无损合并父级和子级动画。播放状态与时间属于每个贡献实例，切换模式、隐藏页面或释放组件停止播放。

Code 模式从同一已提交快照生成 HTML/CSS/SVG：矩形、椭圆和画板使用 HTML/CSS，曲线、文字和图片复用画布 SVG，容器保留层级和坐标变换，对象动画输出 CSS `@keyframes`。导出的 HTML 可直接打开，不依赖 Ash 运行时。对象具有稳定身份，原始设计 JSON 嵌入 `ash-design-document`，Agent 可读取几何、文本、路径和关键帧，再通过保存的 `.ash-design` 包继续编辑。图片使用内嵌数据，用户文本作为文本节点输出，嵌入 JSON 转义标签字符。

代码导出保留自由布局的实际像素和动画，不推断响应式布局或业务组件。生成代码是单向输出，修改导出的 HTML 不会同步修改设计文档。导出不改变可编辑设计的保存状态；操作系统的减少动态效果设置会停止导出代码中的自动动画。

## 当前能力与验证入口

已具备矩形、椭圆、文字、贝塞尔路径、画板、PNG/JPEG/WebP 图片导入、独立裁切、多选、分组、几何与属性编辑、撤销重做、素材包打开保存、关键帧动画编辑与播放、SVG 和 HTML 代码导出。组尺寸按比例变化，画板尺寸变化保留子对象几何；文字内容目前通过属性面板编辑。品牌样式、Agent 候选采用、视频和媒体工作流尚未实现。

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

单元测试覆盖文档校验、素材引用、历史、分组与画板变换、命中检测、文件冲突、保存期间编辑、另存身份、图片备份、损坏素材拒绝、中文标签、多个视图的状态隔离和释放。Playwright 场景覆盖页面切换、主题与配置、键盘和指针操作、图片导入与独立裁切、素材包重开及 SVG/HTML 导出；桌面场景还验证移动整个包后的媒体读取。每个运行目标只执行适用的场景，分层检查约束空间数学、模型和页面之间的依赖。
