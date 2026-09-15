# Stanza 编辑器分部实施路线图

本文把 Ash TypeScript 编辑器按依赖和用户行为分成九部分。每次只完成一项能从真实入口走到可观察结果的功能，再进入下一项；文件数量、同名 API 数量和单独的类型检查都不是完成标准。

本文只维护实施顺序和验收边界。当前职责与已有实现分别见 [Editor 目录说明](../../src/ash/editor/README.md)、[文本内核](../../src/ash/editor/text-engine.md)、[富文档内核](../../src/ash/editor/document-engine.md) 和[跨系统边界](../../../docs/editor-architecture.md)；VS Code 对应关系及未处理项由 [API 对齐台账](../../src/ash/editor/api-alignment-status.md)维护。

## 范围与当前基线

- 本路线图覆盖 `ash-ts/src/ash/editor`、它在 Workbench 中的 pane 和服务接线，以及 Standalone 入口。Rust App Server 提供文件与语言等异步能力，不接管 TypeScript 编辑器的同步文本、选区或输入状态。
- 同一职责要对齐 VS Code 的公开名称、参数、事件、生命周期和可观察行为。Ash 内部依照现有 `TextModel`、视图和服务所有权独立实现；不复制上游私有结构，也不为同名而添加空方法。
- 截至 2026-09-13，Node 25 下 Editor 单测为 242/242 文件通过，浏览器集成为 54/54 通过，Renderer 构建通过。这证明已覆盖的路径可运行，不代表整个 Editor 已完成。`editor-architecture.test.ts` 仍有 11 项失败，`dom-foundation.test.ts` 仍有 2 项失败；其中既有真实职责缺口，也有需核实的旧断言。它们保持可见，逐项按生产调用链处理。

## API 名称与契约怎么对齐

**目前没有全部对上。**[API 对齐台账](../../src/ash/editor/api-alignment-status.md)仍有待处理项，结构检查发现同名也不等于行为正确。每做一个功能，都要把 VS Code 同路径的公开导出、类/接口成员、命令或注册 ID，与 Ash 当前公开面逐项对应；同时核对大小写、参数和返回类型、事件、取消、释放及真实调用方。对照结果只能记为“已验收”“待补”“Ash 专属”或“职责冲突待决定”，不能把只存在同名声明记为已验收。

| 部分 | 优先核对的 VS Code 同路径公开面 |
| --- | --- |
| 0 入口与装配 | `editor.api.ts`、`editor.all.ts`、`browser/widget/codeEditor/codeEditorWidget.ts` |
| 1 文本与文档内核 | `common/model/textModel.ts`、`common/core/{position,range,selection}.ts` |
| 2 选区与输入 | `common/cursor/cursor.ts`、`browser/view/viewController.ts`、`browser/controller/editContext/*` |
| 3 视图与几何 | `browser/view.ts`、`browser/viewParts/*`，包括 `minimap/minimap.ts` |
| 4 语言与异步结果 | `common/languages.ts`、`common/services/languageFeaturesService.ts` |
| 5 Code 编辑功能 | 本次功能对应的 `contrib/<feature>` 文件、贡献 ID 和命令 ID |
| 6 Academic 富文档 | 与行式编辑器共用的 `TextModel` 等公开面；Academic 的 schema 与功能按 Ash 自有契约验收 |
| 7 Diff 与多文件审阅 | `browser/widget/diffEditor/diffEditorWidget.ts`、`browser/widget/multiDiffEditor/multiDiffEditorWidget.ts` |
| 8 宿主与持久化 | `standalone/browser/standaloneEditor.ts`、`workbench/browser/parts/editor/editorPane.ts` |

这张表是核对入口，不表示表中 API 已对齐。Ash 专属的 Code/Academic bundle、`CodeEditorPane`、`DocumentEditorPane` 和 App Server 适配不强行套用 VS Code 名称；共享职责仍须回到上游同路径 owner。具体差异和处理决定只维护在台账中，不在这里复制一份易过期的成员清单。

以第一项为例，双方的 `standalone/browser/standaloneEditor.ts` 都有 `create`、`createModel`、`getEditors`、`onDidCreateEditor`；这只确认名称存在。`create` 的 options、返回对象、模型归属和释放，`onDidCreateEditor` 的回调类型与触发时机仍须逐项验收。上游还有 `createDiffEditor`、`createMultiFileDiffEditor` 等入口，放到第 7 部分按真实调用需求核对，不能因为第 0 部分通过就宣称整个公开 API 对齐。

## 一次只做一个功能

每项工作先写出一条短链：**用户动作 → 生产入口 → 唯一状态与 DOM owner → 状态变化 → 可观察结果 → 测试**。先查 Ash 的调用方、实现和测试，再查 VS Code 同路径的公开契约与行为；只在当前链路需要时修改文件。未接线的 Editor 文件先查标准 bundle 和调用方，不能为让架构测试变绿而删除。

一个功能完成须同时满足：

1. 同路径公开文件、导出、成员和注册名称已逐项核对；真实入口已经调用目标职责，旧入口和重复状态退出。行为、事件顺序、失败和释放语义也须一致。
2. 现有行为没有退化；新行为由 owner 级测试和必要的 Playwright 浏览器或 Electron 用例观察。键盘、屏幕阅读器、主题与高对比度在涉及界面时同批验收。
3. 受影响的 TypeScript 编译和正常 Renderer 构建通过；相关架构断言通过。全量架构套件中的其他既有失败须准确记录，不能改弱断言来隐藏缺口。
4. 更新本表的状态和 [API 对齐台账](../../src/ash/editor/api-alignment-status.md)中受影响的项目。未完成的能力仍标为未完成。

## 分部顺序

表中的“基础具备”只表示仓库已有实现和测试，不表示该部分已经验收完成。后续部分可以先调查，但实现要沿依赖从下向上闭合。

| 顺序 | 部分 | 主要 owner | 逐项完成的用户行为 | 当前状态 |
| --- | --- | --- | --- | --- |
| 0 | 入口与装配 | `editor.api.ts`、`editor.*.all.ts`、`CodeEditorWidget` | 创建、挂载、切换模型、激活贡献、释放 | 0.1–0.4 行为已验收；完整 Widget API 仍待随各分部核对 |
| 1 | 文本与文档内核 | `common/model`、`common/core` | 编辑、撤销、快照、结构事务、超大文件 | 1.1–1.5 已验收；完整公开 API 仍待随其他分部核对 |
| 2 | 选区与输入 | `common/cursor`、`browser/controller` | 键盘和指针编辑、多光标、IME、剪贴板 | 2.1–2.4、2.6 已验收；2.5 浏览器事件链已验收，平台输入法待验收 |
| 3 | 视图与几何 | `common/viewModel`、`common/viewLayout`、`browser/view*` | 换行、滚动、命中、装饰、控件、DOM/GPU 绘制 | 3.1–3.3 已验收；3.4 已验证区域收起与块装饰联动，其余待逐项验收 |
| 4 | 语言与异步结果 | `common/languages`、`common/services`、语言贡献 | 配置、分词、诊断、折叠、符号、过期结果拒绝 | 部分具备 |
| 5 | Code 编辑功能 | `contrib/<feature>` | 查找、补全、悬停、导航、重命名、代码操作等 | 部分具备 |
| 6 | Academic 富文档 | `common/model` 的文档语义、`RichTextEditorWidget`、Academic 贡献 | 结构编辑、代码区域、格式、协作 | 部分具备 |
| 7 | Diff 与多文件审阅 | `DiffModel`、diff/multi-diff widget | 比较、同步滚动、内联差异、多文件审阅 | 部分具备 |
| 8 | 宿主与持久化 | `standalone`、Workbench editor pane 与服务 | 打开、保存、回退、冲突、恢复、模式切换 | 部分具备 |

### 0. 入口与装配

先验收外部传入模型与编辑器自己创建的模型各由谁释放，再验收 `editor.create`、Workbench pane 和 Code/Academic bundle 是否只装配各自的能力。一个贡献必须从标准入口真正激活，并随编辑器释放；“源文件存在”不算接入。

### 1. 文本与文档内核

按原子编辑与 UTF-16 坐标、版本和快照、undo/redo 与选区映射、稳定行身份和文档语义、超大文件预算的顺序处理。文本和结构事务都只由 `TextModel` 提交；浏览器视图不保存另一份权威文本。每项用模型测试覆盖边界、失败不留半次提交，并检查两个编辑器共享同一模型时的状态隔离。

### 2. 选区与输入

按键盘导航与编辑、指针和拖动、多光标、textarea 与 EditContext、IME、剪贴板的顺序处理。每个输入先归一成一个编辑意图，再由拥有选区的控制器提交；验证组合输入取消、焦点转移、撤销和浏览器默认行为不会造成双写。

### 3. 视图与几何

按行布局与软换行、可见行复用、光标和 gutter、装饰与 View Zone、滚动条和 Minimap、GPU 绘制的顺序处理。`View` 管装配和渲染时序，Part 管自己的节点；布局坐标、指针命中和输入候选位置须引用同一几何结果。浏览器测试检查 DOM 身份、计算样式、滚动和释放，不靠截图判断正确性。

### 4. 语言与异步结果

先完成语言身份和配置，再完成 provider 注册与取消、版本化 token/diagnostic 结果、TextMate 与 App Server 适配、折叠和符号。Worker 和后端只返回带版本的事实；过期结果不能覆盖较新模型。一次功能须从真实 provider 走到 Editor 可见结果，并验证失败和 dispose。

### 5. Code 编辑功能

每个贡献独立交付，不把所有贡献当成一批文件迁移。建议顺序是查找/替换、补全/悬停、跳转/引用、重命名/代码操作、格式化及其余交互。每项核对标准注册入口、命令与快捷键、取消、选区变化、可访问性和销毁；功能逻辑留在贡献，文件与产品决策留在 Workbench。

### 6. Academic 富文档

先验收 schema 和事务，再验收段落、表格、代码区域的输入与选区，接着验收格式、剪贴板、序列化和协作。代码区域仍属于同一个 `TextModel`，不能启动嵌套 Code 编辑器。持久格式或协作 schema 变化必须同时验证旧数据的读取与迁移。

### 7. Diff 与多文件审阅

依次验收版本绑定的差异计算、单文件 Diff 的行内与跨行几何、同步滚动和选择、多文件列表与切换。比较结果只读当前版本的模型；切换输入或关闭 pane 后取消旧请求并释放旧视图。

### 8. 宿主与持久化

在第 0 部分建立挂载契约后，再逐项闭合 Standalone 服务、Workbench pane/input、文件 dirty/save/revert、外部变更冲突、工作副本恢复和 Code/Academic 模式装配。Workbench 持有文件与 pane 生命周期；Editor 仍持有编辑事务、选区和视图。Web 与 Electron 分别用真实入口验证。

## 第一项工作：0.1 编辑器创建与释放（已验收）

0.1 的验收链是：调用 `editor.create`，分别传入 `editor.createModel` 创建的模型和使用 `value` 隐式创建模型；完成一次输入，销毁编辑器，再检查模型归属、注册表、贡献和 DOM/监听资源。生产链从 `editor.api.ts`、`standalone/browser/standaloneEditor.ts`、`standalone/browser/standaloneCodeEditor.ts` 到 `browser/widget/codeEditor/codeEditorWidget.ts` 和 `TextModel`。

2026-09-13 已验收：Standalone 创建事件在贡献、主题绑定和释放责任建立后发出；回调可立即使用或释放编辑器。显式模型在编辑器销毁后继续可用，隐式模型随编辑器销毁；注册表、贡献实例、DOM 和主题绑定同时退出。`standaloneEditor.test.ts`、`editorExtensions.test.ts`、`codeEditorWidget.test.ts` 的相关单测及 `standalone.integration.spec.ts` 的真实 Chromium 输入与释放用例覆盖这条链。

## 0.2 Workbench pane 切换文件（已验收）

用户在同一 pane 打开另一文件时，`CodeEditorPane.setInput` 获取新模型并创建新 part，随后释放旧 part 和旧模型引用。切换前焦点若仍在 pane 内，新 part 布局后恢复编辑焦点；焦点已移到外部时不抢回。`codeEditorPane.test.ts` 和 `textModel.integration.spec.ts` 验证旧模型、DOM、编辑器服务登记退出，新文件可直接接收键盘输入。此项验收的是 Workbench 输入切换，不代表同一 `CodeEditorWidget` 实例已支持 `setModel`。

## 0.3 Code/Academic bundle 与贡献释放（已验收）

Code 模式入口加载行式编辑贡献，Academic 模式入口只加载文档格式与协作贡献。两个独立浏览器入口从真实 pane 验证贡献注册、对应 UI 激活、互不混装和销毁后 DOM 退出。Academic 工具栏的监听随贡献释放；协作成员列表重绘时旧按钮监听立即释放，销毁后的异步结果不能再写回 DOM。`collaborationContribution.test.ts`、`formattingContribution.test.ts` 与 Code/Academic 浏览器用例覆盖这些行为。

## 0.4 同一 Widget 切换模型（行为已验收）

调用 `setModel` 时，`CodeEditorWidget` 保持对象、注册表身份和根 DOM，按模型释放旧 worker、ViewModel、View、输入与贡献，再装配新模型。切换前聚焦的编辑器在新模型挂接后恢复焦点；内容、光标、模型和装饰事件只读取当前模型。外部 Widget 与装饰集合句柄保留，旧模型上的装饰清除；空模型与外部销毁模型都释放旧视图并允许再次挂接。Standalone 在切走隐式模型时释放它，外部传入的模型始终由调用方持有。`CodeEditorWidget`、Standalone、Observable owner 级测试及 Chromium 公开入口用例覆盖输入、共享模型隔离、事件顺序、失败后的空状态、资源与销毁。Widget 的其余公开 API 差异仍按各自用户行为分部留在对齐台账，不计作本项完成。

## 1.1 原子编辑与 UTF-16 坐标（已验收）

调用公开编辑器的 `executeEdits` 时，`TextModel` 先把编辑范围约束到文档和完整的 UTF-16 字符边界，再检查整批范围是否重叠。两个各占半个代理对的相邻编辑会被判为重叠，整批拒绝且文本、版本、历史和内容事件保持不变；单个跨行编辑则扩展到完整字符后一次提交。公开 offset/position 转换保留 UTF-16 码元位置，并约束越界输入。模型、Piece Tree 测试和真实 Chromium 用例覆盖这些边界；两个编辑器共享同一模型时，拒绝和提交的结果在两个视图中一致。

## 1.2 版本与快照（已验收）

调用公开编辑器或模型的 `setValue`，即使写入内容相同，也会清空旧历史、推进模型版本并发布一次重置事件。旧版本的异步语言请求因此失效；已经创建的顺序快照和版本化快照仍可在后续编辑、重置或模型释放后读取原内容。已释放模型拒绝写入时不会消费传入的快照。模型测试覆盖版本、事件、请求失效、BOM 和快照生命周期；真实 Chromium 用例确认共享模型的两个编辑器保持相同内容，且公开入口产生新版本。

## 1.3 Undo/redo 与选区映射（已验收）

一个模型事务保存编辑前后的选区，键盘撤销与重做分别恢复原选区和结果选区，包括多光标及反向选择。空编辑或校验失败不关闭正在合并的撤销组，随后连续输入仍一次撤销。两个 Standalone 编辑器共享模型时，发起编辑者保持焦点并恢复自己的选区，另一编辑器保留独立选区；Code Action 菜单仅在自身拥有焦点时把焦点还给所属输入节点。模型历史测试和真实 Chromium 用例覆盖文本、版本、DOM、焦点、Escape 与菜单因内容变化关闭。

## 1.4 稳定行身份与文档语义（已验收）

行点转换以行 ID 找到对应的物理行，再按该行长度校验 UTF-16 offset；负数和非整数行索引直接拒绝。拆行或重置先在 `TextModel` 中计算并校验全部新行 ID，生成器失败时不修改文本、版本、历史或事件，也不占用已预留的 ID。成功提交后，未受影响行的 ID 保持不变，撤销和重做恢复对应身份。结构文档仍由同一个模型提交事务，其代码行 ID、区域和语言属性随事务保持对应；模型测试与两个共享模型的 Chromium 编辑器用例验证这些行为。

## 1.5 超大文件预算（已验收）

`ModelService` 从现有 `editor.largeFileOptimizations` 设置取得创建选项，`TextModel` 只在创建时按文本长度和行数决定分词、同步与整份读取预算；改设置不会中途重建已打开模型的策略。关闭优化只移除分词和堆操作门槛，同步上限始终生效。超出堆预算时 `getValue`、`getText` 和 `getLinesContent` 拒绝整份物化，顺序快照仍可分块读取。模型服务、预算边界和堆读取测试，以及真实 Chromium 中两个编辑器共享约 20 MiB 模型的用例覆盖这条链。第 1 部分的逐项行为已验收，整个 Editor 仍按后续分部继续验收。

## 2.1 键盘导航与编辑（已验收）

键盘事件先交给补全等输入消费者决定是否处理，再发布公共按键事件；已处理事件不再进入光标导航。补全打开时，方向键只切换建议项和 ARIA 活动项，编辑器光标保持不变，Enter 只提交选中的补全。普通输入下，Shift 扩选、Backspace、撤销、方向键与字符输入依次由当前编辑器选区和模型事务处理，不发生双写。Widget owner 测试与真实 Chromium 用例覆盖这两条链；下一项是指针与拖动。

2026-09-15 补全会话与片段导航已迁入浏览器层并通过 `ICodeEditor` 操作。Tab/Shift+Tab 切换占位符结束当前输入的撤销组，真实 Chromium 验证两个占位符编辑、离开片段及撤销。只读接受、选项修改与模型切换后迟到结果由真实 Widget 单测覆盖；完整 Suggest/Snippet API 仍在对齐台账中待验收。

片段选项切换将所有镜像和转换结果作为一次编辑提交，撤销、重做后按当前文本继续切换。真实 Chromium 覆盖转换结果位于两个镜像之间及位于源占位符之前的键盘操作。首次展开在声明解析完成后计算转换文本和最终范围，覆盖后置默认值、选项和嵌套转换。

## 2.2 指针与拖动（已验收）

鼠标手势由 `pointerdown` 保留 pointer ID，再用 `mousedown.detail` 判断单击、双击和三击；触控与笔仍从 `pointerdown` 进入同一选择链。真实双击选中完整单词，跨行拖动只改变当前编辑器选区，不修改共享模型或另一个编辑器的选区。`pointerup` 结束指针会话后，兼容 `mouseup` 不再重复发布公开事件；若缺少 `pointerup`，`mouseup` 仍结束手势。松开后移动指针不会继续扩选。PointerHandler、Widget owner 测试和 Chromium 用例覆盖这些行为。

## 2.3 多光标（已验收）

在真实编辑器中用 Alt 点选添加第二光标，再点同一位置会移除它；重新加入后一次键入在两行各插入一个字符，只产生一个模型版本和一次可撤销事务。光标集合属于当前编辑器，另一个共享模型的编辑器保持自己的单光标。`CursorsController` owner 测试覆盖事务、结果选区和撤销，Chromium 用例覆盖点选、切换、输入与共享模型隔离。

## 2.4 Textarea 与 EditContext（已验收）

同一 Standalone 用户动作分别经 textarea 和 EditContext 输入节点：在行中按 Enter 只提交一个模型版本，撤销恢复文本和选区。焦点转移到另一个编辑器后，旧节点迟到的文本更新、不可取消的 textarea 输入与撤销键均不能写回旧模型或抢回焦点；EditContext 会把浏览器文本窗口恢复到模型状态。Widget owner 测试和两组独立 Chromium 用例覆盖正常输入与失焦边界。下一项是 IME。

## 2.5 IME 浏览器事件链（已验收）

Textarea 和 EditContext 的候选文本连续改写各提交可观察的临时版本，结束组合后只占一个撤销步骤；撤销恢复初始文本和选区。组合期间按 Escape 或把焦点移到另一个编辑器时，临时文本和选区回到组合前，装饰与组合态清除；旧输入节点迟到的 `compositionstart/update/end` 不会重启组合、写入旧模型或抢回焦点。输入 owner 测试与六个 Chromium 用例覆盖提交、取消和失焦边界。这些用例在浏览器中合成组合事件；系统输入法候选窗口和 Electron 行为仍需平台验收。下一项是剪贴板。

## 2.6 剪贴板（已验收）

Textarea 与 EditContext 都由当前输入节点处理复制、剪切和粘贴：复制保留选区文本与编辑器元数据，剪切和粘贴各提交一次可撤销事务；焦点移走后旧节点的剪贴板事件不再读取旧选区或改写旧模型。Web EditContext 不会由浏览器默认发出键盘复制事件，因此同路径 `clipboard.ts` 的标准贡献把该节点的复制、剪切和粘贴快捷键送入现有剪贴板操作；旧 capability 注册不再进入 Code bundle。浏览器报告 `execCommand('cut')` 成功却未发出事件时，命令仍会写入系统剪贴板后删除选区。命令式粘贴等待读取、剪切等待写入时，会在提交前重新核对焦点、模型身份、版本和选区；任何一项变化就放弃该次编辑。命令 owner 测试、四个 DOM 事件用例和两个真实键盘/浏览器剪贴板 Chromium 用例覆盖这些行为；第 2 部分仍保留 2.5 所述系统输入法平台验收。

## 3.1 行布局与软换行（已验收）

同一 Standalone 模型行在窄视口中投影成多个视图行；调整宽度或增量修改文本后，可见行数、内容高度和 DOM 行一起更新，点击续行仍回到正确的模型列，模型行数与版本不会因布局改变。非等宽字体的 DOM 测量现在优先在正文后的空格处断行，`wordBreak: keepAll` 尽量把连续 CJK 文本移到下一行；一整段放不下时仍在字素边界强制断行。投影 owner 测试与两个 Chromium 用例覆盖这些行为。下一项是可见行复用。

## 3.2 可见行复用（已验收）

滚动时 `ViewLayer` 只移除离开视口的文本行与覆盖行，并插入新进入的行；重叠行保持同一个 DOM 节点且整个过程中不脱离文档。增量修改可见文本会更新该行内容而保留行根，旧行离开视口后断开，编辑器释放时当前可见行也全部断开。80 行模型、80px 视口的 Chromium 用例通过 DOM 身份、`MutationObserver`、内容、版本和释放状态验证这条链。下一项是光标和 gutter。

## 3.3 光标与 gutter（已验收）

一个模型行折成多条视图行时，行号只在首行出现，glyph marker 固定于对应模型行的起点，光标按当前模型列落在正确续行。相对行号以模型行而非视图行计算；光标移到下一模型行或首行内容缩短后，光标、行号和 marker 沿同一纵向布局更新，单纯移动光标不改变模型版本。Chromium 用例与既有光标、行号、glyph owner 测试覆盖这条链，本项不需要修改三个 Part 的生产实现。下一项是装饰与 View Zone。

## 3.4 装饰与 View Zone（进行中）

2026-09-15 修复 View Zone 拒绝零高度的问题：`heightInPx: 0` 和 `heightInLines: 0` 都允许创建收起的区域，并通过 `layoutZone` 展开、移动和再次收起。区域沿用同一 DOM 节点，margin 同步隐藏与展开；空白区变化不修改文本版本。块装饰包含相邻区域的空白，区域展开时块装饰增高、文本光标下移，区域移到当前行之后时光标回到原位置。两个 Standalone Chromium 回归用例覆盖这条链及删除后的节点退出。软换行、隐藏行与滚动交叉场景继续分项验收，不能把收起区域的修复视为 3.4 全部完成。

同日补充修复折叠行坐标转换：隐藏行的列号不再用于折叠标题的换行计算，而是定位到已保留的标题末尾。此前 `showInHiddenAreas: true` 的区域在三条显示行的标题折叠后会错误插在第一条之后（20px），现在位于标题末尾（60px）。两条坐标回归测试覆盖短、长隐藏行以及换行开启与未发生换行的情况；Standalone Chromium 用例覆盖真实折叠按钮、滚动、展开、文本版本不变和节点释放。该用例尚未覆盖 Electron，3.4 保持进行中。

同日补充修复区域回调丢失 `this`：`onComputedHeight` 和 `onDomNodeTop` 都绑定到传入的区域对象。Standalone 用对象方法读写区域 DOM，验证零高度展开、折叠隐藏、展开恢复、滚动后的高度与位置通知、模型版本不变及节点释放。此项仍未完成系统输入法和全部 Electron 平台验收。

整个 Editor 的最终验收还要求上述各部分的真实入口、单测、浏览器/Electron 行为、Renderer 构建和相关架构测试全部闭合。当前已通过的套件不能代替仍未覆盖的平台、屏幕阅读器或未接线能力。
