# Creator 工作空间

Creator 是 Sessions 的创作功能聚合入口，首页提供 Design、Whiteboard、Slides、Brand、Sites、Make、Prototype 七个工作空间。各功能在 `contrib/<mode>/browser` 注册自己的 View、操作和工作空间；共享 Creator ViewContainer 聚合这些 Views，由 Workbench 的 ViewPaneContainer 管理排列、折叠、尺寸和焦点。`CreatorPage` 保留工作空间，窗口布局只接收 Creator 提供的容器与中央内容。Library 是独立的分类资源库，不参与这套创作入口注册。配置、主题、快捷键、文件访问、对话框和窗口生命周期复用已有服务。

当前画布工作空间各自拥有文档、保存基准和撤销历史，选区、视口及编辑工具由各自的编辑器实例持有。首页和 Make 使用 Creator 导航侧栏并隐藏画布属性面板；其他画布模式通过现有 Sessions 视图使用当前编辑器的图层和属性。

| 模式 | 当前操作 |
| --- | --- |
| Design | 画板、图片和图形编辑；按需展开共享 Agent 对话，附上文档与选区快照 |
| Whiteboard | 便签、自由绘图和固定连接线 |
| Slides | 16:9 页面、排序和演示 |
| Brand | 常用素材尺寸、整批尺寸变体 |
| Sites | 网页画板、页面预览和包含导航的 HTML 导出 |
| Make | 生成代码与场景 JSON 查看、HTML 运行预览、附带代码的 Agent 对话草稿 |
| Prototype | 手机屏幕、顺序预览和对象动画 |

Sites 尚未提供网站布局重排、路由文档和发布，完整领域约定见 [Creator Sites](../../CREATOR_SITES.md)。Prototype 尚未提供点击热点及分支流程。Make 的 Agent 操作准备未发送的 Code 草稿，由用户在对话里检查并发送。

这份文档说明目录归属、状态与生命周期约定。后续开发先阅读 [七项入口的官方定位](DESIGN.md#七项入口的官方定位)、[Agent 的作用](DESIGN.md#agent-在各项工作中的作用)、[Part 分工](DESIGN.md#七项工作区的-part-分工)和 [工作区与验收要求](DESIGN.md#ash-的工作区与验收要求)，按各项任务设计能力；这些是目标要求，不能将上表的当前操作视为完整产品能力。完整 Agent 对话由 `SessionsPart` 承载，创作内容由 `EditorPart` 承载；Design 已接入两者同时显示的 [Sessions 布局契约](../../LAYOUT.md#creator-conversation-and-editor-composition)，其他工作区的组合仍待实现。Sessions 的窗口装配见 [Sessions README](../../README.md)，窗口分层见 [LAYERS.md](../../LAYERS.md)。

### Design 的 Agent 对话

每次进入 Design 或重开窗口时，默认只显示图层、画布和属性；工具栏的“显示 Agent”展开已有 `SessionsPart`，继续使用当前选中的对话、草稿及附件。Creator 入口、画布及属性仍保留；“隐藏 Agent”将焦点返回画布。画布优先吸收窗口尺寸变化，对话宽度由桌面布局保存，显示状态只在本次进入期间有效。

“添加设计到 Agent”打开对话并添加 `design-context.json`。附件在点击时固定文档内容、模型版本令牌和所选对象身份，后续编辑不会改变已经添加的快照；再次添加同一文档会更新该文档的附件。操作保留用户已有文字，由用户检查并发送。附件包含素材版本元数据，不包含图片字节。当前没有自动采用 Agent 的设计修改，也没有每份文档独立绑定对话；组件和布局系统仍按 [DESIGN](DESIGN.md) 继续实施。

调用链由 Design contribution 的工具栏进入 `ISessionsLayoutService` 或窗口的 `sessions.addContextToAgent` 命令。Creator contribution 提供 `creator.design` 入口与可选对话声明；布局服务只管理入口显示，`DesktopWorkbenchLayout` 管理主区域及尺寸，Sessions 保持唯一对话状态，Design 工作副本保持唯一文档与撤销历史。新增能力沿既有 Ash 文件原位实现，没有新增 Part 或聊天模型。

## 目录与命名

职责划分参考 [Editor browser](../../../editor/browser/README.md)：主 Widget 拥有编辑器实例与组件组合，View 拥有内容显示，Controller 拥有输入。`document.ts` 表达文档，`designModel.ts` 对应文本编辑器的 `textModel.ts`，`documentCommands.ts` 承接编辑操作。Design 的对象几何、选区和历史由本目录实现；视口及空间输入由平级的 [Canvas contrib](../canvas/README.md) 拥有。

`browser/widget` 放主编辑器和共享工具栏，`browser/view.ts` 放对象和路径控制点显示，`browser/controller` 放对象选择与编辑输入。公共画布容器、网格、视口和指针捕获位于平级 `canvas`。绘制、属性、Motion 和 Code 的具体能力及能力专属 widget 位于 `contrib`；这与 Editor 的 Find、Suggest widget 跟随各自贡献的归属相同。归属取决于组件拥有的职责、状态和生命周期。

核心 Widget、View 和输入控制器只消费 [designEditorBrowser.ts](browser/designEditorBrowser.ts) 的公共能力契约。产品入口 [design.main.ts](design.main.ts) 创建各个能力，由设计页面组件传给 Widget；核心组件不导入能力实现或装配入口。贡献更新文档或提供显示数据，画布统一呈现这些数据。文档与历史仍由公共模型统一持有。

| 文件 | 拥有的职责 |
| --- | --- |
| [common/core/geometry.ts](common/core/geometry.ts) | 点、对象框、坐标变换、贝塞尔计算和包围框；仅处理空间数学 |
| [common/model/document.ts](common/model/document.ts) | 设计文档与对象类型、不可变快照、文件解析和序列化 |
| [common/model/designModel.ts](common/model/designModel.ts) | `DesignModel`，已提交文档和撤销重做历史的唯一持有者 |
| [common/model/hitTest.ts](common/model/hitTest.ts) | 根据对象种类、绘制顺序和几何判断命中 |
| [common/commands/documentCommands.ts](common/commands/documentCommands.ts) | `DocumentCommands`，创建、修改、删除、分组和解组操作 |
| [common/config/editorConfiguration.ts](common/config/editorConfiguration.ts) | Design 的配置键、默认值、作用域和校验 |
| [common/selection.ts](common/selection.ts) | 每个编辑器实例的对象选区和路径节点选择 |
| [browser/widget/designEditorWidget.ts](browser/widget/designEditorWidget.ts) | `DesignEditorWidget`，编辑器根 DOM、组件组合、实例状态、公共快捷键和贡献生命周期 |
| [browser/widget/designToolsWidget.ts](browser/widget/designToolsWidget.ts) | 底部单行悬浮工具栏、工具与模式选择、键盘导航 |
| [browser/view.ts](browser/view.ts)、[view.css](browser/view.css) | `DesignView`，挂载公共 Canvas，显示对象、绘制预览和路径控制点；只显示输入数据，不提交文档编辑 |
| [browser/controller/designInputController.ts](browser/controller/designInputController.ts) | 参与公共画布输入，拥有对象选择、移动和路径控制点编辑；通过输入契约调用绘制贡献 |
| [browser/designEditorBrowser.ts](browser/designEditorBrowser.ts)、[design.main.ts](design.main.ts) | 前者定义核心与贡献之间的契约，后者装配产品所需的能力实例 |
| [contrib/drawing/browser/designDrawingController.ts](contrib/drawing/browser/designDrawingController.ts) | 矩形、椭圆、文字放置、钢笔锚点及自由线条的绘制预览和提交 |
| [contrib/properties/browser/designPropertiesWidget.ts](contrib/properties/browser/designPropertiesWidget.ts) | 几何、填色、文字和路径属性控件与节点操作 |
| [contrib/motion/browser/designMotionWidget.ts](contrib/motion/browser/designMotionWidget.ts) | 关键帧编辑、时间线、播放时钟和动画采样数据；插值位于同贡献的 `common/motion.ts`，画布呈现由共享 View 负责 |
| [contrib/code/browser/designCodeWidget.ts](contrib/code/browser/designCodeWidget.ts)、[designCodeGenerator.ts](contrib/code/browser/designCodeGenerator.ts) | 从已提交文档生成、显示和导出可运行代码 |
| [browser/svgRenderer.ts](browser/svgRenderer.ts) | 画布与 SVG 导出共用的对象渲染 |
| [browser/designMedia.ts](browser/designMedia.ts) | 媒体备份与导出编码、内容摘要；按设计引用管理每个实例的共享图片资源 |
| [browser/designDocumentController.ts](browser/designDocumentController.ts) | `DesignDocumentController`，文件身份、读取版本、保存基准、异步文件操作和共享 `IWorkingCopy` 契约 |
| [browser/designEditorPage.ts](browser/designEditorPage.ts) | `DesignEditorPage`，借用窗口文档，拥有编辑器装配、布局、焦点和浏览器关闭检查 |
| [browser/designEditorService.ts](browser/designEditorService.ts)、[designViews.ts](browser/designViews.ts) | 按模式持有的窗口文档、工作副本注册与当前编辑器的可观察引用，以及借用该实例文档、选区和属性组件的 Layers 与 Shape properties 视图 |
| [browser/creatorPage.ts](browser/creatorPage.ts)、[creatorWorkspace.ts](browser/creatorWorkspace.ts) | CreatorEditorPane、模式导航、工作空间保留与模式注册契约 |
| [browser/creator.contribution.ts](browser/creator.contribution.ts)、[creatorEditor.contribution.ts](browser/creatorEditor.contribution.ts) | 前者注册 Creator 导航及帮助，后者注册共享画布面板、快捷键和帮助 |

一个文件可以承接紧密相关的完整职责。几何和文档序列化目前各自保持在小模块中；新增能力时按实际职责拆分。

## 与 Editor 的关系

Design 与 Editor 共用 Base、Platform 提供的生命周期、控件、配置、主题和快捷键设施。文件与窗口关闭通过已有服务接入 Sessions。`DesignModel` 使用对象层级、空间变换和路径节点表达内容；Editor 的 `TextModel` 使用文本位置与文本编辑语义，两者各自拥有模型和历史。

当前文字内容通过属性面板的文本输入编辑，内容、字号和对象几何保存在 Design 文档中。Editor 的文字编辑组件尚未接入 Design。

## 依赖与状态归属

`common/core` 只定义空间值与计算，文档类型和可变模型依赖它。`common/model` 拥有文档及历史，命令依赖模型。`common` 使用基础 JavaScript 与所属公共服务契约；DOM、文件操作和页面装配留在 `browser`。

编辑器组件使用本目录的公共模型、命令和文件控制器，通过公共契约调用贡献。窗口编辑器服务按 Creator 模式创建并注册文档控制器；`CreatorPage` 的每个工作空间通过设计页面组件借用自己的文档，把能力装配函数传给 Widget，并转交编辑器布局与焦点。左右面板读取当前画布的同一份文档和选区；属性 View 只挂载 Widget 拥有的属性组件，视图切换不会创建第二份文档、选区或属性状态。Widget 创建 View、共享工具栏、输入控制器和一组贡献实例；各组件持有自己的 DOM、样式和订阅。宿主只定位直接挂载的组件根节点。

| 状态 | 持有者 | 保存进文件 |
| --- | --- | --- |
| 对象内容、几何、层级和绘制顺序 | `DesignModel` 的文档快照 | 是 |
| 素材身份、不可变版本、图片引用和裁切 | `DesignModel` 的文档快照 | 是 |
| 原始图片字节 | `DesignDocumentController` | 素材文件；恢复备份同时保留字节 |
| 图片预览 URL | 每个 Widget 的 `DesignMediaPreview` | 否；不作为永久引用 |
| 撤销重做历史 | `DesignModel` | 否 |
| 选中对象、当前路径节点 | 每个 Widget 的 `DesignSelection` | 否 |
| 缩放和平移 | 每个 Widget 的 `CanvasViewport` | 否 |
| 指针捕获、视口手势 | `CanvasInputController` | 否 |
| 对象拖拽预览 | `DesignInputController` | 否 |
| 未提交绘制预览 | 绘制 contribution | 否 |
| 动画播放时间 | Motion contribution | 否 |
| 当前工具与模式 | 每个 Widget | 否 |
| 文件 URI、读取版本、已保存内容和操作状态 | `DesignDocumentController` | 否 |

多个 Widget 可以使用同一个文档控制器，共享已提交内容与历史，同时保留各自的选区和视口。Widget 借用控制器的模型；单独释放 Widget 会取消手势，释放 View、输入控制器、共享工具栏及该实例的全部贡献，并清理订阅和命令查找记录。View 释放画布的主题与配置订阅，Motion 释放播放时钟；文档仍由控制器持有。活动页切换隐藏对应编辑组或 EditorPane，`CreatorPage` 保留页面组件与 Widget；隐藏画布会取消手势并停止动画播放，回到设计页时恢复原选区和视口。Creator 页面使用 EditorPart 中保留的产品编辑组，不进入会话 Code 工作集，页面切换不会触发关闭确认。窗口编辑器服务通过关闭生命周期逐一确认保存、放弃或取消，即使当前正在查看其他模式，也会检查全部未保存文档；窗口关闭后释放文档。

文档文件保存所属模式；打开和恢复备份必须匹配当前工作空间。原有未记录模式的 Design 文件保持 Design 语义。每种模式的工作副本资源为 `ash-creator:/<mode>`，窗口导航迁移旧的 Design 命令顺序与页面选择。

Design 通过 `sessions.common.main.ts` 加载，当前使用方是 Sessions。Design 消费 Workbench 的工作副本与窗口生命周期契约；其基础层和共享服务保持既有依赖方向，不能导入本目录。

普通图片查看的类型识别、显示解码和尺寸读取由 [Platform 图片模块](../../../platform/media/browser/image.ts) 提供；`ImageResource` 创建并释放视图所用的对象 URL。[Workbench 图片预览](../../../workbench/contrib/mediaPreview/browser/imagePreview.ts) 和 Design 共用这套能力。普通文件查看负责适应窗口、原尺寸和缩放。Design 导入通过 [素材服务](../../../platform/assets/common/assetService.ts) 使用 Rust 入库结果，前端不生成正式素材元数据；Design 保留素材版本引用、裁切和文档历史。两种视图分别拥有预览资源，关闭一处不影响另一处；URL 不保存进文件，也不作为素材身份。Library 消费同一模块，预览资源随其页面可见性释放，不需要导入 Design。

Library 面向整个产品收集、查找和整理素材，Design 文档保存采用的确切素材版本及使用方式。设计模型不属于聊天记录，Library 的素材目录也不属于某个 Design Widget。Library 已提供图片目录、导入、搜索、收藏与集合；[Rust 素材领域](../../../../../crates/assets/src/lib.rs) 已提供原件入库、不可变版本与分块读取，Design 从文件导入时使用该领域，原始字节随设计包保存。Library 的“用于 Design”由窗口装配打开设计页并调用编辑器的素材采用入口；Design 通过共享素材服务读取确切版本，将原件纳入工作副本。同一素材版本可产生多个独立图片对象，文档只保存一份素材版本条目。Design 不持有另一份全局目录，Library 不导入 Design 的编辑模型。规划见 [DESIGN.md](DESIGN.md#library-与编辑器的归属)。

## 编辑与几何约定

文档坐标使用设计像素，100% 缩放时一个设计单位对应一个 CSS 像素。网格间隔为 12 个设计单位，显示设备的像素密度不改变文档几何。对象按数组顺序从后向前绘制，命中检测从前向后查找。旋转使用绕对象中心的顺时针角度。

路径节点及其控制点保存为对象宽高的比例；属性面板显示路径局部像素。这样改变对象尺寸时，曲线随对象一起缩放。分组子对象使用组内坐标；当前文件格式支持组的旋转与等比缩放，解组时将组变换合并进子对象的位置、尺寸和旋转。等比缩放保证解组后的子对象仍能用现有几何字段表达。

画板是固定交付范围，拥有背景和裁切开关；子对象使用画板局部坐标。改变画板宽高不缩放子对象，移动或旋转画板带着其内容一起变化。图层视图可选择画板内的子对象，画布方向键和拖动使用同一世界坐标方向。分组仍作为整体选中，解组后恢复子对象编辑。

导入支持 PNG、JPEG 和 WebP。图片对象引用素材及其版本，保存自己的位置、尺寸、旋转和归一化源图裁切范围。裁切通过属性区的百分比输入修改，保持原图字节完整；复制图片产生新对象身份，共享同一个素材版本，各处可以独立裁切。当前尚未实现 SVG 素材、视频导入、素材版本替换或 Library 选择器。

共享工具栏、属性贡献和键盘修改通过 `DocumentCommands` 到达 `DesignModel.applyEdit`。模型每次提交一个不可变快照，清除 redo 分支并通知 Widget 更新。撤销与重做由同一个模型执行。

填充色块打开共享 `base/browser/ui/colorPicker` 组件。颜色组件拥有二维选色、色相、不透明度和 Hex、RGB、CSS、HSL、HSB 输入；Design 属性贡献提供文档色板和当前编辑器最近使用的颜色，并拥有填色预览。切换格式不提交文档编辑。拖动只更新当前画布预览，松手时通过公共命令一次提交；取消或隐藏编辑器丢弃尚未提交的预览，其他文档编辑会关闭面板。浮层由窗口 ContextView 托管，键盘帮助和颜色文本视图沿用 Design 的无障碍详细程度设置。

拖拽过程中，共享输入层和绘制贡献只更新预览。指针释放时一次提交全部受影响对象；Escape、取消捕获或取消手势丢弃预览。其他视图提交文档或开始文件操作时，会取消当前视图的预览，保持渲染与已提交状态一致。文件替换会清空编辑历史并重置每个视图的选区；普通编辑保留仍存在的对象选择。

## 文件与导出

可编辑文件使用目录形式的 `.ash-design` 包，`manifest.json` 保存严格的 `schemaVersion: 2` 结构，`assets/<sha256>` 保存原始图片字节。当前一个文档包含一个排版成果；清单保存文档与成果身份、根对象顺序、按身份索引的对象表和素材版本。运行时只保留一个不可变对象树，解析和序列化负责对象表与树的转换，不维护两份可变内容。解析拒绝重复归属、包含环、未归属对象、缺失素材版本及包外路径。打开先验证完整结构和媒体摘要，再替换当前模型；失败保留当前内容。

`fill` 使用 sRGB 六位 `#RRGGBB` 或带不透明度的八位 `#RRGGBBAA`。纯色仍保存六位值，透明色保存八位值，画布、SVG 和 HTML 导出读取同一填色值。颜色输入格式是编辑器显示方式，不改变保存格式。

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
pnpm run typecheck:renderer
pnpm run build:renderer
pnpm run test:unit --run src/ash/sessions/test/common/designModel.test.ts --run src/ash/sessions/test/browser/designEditorWidget.test.ts --run test/architecture/layer-boundaries.test.ts --run test/architecture/ui-styling-ownership.test.ts
pnpm run test:smoke:browser --grep 'Sessions Design'
pnpm run test:smoke:ui --grep 'Sessions Design'
pnpm run test:smoke:desktop --grep 'Sessions Design'
```

单元测试覆盖文档校验、素材引用、历史、分组与画板变换、命中检测、文件冲突、保存期间编辑、另存身份、图片备份、损坏素材拒绝、中文标签、多个视图的状态隔离和释放。Playwright 场景覆盖页面切换、主题与配置、键盘和指针操作、图片导入与独立裁切、素材包重开及 SVG/HTML 导出；桌面场景还验证移动整个包后的媒体读取。每个运行目标只执行适用的场景，分层检查约束空间数学、模型和页面之间的依赖。
