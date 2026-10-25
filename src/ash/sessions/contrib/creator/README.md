# Artifacts 工作空间

Artifacts 是 Sessions 的创作主页，提供 Docs、Slides、Design 三个创建入口和已有作品卡片。主页保留窗口原有的对话侧栏，不注册单独的分类导航，也不显示编辑器标签栏。`CreatorPage` 保留画布工作空间；Docs 优先使用已安装的富文档扩展，未安装时创建 Markdown 文档；两者复用 Workbench 编辑器的保存、备份和关闭生命周期。主页从已有文档编辑器和画布文档派生作品列表，不持久化第二份作品目录。

Docs 旁的下拉按钮选择自动、富文档或 Markdown；偏好由 UI profile 的 `sessions.docs.editor` 设置持有。缺少可用富文档 Provider 时仍创建 Markdown，并通过共享扩展推荐通知发现可安装的编辑器。当前文档的“切换 Docs 编辑器”复用 Workbench 的 Markdown 导入／导出，创建未保存副本并保留原稿；转换失败由原编辑器报告，不覆盖源文档。

各画布功能在 `contrib/<mode>/browser` 注册工作空间和命令面板操作。Whiteboard、Brand、Sites、Make、Prototype 通过命令面板打开。画布工作空间各自拥有文档、保存基准和撤销历史，选区、视口及编辑工具由各自的编辑器实例持有。画布模式仍借用现有的图层和属性面板；主页及 Make 保留对话侧栏。配置、主题、快捷键、文件访问、对话框和窗口生命周期复用已有服务。

| 模式       | 当前操作                                                           |
| ---------- | ------------------------------------------------------------------ |
| Design     | 画板、图片和图形编辑；自动保存与恢复未命名草稿                     |
| Whiteboard | 便签、自由绘图和固定连接线                                         |
| Slides     | 16:9 页面、排序和演示                                              |
| Brand      | 常用素材尺寸、整批尺寸变体                                         |
| Sites      | 网页画板、页面预览和包含导航的 HTML 导出                           |
| Make       | 生成代码与场景 JSON 查看、HTML 运行预览、附带代码的 Agent 对话草稿 |
| Prototype  | 手机屏幕、热点连线、分支流程、浮层和过渡动画                       |

Sites 尚未提供网站布局重排、路由文档和发布，完整领域约定见 [Creator Sites](../../CREATOR_SITES.md)。Make 的 Agent 操作准备未发送的 Code 草稿，由用户在对话里检查并发送。

这份文档说明目录归属、状态与生命周期约定。后续开发先阅读 [七项入口的官方定位](DESIGN.md#七项入口的官方定位)、[Agent 的作用](DESIGN.md#agent-在各项工作中的作用)、[Part 分工](DESIGN.md#七项工作区的-part-分工)和 [工作区与验收要求](DESIGN.md#ash-的工作区与验收要求)，按各项任务设计能力；这些是目标要求，不能将上表的当前操作视为完整产品能力。完整 Agent 对话由 `SessionsPart` 承载，创作内容由 `EditorPart` 承载；布局组合遵循 [Sessions 布局契约](../../LAYOUT.md#creator-conversation-and-editor-composition)。Sessions 的窗口装配见 [Sessions README](../../README.md)，窗口分层见 [LAYERS.md](../../LAYERS.md)。

### Design 画布布局

Design 隐藏编辑器标签栏和 Creator 标题行，不创建工作空间顶部操作栏，画布直接占用中央内容区。底部绘图工具、图层和属性面板保留。添加画板、导入图片、打开设计、保存副本与导出 SVG 使用画布快捷键或右键菜单；自动保存失败时，右键菜单提供重试保存。点击左侧 Artifacts 导航返回创作主页。其他工作空间保留各自的标题和操作栏。

## 目录与命名

职责划分参考 [Editor browser](../../../editor/browser/README.md)：主 Widget 拥有编辑器实例与组件组合，View 拥有内容显示，Controller 拥有输入。`document.ts` 表达文档，`designModel.ts` 对应文本编辑器的 `textModel.ts`，`documentCommands.ts` 承接编辑操作。Design 的对象几何、选区和历史由本目录实现；视口及空间输入由平级的 [Canvas contrib](../canvas/README.md) 拥有。

`browser/widget` 放主编辑器和共享工具栏，`browser/view.ts` 放对象和路径控制点显示，`browser/controller` 放对象选择与编辑输入。公共画布容器、网格、视口和指针捕获位于平级 `canvas`。绘制、属性、Motion 和 Code 的具体能力及能力专属 widget 位于 `contrib`；这与 Editor 的 Find、Suggest widget 跟随各自贡献的归属相同。归属取决于组件拥有的职责、状态和生命周期。

核心 Widget、View 和输入控制器只消费 [designEditorBrowser.ts](browser/designEditorBrowser.ts) 的公共能力契约。产品入口 [design.main.ts](design.main.ts) 创建各个能力，由设计页面组件传给 Widget；核心组件不导入能力实现或装配入口。贡献更新文档或提供显示数据，画布统一呈现这些数据。文档与历史仍由公共模型统一持有。

| 文件                                                                                                                                                        | 拥有的职责                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| [common/core/geometry.ts](common/core/geometry.ts)                                                                                                          | 点、对象框、坐标变换、贝塞尔计算和包围框；仅处理空间数学                                                                         |
| [common/model/document.ts](common/model/document.ts)                                                                                                        | 设计文档与对象类型、不可变快照、文件解析和序列化                                                                                 |
| [common/model/designModel.ts](common/model/designModel.ts)                                                                                                  | `DesignModel`，已提交文档和撤销重做历史的唯一持有者                                                                              |
| [common/model/hitTest.ts](common/model/hitTest.ts)                                                                                                          | 根据对象种类、绘制顺序和几何判断命中                                                                                             |
| [common/commands/documentCommands.ts](common/commands/documentCommands.ts)                                                                                  | `DocumentCommands`，创建、修改、删除、分组和解组操作                                                                             |
| [common/config/editorConfiguration.ts](common/config/editorConfiguration.ts)                                                                                | Design 的配置键、默认值、作用域和校验                                                                                            |
| [common/selection.ts](common/selection.ts)                                                                                                                  | 每个编辑器实例的对象选区和路径节点选择                                                                                           |
| [browser/widget/designEditorWidget.ts](browser/widget/designEditorWidget.ts)                                                                                | `DesignEditorWidget`，编辑器根 DOM、组件组合、实例状态、公共快捷键和贡献生命周期                                                 |
| [browser/widget/designToolsWidget.ts](browser/widget/designToolsWidget.ts)                                                                                  | 底部单行悬浮工具栏、工具与模式选择、键盘导航                                                                                     |
| [browser/view.ts](browser/view.ts)、[view.css](browser/view.css)                                                                                            | `DesignView`，挂载公共 Canvas，显示对象、绘制预览和路径控制点；只显示输入数据，不提交文档编辑                                    |
| [browser/controller/designInputController.ts](browser/controller/designInputController.ts)                                                                  | 参与公共画布输入，拥有对象选择、移动和路径控制点编辑；通过输入契约调用绘制贡献                                                   |
| [browser/designEditorBrowser.ts](browser/designEditorBrowser.ts)、[design.main.ts](design.main.ts)                                                          | 前者定义核心与贡献之间的契约，后者装配产品所需的能力实例                                                                         |
| [contrib/drawing/browser/designDrawingController.ts](contrib/drawing/browser/designDrawingController.ts)                                                    | 矩形、椭圆、文字放置、钢笔锚点及自由线条的绘制预览和提交                                                                         |
| [contrib/properties/browser/designPropertiesWidget.ts](contrib/properties/browser/designPropertiesWidget.ts)                                                | 几何、填色、文字和路径属性控件与节点操作                                                                                         |
| [contrib/motion/browser/designMotionWidget.ts](contrib/motion/browser/designMotionWidget.ts)                                                                | 关键帧编辑、时间线、播放时钟和动画采样数据；插值位于同贡献的 `common/motion.ts`，画布呈现由共享 View 负责                        |
| [contrib/code/browser/designCodeWidget.ts](contrib/code/browser/designCodeWidget.ts)、[designCodeGenerator.ts](contrib/code/browser/designCodeGenerator.ts) | 从已提交文档生成、显示和导出可运行代码                                                                                           |
| [browser/svgRenderer.ts](browser/svgRenderer.ts)                                                                                                            | 画布与 SVG 导出共用的对象渲染                                                                                                    |
| [browser/designMedia.ts](browser/designMedia.ts)                                                                                                            | 媒体备份与导出编码、内容摘要；按设计引用管理每个实例的共享图片资源                                                               |
| [browser/designDocumentController.ts](browser/designDocumentController.ts)                                                                                  | `DesignDocumentController`，文件身份、读取版本、保存基准、异步文件操作和共享 `IWorkingCopy` 契约                                 |
| [browser/designEditorPage.ts](browser/designEditorPage.ts)                                                                                                  | `DesignEditorPage`，借用窗口文档，拥有编辑器装配、布局、焦点和浏览器关闭检查                                                     |
| [browser/designEditorService.ts](browser/designEditorService.ts)、[designViews.ts](browser/designViews.ts)                                                  | 按模式持有的窗口文档、工作副本注册与当前编辑器的可观察引用，以及借用该实例文档、选区和属性组件的 Layers 与 Shape properties 视图 |
| [browser/creatorPage.ts](browser/creatorPage.ts)、[creatorWorkspace.ts](browser/creatorWorkspace.ts)                                                        | CreatorEditorPane、模式导航、工作空间保留与模式注册契约                                                                          |
| [browser/creator.contribution.ts](browser/creator.contribution.ts)、[creatorEditor.contribution.ts](browser/creatorEditor.contribution.ts)                  | 前者注册 Artifacts 导航及帮助，后者注册共享画布面板、快捷键和帮助                                                                |

一个文件可以承接紧密相关的完整职责。几何和文档序列化目前各自保持在小模块中；新增能力时按实际职责拆分。

## 与 Editor 的关系

Design 与 Editor 共用 Base、Platform 提供的生命周期、控件、配置、主题和快捷键设施。文件与窗口关闭通过已有服务接入 Sessions。`DesignModel` 使用对象层级、空间变换和路径节点表达内容；Editor 的 `TextModel` 使用文本位置与文本编辑语义，两者各自拥有模型和历史。

文本的内容、字符范围样式和排版属性由 Design 文档持有。`TextCommands` 与 `DesignModel` 提交原子编辑及连续输入的撤销分组；`contrib/text` 只持有当前光标、选区、输入样式和尚未提交的 IME 组合输入。画布文字编辑复用浏览器的选区和输入法，独立于代码编辑器的 `TextModel`。双击或 Enter／F2 可编辑文本，包括缩放与旋转分组、组件实例中的文本；T 工具点击创建自动宽度文本，拖拽创建固定框。

Typography 面板面向整层或当前字符选区，显示混合值，支持字体、粗细、斜体、颜色、装饰、大小写、行高／字距及 px／% 换算、段落、列表、方向、换行策略和垂直裁剪。字体列表按用户点击通过 Base 的 `getFonts` 查询；字体、OpenType 特性和可变字体轴使用运行环境实际可用的字体。选区可引用本地或已接受的库样式，局部强调保留引用；复制使用文本和受限富文本，外部 HTML 只读取文本与允许的排版属性。

`designTextRendering.ts` 统一画布、编辑覆盖层和 HTML 导出的字体排版。浏览器测量通过模型端口进入 Auto Layout、尺寸限制与原型场景；字体载入后重算当前文档和历史的派生几何，不添加撤销步骤。自动宽度保留显式段落，自动高度随固定宽度换行，固定尺寸允许溢出；截断与最大行数只影响显示。SVG 的文字使用 XHTML `foreignObject` 保留浏览器排版，依赖支持该 SVG 特性及相同字体的查看器；HTML 使用可重排的文本 DOM。

## 依赖与状态归属

`common/core` 只定义空间值与计算，文档类型和可变模型依赖它。`common/model` 拥有文档及历史，命令依赖模型。`common` 使用基础 JavaScript 与所属公共服务契约；DOM、文件操作和页面装配留在 `browser`。

编辑器组件使用本目录的公共模型、命令和文件控制器，通过公共契约调用贡献。窗口编辑器服务按 Creator 模式创建并注册文档控制器；`CreatorPage` 的每个工作空间通过设计页面组件借用自己的文档，把能力装配函数传给 Widget，并转交编辑器布局与焦点。左右面板读取当前画布的同一份文档和选区；属性 View 只挂载 Widget 拥有的属性组件，视图切换不会创建第二份文档、选区或属性状态。Widget 创建 View、共享工具栏、输入控制器和一组贡献实例；各组件持有自己的 DOM、样式和订阅。宿主只定位直接挂载的组件根节点。

| 状态                                     | 持有者                              | 保存进文件                     |
| ---------------------------------------- | ----------------------------------- | ------------------------------ |
| 对象内容、几何、层级和绘制顺序           | `DesignModel` 的文档快照            | 是                             |
| 素材身份、不可变版本、图片引用和裁切     | `DesignModel` 的文档快照            | 是                             |
| 原始图片字节                             | `DesignDocumentController`          | 素材文件；恢复备份同时保留字节 |
| 图片预览 URL                             | 每个 Widget 的 `DesignMediaPreview` | 否；不作为永久引用             |
| 撤销重做历史                             | `DesignModel`                       | 否                             |
| 选中对象、当前路径节点                   | 每个 Widget 的 `DesignSelection`    | 否                             |
| 缩放和平移                               | 每个 Widget 的 `CanvasViewport`     | 否                             |
| 指针捕获、视口手势                       | `CanvasInputController`             | 否                             |
| 对象拖拽预览                             | `DesignInputController`             | 否                             |
| 未提交绘制预览                           | 绘制 contribution                   | 否                             |
| 动画播放时间                             | Motion contribution                 | 否                             |
| 当前工具与模式                           | 每个 Widget                         | 否                             |
| 文件 URI、读取版本、已保存内容和操作状态 | `DesignDocumentController`          | 否                             |

多个 Widget 可以使用同一个文档控制器，共享已提交内容与历史，同时保留各自的选区和视口。Widget 借用控制器的模型；单独释放 Widget 会取消手势，释放 View、输入控制器、共享工具栏及该实例的全部贡献，并清理订阅和命令查找记录。View 释放画布的主题与配置订阅，Motion 释放播放时钟；文档仍由控制器持有。活动页切换隐藏对应编辑组或 EditorPane，`CreatorPage` 保留页面组件与 Widget；隐藏画布会取消手势并停止动画播放，回到设计页时恢复原选区和视口。Creator 页面使用 EditorPart 中保留的产品编辑组，不进入会话 Code 工作集，页面切换不会触发关闭确认。Design 文档由控制器自动保存：未命名草稿以现有设计文件包格式保存在当前 UI profile 的 `creator/<workspace-id>/<document-id>.ash-design`；工作空间机器状态只记录上次文档 URI，重新进入 Design 时加载该文件包。已打开的文件保留版本检查并自动写回。正常关闭等待全部修改保存，不询问保存；失败时保留画布内容并阻止关闭，可重试。保存副本、导出与发布仍需显式操作。其他 Creator 模式继续通过关闭生命周期确认保存、放弃或取消；窗口关闭后释放文档。

文档文件保存所属模式；打开和恢复备份必须匹配当前工作空间。原有未记录模式的 Design 文件保持 Design 语义。每种模式的工作副本资源为 `ash-creator:/<mode>`，窗口导航迁移旧的 Design 命令顺序与页面选择。

Design 通过 `sessions.common.main.ts` 加载，当前使用方是 Sessions。Design 消费 Workbench 的工作副本与窗口生命周期契约；其基础层和共享服务保持既有依赖方向，不能导入本目录。

普通图片查看的类型识别、显示解码和尺寸读取由 [Base 浏览器图片工具](../../../base/browser/image.ts) 提供；`ImageResource` 创建并释放视图所用的对象 URL。[Workbench 图片预览](../../../workbench/contrib/mediaPreview/browser/imagePreview.ts) 和 Design 共用这套能力。普通文件查看负责适应窗口、原尺寸和缩放。Design 导入通过 [素材服务](../../../platform/assets/common/assetService.ts) 使用 Rust 入库结果，前端不生成正式素材元数据；Design 保留素材版本引用、裁切和文档历史。两种视图分别拥有预览资源，关闭一处不影响另一处；URL 不保存进文件，也不作为素材身份。Library 消费同一模块，预览资源随其页面可见性释放，不需要导入 Design。

Library 面向整个产品收集、查找和整理素材，Design 文档保存采用的确切素材版本及使用方式。设计模型不属于聊天记录，Library 的素材目录也不属于某个 Design Widget。Library 已提供图片目录、导入、搜索、收藏与集合；[Rust 素材领域](../../../../../crates/assets/src/lib.rs) 已提供原件入库、不可变版本与分块读取，Design 从文件导入时使用该领域，原始字节随设计包保存。Library 的“用于 Design”由窗口装配打开设计页并调用编辑器的素材采用入口；Design 通过共享素材服务读取确切版本，将原件纳入工作副本。同一素材版本可产生多个独立图片对象，文档只保存一份素材版本条目。Design 不持有另一份全局目录，Library 不导入 Design 的编辑模型。规划见 [DESIGN.md](DESIGN.md#library-与编辑器的归属)。

## 编辑与几何约定

文档坐标使用设计像素，100% 缩放时一个设计单位对应一个 CSS 像素。网格间隔为 12 个设计单位，显示设备的像素密度不改变文档几何。对象按数组顺序从后向前绘制，命中检测从前向后查找。旋转使用绕对象中心的顺时针角度。

路径节点及其控制点保存为对象宽高的比例；属性面板显示路径局部像素。这样改变对象尺寸时，曲线随对象一起缩放。分组子对象使用组内坐标；当前文件格式支持组的旋转与等比缩放，解组时将组变换合并进子对象的位置、尺寸和旋转。等比缩放保证解组后的子对象仍能用现有几何字段表达。

画板是固定交付范围，拥有背景和裁切开关；子对象使用画板局部坐标。自由布局画板默认在改变宽高时保留子对象几何；子对象可设置水平、垂直约束，分别保留起始边、中心、末端边、两侧边距或按父尺寸比例缩放。组保持等比尺寸，只提供位置约束。移动或旋转画板带着其内容一起变化。图层视图可选择画板内的子对象，画布方向键和拖动使用同一世界坐标方向。分组仍作为整体选中，解组后恢复子对象编辑。

导入支持 PNG、JPEG 和 WebP。图片对象引用素材及其版本，保存自己的位置、尺寸、旋转和归一化源图裁切范围。裁切通过属性区的百分比输入修改，保持原图字节完整；复制图片产生新对象身份，共享同一个素材版本，各处可以独立裁切。当前尚未实现 SVG 素材、视频导入、素材版本替换或 Library 选择器。

图层可重命名、复制、前后移动或置于顶层／底层；复制容器递归分配新对象身份，图片继续引用同一素材版本。多选对齐和等间距分布以同一父级内的旋转包围框为依据，单个对象可相对父画板对齐；自动布局内的位置由画板控制。Ctrl／Command+D 复制，Ctrl／Command+方括号调整层级，加 Shift 移至顶层／底层。属性区的“排列”提供相同操作和对齐、分布入口。

Shift+A 为所选画板添加横向自动布局，或将同级选区包入新画板。属性区支持横向／纵向／网格、间距、四边内边距、主轴与交叉轴对齐、固定尺寸和适应内容；子对象支持固定或填充容器，组保留等比尺寸。填充容器会将父画板的对应尺寸切换为固定；适应内容会将该轴的子对象切换为固定尺寸，避免循环依赖。直接修改宽高也会将该轴切换为固定。移除自动布局保留当前几何与子对象身份。

布局参数 `autoLayout`、子对象 `sizing`／`gridCell`、尺寸限制 `sizeLimits`、自由画板 `constraints` 和图层 `name` 是版本 2 的可选对象字段，旧文档缺省行为保持不变。[layout.ts](common/model/layout.ts) 在模型提交时自内向外测量适应内容的画板，再分配填充空间，并在自由画板缩放时应用约束。布局结果与参数在同一个不可变快照内提交；画布、命中、保存和导出读取同一份已解析几何，撤销恢复整次操作。横向布局支持换行，纵向布局支持换列，主轴空间不足时按图层顺序分行，跨行间距单独设置；填充对象以最小尺寸参与换行，并在各行内重新分配空间。最大尺寸可以限制适应内容的画板并触发换行。嵌套布局先分配确定的尺寸，再测量内容变化。自动布局子对象可通过图层层级操作改变顺序；画布拖动重排仍待实现。

网格使用 `autoLayout.grid` 保存行列轨道：固定像素、适应内容、按比例填充；默认自动增加／减少行数，也可保留指定行数。`gridCell` 保存子对象跨行跨列、格内对齐及手动定位的行列。自动定位按图层顺序从左到右、从上到下寻找不重叠的单元格；手动定位保留空格，冲突对象顺延并按需增加行。轨道数量减少时保留所有子对象。网格的“排列”对齐作用于各对象自己的单元格。

`sizeLimits` 为自动布局画板及非分组子对象保存可选最小／最大宽高；清空属性输入可删除限制，最小值大于最大值的输入被拒绝。固定、适应内容和填充均受限制；填充对象达到边界后，剩余空间重新分配给其他填充对象。空间不足时保留最小尺寸，是否裁切由画板决定。画板至少容纳自己的内边距。HTML 导出使用对应的 flex-wrap、grid 轨道／跨格与 min/max CSS，并保留可编辑 JSON；SVG 使用同一份已解析几何。

共享工具栏、属性贡献和键盘修改通过 `DocumentCommands` 到达 `DesignModel.applyEdit`。模型每次提交一个不可变快照，清除 redo 分支并通知 Widget 更新。撤销与重做由同一个模型执行。

填充色块打开共享 `base/browser/ui/colorPicker` 组件。颜色组件拥有二维选色、色相、不透明度和 Hex、RGB、CSS、HSL、HSB 输入；Design 属性贡献提供文档色板和当前编辑器最近使用的颜色，并拥有填色预览。切换格式不提交文档编辑。拖动只更新当前画布预览，松手时通过公共命令一次提交；取消或隐藏编辑器丢弃尚未提交的预览，其他文档编辑会关闭面板。浮层由窗口 ContextView 托管，键盘帮助和颜色文本视图沿用 Design 的无障碍详细程度设置。

拖拽过程中，共享输入层和绘制贡献只更新预览。指针释放时一次提交全部受影响对象；Escape、取消捕获或取消手势丢弃预览。其他视图提交文档或开始文件操作时，会取消当前视图的预览，保持渲染与已提交状态一致。文件替换会清空编辑历史并重置每个视图的选区；普通编辑保留仍存在的对象选择。

组件继续使用 `frame`，通过 `component.kind` 区分主组件与组件集，实例通过 `instance.componentId` 引用本地或已接受库版本中的主组件。`DesignModel` 在同一个提交中记录显式覆盖、解析布局并同步实例；继承子对象用 `sourceId` 对应主组件图层，`overrides` 只列出自有字段，值仍保存在对象上。实例展开后的不可变树用于画布、导出和删除来源后的恢复，不另建组件内容仓库。实例子对象保持稳定 ID；主组件结构变更同步增删，实例内部禁止增删、重排、位置及约束编辑。

组件集只包含主组件；命名属性与各变体的属性值组合均需唯一，允许不完整的组合矩阵。实例切换按图层名称和层级匹配覆盖；文字内容保持，原始样式不同的变体采用目标样式。嵌套实例继承外层主组件已应用的覆盖，显式替换才改用新来源；分离保留内层关联。恢复主组件、重置单项或全部覆盖、推送到主组件都经过文档历史。循环引用在文件解析和组件替换／推送边界拒绝。组件能力由 `ComponentCommands` 提供，属性面板与快捷键只调用命令；可编辑 JSON 保留全部关系，HTML/SVG 导出使用已解析的外观。

变量集合、四类变量（颜色、数值、字符串、布尔值）、样式和已接受的组件库版本保存在文档的可选 `resources` 中。集合拥有模式和默认模式；属性绑定只保存变量身份，同类型别名可跨集合，按目标集合的有效模式解析，循环别名在提交前拒绝。页面模式经图层树继承，图层显式模式优先。`DesignModel` 在同一个提交中解析资源、组件和布局，画布、命中检测、保存与导出共同使用已解析外观。隐藏子图层保留归属，但不占自动布局空间。

填充、文本、阴影和布局网格样式保存属性组合，可在样式内部引用变量。修改样式定义更新所有引用，直接编辑图层属性解除受影响的绑定或样式；删除引用保留当前外观。实例的变量绑定、样式引用和模式覆盖按单个属性记录，避免阻断其他属性从主组件继承。样式、变量和库操作均由 `ResourceCommands` 提交，不在属性控件内维护文档内容。

组件库通过现有文件服务发布为 `.ash-design-library` 文件，包含可复用组件树、变量、样式和媒体；普通画布内容不发布。库快照内已展开依赖，导入前验证结构和媒体摘要。发布不修改消费者；检查更新仅暂存候选版本，属性面板显示定义差异及组件前后预览，接受后一次提交文档历史。停用库只隐藏选择器资源，已有引用仍解析；被新版本移除的资源保留最近外观。库来源为工作区文件，支持已有本地或远程文件服务，不包含团队云目录或权限管理。

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

Code 模式从同一已提交快照生成 HTML/CSS/SVG：矩形、椭圆和画板使用 HTML/CSS，文字使用与画布一致的 HTML 排版，曲线和图片复用画布 SVG，容器保留层级和坐标变换，对象动画输出 CSS `@keyframes`。导出的 HTML 可直接打开，不依赖 Ash 运行时。对象具有稳定身份，原始设计 JSON 嵌入 `ash-design-document`，Agent 可读取几何、文本、路径和关键帧，再通过保存的 `.ash-design` 包继续编辑。图片使用内嵌数据，用户文本作为文本节点输出，嵌入 JSON 转义标签字符。

代码导出保留自由布局的实际像素和动画；明确设置的自动布局输出 Flexbox、间距、内边距和尺寸规则，自由画板约束输出对应定位规则。导出不从任意坐标推断响应式布局或业务组件。生成代码是单向输出，修改导出的 HTML 不会同步修改设计文档。导出不改变可编辑设计的保存状态；操作系统的减少动态效果设置会停止导出代码中的自动动画。

## 当前能力与验证入口

已具备矩形、椭圆、文字、贝塞尔路径、画板、PNG/JPEG/WebP 图片导入、独立裁切、多选、分组、图层命名与复制、层级调整、对齐与等间距分布、横向／纵向自动布局、自动换行、行列网格、最小／最大尺寸、主组件与实例、覆盖重置与推送、多属性变体、变量集合与模式、变量别名和属性绑定、四类样式、组件库发布与更新审核、画板尺寸约束、几何与属性编辑、撤销重做、素材包打开保存、关键帧动画编辑与播放、SVG 和 HTML 代码导出。组尺寸按比例变化，画板尺寸变化保留子对象几何；文字支持画布内编辑、字符级富文本及字体排版。Agent 候选采用、视频和媒体工作流尚未实现。

无障碍入口由 contribution 注册：帮助说明可用工具和快捷键，内容视图以文本描述文档，关闭后恢复原焦点。Widget 提供键盘操作、属性输入标签和选区状态播报；文案沿现有 NLS 加载。

从仓库根目录运行：

```sh
pnpm run typecheck:renderer
pnpm run build:renderer
pnpm run test:unit --run src/ash/sessions/test/common/designText.test.ts --run src/ash/sessions/test/common/designModel.test.ts --run src/ash/sessions/test/common/designComponents.test.ts --run src/ash/sessions/test/common/designResources.test.ts --run src/ash/sessions/test/browser/designEditorWidget.test.ts --run test/architecture/layer-boundaries.test.ts --run test/architecture/ui-styling-ownership.test.ts
pnpm run test:smoke:browser --grep 'Sessions Design'
pnpm run test:smoke:ui --grep 'Sessions Design'
pnpm run test:smoke:desktop --grep 'Sessions Design'
```

单元测试覆盖文档校验、素材引用、历史、分组与画板变换、命中检测、文件冲突、保存期间编辑、另存身份、图片备份、损坏素材拒绝、中文标签、多个视图的状态隔离和释放。Playwright 场景覆盖页面切换、主题与配置、键盘和指针操作、图片导入与独立裁切、素材包重开及 SVG/HTML 导出；桌面场景还验证移动整个包后的媒体读取。每个运行目标只执行适用的场景，分层检查约束空间数学、模型和页面之间的依赖。

### 矢量与路径

`document.ts` 保存主轮廓及额外 `subpaths`、控制柄镜像和描边属性；`designVector.ts` 负责纯曲线编辑，`VectorCommands` 经 `DesignModel` 提交拓扑与转换。节点选区和框选留在编辑器选区／输入控制器，不进入文档。钢笔点击闭合、精确插点、角点／平滑、切开／连接／反向和节点多选共用撤销历史。

布尔运算以带 `booleanOperation` 的组保留原始子图层，减法从底层减去上层，其他运算采用顶层外观。`designVectorGeometry.ts` 首次使用时加载 Paper.js 与描边轮廓算法，处理曲线、孔洞、子层变换和描边；临时计算对象不进入模型，结果缓存以不可变图层为键。SVG 画布、扁平化与导出共享轮廓结果。删除操作数可以留下单子层组，空组随最后一个子层删除。

节点圆角以像素保存在锚点和网络顶点上，`designVectorCorners.ts` 从相邻直线推导相切圆弧并约束重叠半径；编辑锚点和原始控制柄保留。`designVariableWidth.ts` 按轮廓弧长解释宽度点，以描边宽度的倍数保存厚度；插入控制点保留宽度插值的导数，不改变原外观。画布拖动、数值输入、命中检测、轮廓化与 SVG 导出共用派生轮廓。分叉网络和虚线不使用可变宽度。圆角平滑度以图层属性保存，范围 0–1，iOS 预设为 0.6；直线与圆弧之间使用三次曲线过渡，边长不足时先减少平滑度再约束半径。

`designVectorStroke.ts` 统一解释闭合轮廓的内外描边和开放端点。SVG 以双倍居中描边和填充规则裁切内／外侧，轮廓化用相同轮廓执行交集／差集，孔洞遵循 nonzero／evenodd。开放子路径保持居中。箭头及独立端帽保存在锚点上，只有网络度数为 1 的顶点生成端点外观；反向与网络转换保留端点归属。宽度轮廓会移除箭头并将描边居中。

路径偏移复用浏览器几何引擎，先处理填充规则和孔洞，再按正负距离及方角／圆角生成路径。`VectorAppearanceWidget` 持有版本和选区约束下的临时预览；确认后重算曲线边界并通过模型提交一次编辑，取消不写入历史。偏移后完全消失的路径在确认时删除，撤销可恢复。

### 原型文档与预览

图层的 `interactions` 和顶层画板的 `flowStart` 随设计文档保存，共用 `DesignModel` 的撤销历史；实例继承主组件交互，实例编辑可以覆盖交互。页面跳转目标是顶层画板，Change to 目标是同组件集的其他变体；删除目标同时清除连接，撤销恢复两者。未知外部目标保持不可执行。原型贡献只通过编辑器的坐标转换与覆盖层接口绘制连线，不让共享 Canvas 依赖 Creator。

交互的 `actions` 是有序动作树，条件分支与变量表达式随同保存，表达式引用变量 ID。读取旧版单动作记录时只在文件边界迁移到动作数组；复制、删除目标和实例覆盖均遍历同一动作树。表达式采用受限语法与类型检查，不执行脚本。

`PrototypePlayback` 为每次预览单独持有导航历史、浮层栈、变量覆盖值和模式。变量绑定及别名复用资源解析器；运行时写值不修改资源定义。动作按序求值，浏览器在一个动画完成后才继续迭代下一动作；条件采用首个匹配分支。重启丢弃运行状态，临时悬停/按压恢复快照。自定义弹簧保存质量、刚度、阻尼和初速度，由物理响应决定回弹及收敛时长。Change to 复用组件实例的继承与覆盖解析，只替换触发热点最近的实例，其他实例及文档保持原状。预览不写入文档；关闭、切换工作空间、替换或编辑文档均释放计时器和动画。Smart Animate 在相同父层级内按图层名称匹配，未匹配内容溶解；系统减少动态效果时即时完成过渡。Creator 无障碍帮助及可访问内容同时覆盖原型作者面板和当前播放状态。

画板的 `overflowDirection` 选择无滚动、水平、垂直或双向；图层的 `scrollPosition` 选择随父层滚动、固定或粘性，`layoutPositioning: absolute` 在自动布局中忽略流式尺寸和排布。固定层排在同级滚动内容上方；粘性层保持原有顺序，到视口顶端停住，并受直接父层的下边界约束。`scrollTo` 可指向同屏任意后代图层，属性选择器列出滚动画板的直接子层，连线可指向更深的图层。滚动过渡保存即时或动画设置，复用缓动与自定义弹簧。

滚动偏移仅由 `PrototypePlayback` 持有，按画板记忆并纳入临时交互快照；同名或名称包含共同 `/` 前缀的屏幕按相同父路径和图层名共享位置。导航动作的 `resetScroll` 清空目标及嵌套画板偏移，重启清空会话。预览支持滚轮、嵌套边界传递、拖动及键盘滚动，明确的 On drag 动作优先；滚动动画逐帧派生固定和粘性位置，不插值或回写设计坐标。可访问区域和热点遵循裁切范围，输入滚动不会重启延时动作。

### 分叉矢量网络与文字轮廓

路径可以切换为共享顶点与独立三次贝塞尔边组成的网络。`designVectorNetwork.ts` 拥有拓扑、精确拆分、节点移动及面遍历；网络模式不再保存原始 contour 坐标。区域填充引用边界标识，渲染时推导封闭面和孔洞，描边按分支连续遍历一次。画布钢笔可从任意节点分叉或连接已有节点，属性区提供节点、线段控制柄、区域填充与拆分／删除的键盘入口。所有修改经 DesignModel 提交并进入同一撤销历史。

`designTextOutlines.ts` 在明确转换操作时读取本地字体，或使用用户加载的字体文件。浏览器的文本范围保留换行与对齐，HarfBuzz 负责字形替换、OpenType 特性和定位，Fontkit 读取字体变体与二次／三次轮廓。扁平化形成一个复合矢量层，轮廓化按字形生成子图层；字体不可用或字形只有位图时保留原文本并显示原因。异步操作检查文档版本和选区，保存结果只包含路径，不依赖字体文件。字体解析依赖按需加载。

### 渐变、多重填充与混合

`designPaint.ts` 定义从上到下排列的 `fills`；每项独立保存可见性、不透明度和混合模式。未提供 `fills` 的旧文件继续使用 `fill`；显式空数组表示无填充，设置填充叠层后不再回写旧颜色。填充样式、变量、组件实例和库更新沿用同一模型和撤销历史。线性、径向、角度、菱形渐变保存稳定色标 ID 和三个归一化控制柄；色标允许重合形成硬边，透明颜色采用预乘插值。

`PaintPropertiesWidget` 提供填充增删、复制、排序、色标与数值控制；选中的色标共用颜色选择器。画布控制柄、色标拖拽和轴上插点只预览派生结果，结束时提交一次编辑；键盘可以移动或删除色标。图层默认穿透，填充默认正常；图层正常模式隔离内部混合，填充不能选择穿透。引用颜色样式时禁用单独修改填充混合模式。

`designPaintRendering.ts` 与画布、原型及导出共用渲染：线性和径向使用 SVG 渐变，角度和菱形使用嵌入式 PNG 纹理（最长边上限 2048 像素，编辑参数仍保持矢量数据）。18 种混合模式使用浏览器合成；Chromium 不支持的 Plus darker 由 sRGB 背景滤镜实现，并在 SVG 滤镜源中嵌入图片数据。此模式的 SVG 外观依赖支持 CSS backdrop-filter 的浏览器。图层不透明度在渲染前应用，避免画布刷新或动画覆盖已保存的外观。

行为依据：[Figma 渐变](https://help.figma.com/hc/en-us/articles/34208860210199-Use-gradients-as-a-fill-or-stroke)、[填充叠层](https://help.figma.com/hc/en-us/articles/360041003694-Guide-to-fills)、[混合与穿透](https://help.figma.com/hc/en-us/articles/360040667874-Apply-blend-modes-to-layers-fills-and-effects)。

### 阴影与模糊

`designEffects.ts` 拥有从上到下排列的效果列表。每个图层最多包含八个投影、八个内阴影、一个图层模糊和一个背景模糊；隐藏效果仍占用对应名额。阴影保存颜色与透明度、偏移、模糊、正负扩展及混合模式，投影另有透明区域后方显示开关。旧的单投影对象继续按原有外观渲染，第一次编辑时转换成列表。效果样式、库更新、组件覆盖、保存和撤销共用这个字段。

`EffectPropertiesWidget` 提供增删、复制、排序、显隐、数值输入和颜色选择器，所有控制可用键盘操作。矩形和椭圆支持扩展；画框、组件及实例需要启用内容裁切，并具有至少 1% 不透明度的可见填充。其他图层保留扩展参数，但不应用到渲染。

`designEffectRendering.ts` 在填充后、整层混合前组合 SVG 效果。投影位于内容后方，内阴影位于填充上方和路径描边下方，图层模糊作用于合成后的图层。背景模糊采样前方图层出现前的场景，排除已有背景模糊后再按当前轮廓裁切，避免重叠模糊累加。嵌入的背景快照保留旋转和容器坐标；原型滚动和动画重绘时重新采样。阴影与蒙版副本不携带交互图层标识。

支持均匀与渐进式图层／背景模糊。渐进式效果保存起点半径、终点半径和相对图层的两端位置；允许反向模糊、相等半径和范围外端点。属性面板可键盘输入半径与百分比坐标；画布支持端点与轴线拖动、Shift 方向吸附、Enter 切换端点、方向键微调及 Escape 取消，一次拖动形成一次撤销。方向重合时使用终点半径。SVG 使用最多 33 个高斯采样和权重插值近似连续半径，超出轴线两端采用对应端点半径，半径相同时直接使用均匀模糊。此近似共享于各输出，不宣称与 Figma 私有渲染器逐像素一致。画布、原型、SVG 和生成代码共用效果渲染；包含效果列表的图层及其容器在生成的 HTML 中使用 SVG，以保留叠加与裁切结果。导出边界包含阴影、模糊和未裁切子层的扩展范围。

行为依据：[Figma 图层效果](https://help.figma.com/hc/en-us/articles/360041488473-Apply-effects-to-layers)、[效果数据约束](https://developers.figma.com/docs/plugins/api/Effect/)。
