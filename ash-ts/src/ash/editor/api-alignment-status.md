# Editor API 对齐状态

> 本表记录 2026-08-30 对 `ash-ts/src/ash/editor` 生产 TypeScript 文件的扫描结果。分层依据为 VS Code 的 [Source Code Organization](https://github.com/microsoft/vscode/wiki/Source-Code-Organization) 和仓库内 `vscode-api-alignment` skill。

## 逐文件行为审查（2026-09-15）

本次清点得到 530 个非测试 TypeScript 文件：common 254、browser 120、contrib 144、standalone 6、顶层 6。下表记录本轮实际阅读的 40 个文件及其结论；“已检查”只代表表述的行为已检查，不代表全部 API 或边界已完成。其余 490 个文件的本轮全量静态检查见下一节；静态扫描与逐行行为审查分开记录。

本批生产修改限定在 UTF-16 格式化、worker 值替换和语言请求有效性三条调用链，保持现有模型、worker 和 contribution 的职责。新增模型语言快照字段由请求工厂统一创建，Workbench JSON 提供者测试同步使用该工厂。

| 文件（相对 editor） | 本轮结论 |
| --- | --- |
| `common/core/text/textLength.ts` | 已修复：UTF-16 列数把 emoji 计为两个代码单元。 |
| `common/core/edits/textEdit.ts` | 已修复：最小编辑不从代理项对中间截断。 |
| `common/services/editorWorkerRequestExecutor.ts` | 已修复：行末字符参与值替换；空选区递增整个数字。 |
| `common/languages/languageFeatureRequest.ts` | 已修复：检查模型销毁与请求开始时的模型语言；请求语言参数独立保留。 |
| `common/core/text/positionToOffset.ts` | 已检查坐标转换入口与依赖。 |
| `common/core/text/positionToOffsetImpl.ts` | 已检查偏移转换；CRLF 内部偏移的调用约束待进一步核对。 |
| `common/core/text/abstractText.ts` | 已检查范围取值和坐标转换。 |
| `common/core/edits/arrayEdit.ts` | 已读实现；未确认当前生产调用链，不改动。 |
| `common/core/edits/edit.ts` | 已检查编辑排序、归一化与合并。 |
| `common/core/edits/lengthEdit.ts` | 已检查长度映射及模型调用点。 |
| `common/core/edits/stringEdit.ts` | 已检查字符串偏移编辑；其 UTF-16 偏移语义不等同于模型位置校正。 |
| `common/core/edits/lineEdit.ts` | 已检查行编辑转换；大数组展开的实际规模待核对。 |
| `common/model/mirrorTextModel.ts` | 已读实现；未确认当前生产调用链，不改动。 |
| `common/model/prefixSumComputer.ts` | 已检查前缀和与边界查询。 |
| `common/model/textBufferSnapshot.ts` | 已检查快照读取与切片边界。 |
| `common/model/textBufferFactory.ts` | 已检查缓冲区创建入口。 |
| `common/model/textModelLargeFile.ts` | 已检查大文件阈值。 |
| `common/model/indentationGuesser.ts` | 已检查缩进样本与推断流程。 |
| `common/model/historyCoalescing.ts` | 已检查历史合并条件。 |
| `common/model/trackedRange.ts` | 已检查编辑和 EOL 变化后的范围追踪。 |
| `common/model/textModelPart.ts` | 已读生命周期实现；实际继承链待核对。 |
| `common/model/utils.ts` | 已检查缩进列计算。 |
| `common/model/tokens/semanticTokensTextModelPart.ts` | 已检查语义 token 调度与协调器调用。 |
| `common/commands/replaceCommand.ts` | 已检查替换范围与选区恢复。 |
| `common/commands/surroundSelectionCommand.ts` | 已检查包裹操作；普通包裹类的生产装配待核对。 |
| `common/commands/trimTrailingWhitespaceCommand.ts` | 已检查保存调用链；token 偏移边界仍待行为复现，不计为已修复。 |
| `common/commands/shiftCommand.ts` | 已检查缩进操作；重复字符串缓存规模待核对。 |
| `common/languages/languageResultStore.ts` | 已检查版本与重入处理；语言切换的调用方清理仍待完整核对。 |
| `contrib/hover/common/hover.ts` | 已检查请求和异步结果校验，消费本轮公共修复。 |
| `contrib/gotoSymbol/common/languageNavigation.ts` | 已检查请求和结果校验；新增语言切换、模型销毁回归。 |
| `contrib/documentSymbols/common/languageDocumentSymbols.ts` | 已检查请求和异步结果校验，消费本轮公共修复。 |
| `contrib/smartSelect/common/selectionRanges.ts` | 已检查请求和异步结果校验，消费本轮公共修复。 |
| `contrib/folding/common/languageFoldingRanges.ts` | 已检查请求和异步结果校验，消费本轮公共修复。 |
| `contrib/parameterHints/common/languageParameterHints.ts` | 已检查请求和结果校验；提前取消时是否调用提供者待继续核对。 |
| `contrib/codeAction/common/languageCodeActions.ts` | 已修复：每个 action 保留原提供者及原始对象，resolve 不再调用其他提供者；控制器应用与无 resolver 回归通过。 |
| `contrib/links/common/languageLinks.ts` | 已检查请求和异步结果校验，消费本轮公共修复。 |
| `contrib/rename/common/languageRename.ts` | 已检查请求和结果校验；提前取消时是否调用提供者待继续核对。 |
| `contrib/inlineCompletions/browser/model/provideInlineCompletions.ts` | 已检查提供者请求和异步结果校验，消费本轮公共修复。 |
| `contrib/inlayHints/common/languageInlayHints.ts` | 已检查请求和异步结果校验，消费本轮公共修复。 |
| `contrib/colorPicker/common/languageColors.ts` | 已修复：提供者异常返回后检查版本、语言与存活状态，3 项回归先失败后通过。 |

## 剩余文件全量静态检查（2026-09-15）

覆盖上表之外的全部 **490 个生产 TypeScript 文件**：common 226、browser 120、contrib 132、standalone 6、顶层 6。扫描解析了每个文件的完整语法树，提取静态/动态导入、Worker URL、导出、await、catch 和资源操作，并反查生产和测试引用。随后人工追踪下表明确标注的风险文件。**这完成了全量静态检查，不等同于 490 个文件逐行语义审查完成；未标注人工追踪的文件仅有静态证据。**

全量结果：530 个生产文件均能解析，相对 TypeScript 导入均能定位；未发现 Editor 对 Workbench/code/sessions 的反向导入，或 common 对 browser/node 实现的导入。4 个 common 文件仍引用 contribution 契约，见下表。62 个文件包含 await。引用数包含类型引用，不等于运行时可达性；测试引用数也不等于行为覆盖率。

本轮复现后修复 10 个实现文件：代码操作、重命名、参数提示、调用/类型层级、颜色展示、折叠区间、词语正则、MARK 标题正则、缩进列计算、Unicode 高亮。颜色展示文件已在首批 40 个文件中，因此本表中新增修复记录为 9 项。未复现的风险和缺少生产调用的端口保留为待验证，不做推测性改动。

剩余文件中的人工检查/修复记录为 **166/490**；另外 **324** 个文件目前仅有静态扫描证据。

### 后续修复：括号删除与代码操作归属

- `bracketEditing.ts`：一个光标命中括号时，其他非空选区不再被清空，选区方向和撤销仍由现有命令执行器维护。
- `languageCodeActions.ts`：提供者解析自己的原始 action；原提供者没有 resolver 时不会调用其他提供者。弱引用关联不改变对外 action 格式。
- 两份定向测试修复前合计 4 项失败，修复后 6 项全部通过；7 项 Playwright 回归通过。Stanza 和 Renderer 正常构建通过，无新增构建 warning。保留既有 JSDOM Canvas 与颜色环境提示。

### 待继续追踪的主要风险

- 链接、行内提示、层级展开：功能卸载和异步返回交错时的 DOM/请求清理仍需复现。
- 富文本图片粘贴：读取图片期间正文或选区变化后可能恢复旧选区，尚未执行真实图片解码回归。
- 字体及 GPU 样式缓存：多窗口过期、undefined 与 false/0 的区分仍需专门场景验证。
- 4 个 common 文件的 contribution 依赖需要迁移契约归属；本轮没有以改 import 的方式隐藏依赖。

<details>
<summary>展开 490 个文件的检查记录</summary>

路径相对 `editor/`。引用列为“直接生产引用文件数 / 直接测试引用文件数”；不含外部使用者，也不能用零引用断定文件应删除。

| 文件 | 引用 | 检查证据与状态 |
| --- | --- | --- |
| `browser/config/charWidthReader.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/config/domFontInfo.ts` | 7 / 1 | 人工检查：已通读入口、公开数据和同步状态变化；未发现本轮可复现缺陷。 |
| `browser/config/editorConfiguration.ts` | 2 / 3 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/config/elementSizeObserver.ts` | 1 / 0 | 人工追踪：ResizeObserver、帧任务和 stopObserving 清理。 |
| `browser/config/fontMeasurements.ts` | 1 / 1 | 人工追踪：单个到期任务仅清理首个窗口缓存，多窗口过期行为待验证。 |
| `browser/config/migrateOptions.ts` | 2 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `browser/config/tabFocus.ts` | 2 / 1 | 人工检查：Tab 焦点模式切换与事件发布。 |
| `browser/controller/dragScrolling.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/controller/editContext/clipboardUtils.ts` | 10 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/controller/editContext/editContext.ts` | 7 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/controller/editContext/native/debugEditContext.ts` | 0 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 未发现直接生产导入，保留并核对装配。 |
| `browser/controller/editContext/native/editContextFactory.ts` | 2 / 1 | 人工检查：已通读短模块的入口、边界及返回值；未发现本轮可复现缺陷。 |
| `browser/controller/editContext/native/nativeEditContext.ts` | 3 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/controller/editContext/native/nativeEditContextRegistry.ts` | 2 / 1 | 人工检查：已通读入口、公开数据和同步状态变化；未发现本轮可复现缺陷。 |
| `browser/controller/editContext/native/nativeEditContextUtils.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/controller/editContext/native/screenReaderContentRich.ts` | 1 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `browser/controller/editContext/native/screenReaderContentSimple.ts` | 2 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/controller/editContext/native/screenReaderSupport.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/controller/editContext/native/screenReaderUtils.ts` | 3 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `browser/controller/editContext/screenReaderUtils.ts` | 2 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `browser/controller/editContext/textArea/textAreaEditContext.ts` | 3 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/controller/editContext/textArea/textAreaEditContextInput.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/controller/editContext/textArea/textAreaEditContextRegistry.ts` | 1 / 1 | 人工检查：owner id 重复检查和注册撤销；同一实例重复注册是否允许由调用方约束。 |
| `browser/controller/editContext/textArea/textAreaEditContextState.ts` | 2 / 2 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `browser/controller/mouseHandler.ts` | 3 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/controller/mouseTarget.ts` | 3 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `browser/controller/pointerHandler.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/coreCommands.ts` | 5 / 3 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `browser/dataTransfer.ts` | 1 / 0 | 静态语法与依赖已扫描；含异步路径、含资源/集合操作；未作逐行行为结论。 |
| `browser/editorBrowser.ts` | 78 / 20 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `browser/editorDom.ts` | 6 / 2 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/editorExtensions.ts` | 57 / 16 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/gpu/atlas/atlas.ts` | 4 / 0 | 人工检查：公开数据/服务契约及依赖方向，无独立可释放状态。 |
| `browser/gpu/atlas/textureAtlas.ts` | 3 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/gpu/atlas/textureAtlasPage.ts` | 3 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/gpu/atlas/textureAtlasShelfAllocator.ts` | 1 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/gpu/atlas/textureAtlasSlabAllocator.ts` | 1 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/gpu/bufferDirtyTracker.ts` | 1 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `browser/gpu/contentSegmenter.ts` | 3 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `browser/gpu/css/decorationCssRuleExtractor.ts` | 1 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/gpu/css/decorationStyleCache.ts` | 3 / 2 | 人工追踪：缓存键合并 undefined 与 false/0 的语义，待 GPU 样式场景验证。 |
| `browser/gpu/gpu.ts` | 5 / 0 | 人工检查：公开数据/渲染契约和依赖方向，无独立可释放状态。 |
| `browser/gpu/gpuDisposable.ts` | 5 / 0 | 人工检查：设备、buffer、texture 返回可释放句柄；初始 buffer 写入抛错时的资源释放待验证。 |
| `browser/gpu/gpuUtils.ts` | 8 / 0 | 人工检查：已通读入口、公开数据和同步状态变化；未发现本轮可复现缺陷。 |
| `browser/gpu/objectCollectionBuffer.ts` | 2 / 2 | 人工追踪：扩容、删除搬移、脏区和条目释放。 |
| `browser/gpu/raster/glyphRasterizer.ts` | 5 / 2 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `browser/gpu/raster/raster.ts` | 7 / 0 | 人工检查：公开类型、请求参数及依赖方向；此文件不持有运行时资源。 |
| `browser/gpu/rectangleRenderer.ts` | 2 / 2 | 人工追踪：设备就绪后检查销毁状态；资源归入持有者。 |
| `browser/gpu/rectangleRenderer.wgsl.ts` | 1 / 0 | 人工检查：shader binding、滚动/视口坐标到裁剪坐标变换；零尺寸防护由 renderer 入口负责。 |
| `browser/gpu/renderStrategy/baseRenderStrategy.ts` | 2 / 0 | 人工检查：已通读入口、公开数据和同步状态变化；未发现本轮可复现缺陷。 |
| `browser/gpu/renderStrategy/fullFileRenderStrategy.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/gpu/renderStrategy/fullFileRenderStrategy.wgsl.ts` | 2 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `browser/gpu/renderStrategy/viewportRenderStrategy.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/gpu/taskQueue.ts` | 1 / 0 | 人工追踪：队列清理与窗口任务；销毁后重入需结合调用方继续验证。 |
| `browser/gpu/viewGpuContext.ts` | 9 / 2 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/observableCodeEditor.ts` | 2 / 2 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/services/abstractCodeEditorService.ts` | 1 / 2 | 静态语法与依赖已扫描；含异步路径、含资源/集合操作；未作逐行行为结论。 |
| `browser/services/bulkEditService.ts` | 4 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `browser/services/codeEditorService.ts` | 14 / 7 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `browser/services/contribution.ts` | 3 / 6 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/services/editorWorkerService.ts` | 8 / 3 | 静态语法与依赖已扫描；含异步路径、含资源/集合操作；未作逐行行为结论。 |
| `browser/services/inlineCompletionsService.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/services/markerDecorations.ts` | 1 / 0 | 人工检查：已通读短模块的入口、边界及返回值；未发现本轮可复现缺陷。 |
| `browser/services/openerService.ts` | 1 / 1 | 人工追踪：外部 URI 解析结果释放缺失；现有装配创建实例，实际 open 调用链待确认。 |
| `browser/services/renameSymbolTrackerService.ts` | 1 / 1 | 人工检查：已通读入口、公开数据和同步状态变化；未发现本轮可复现缺陷。 |
| `browser/stableEditorScroll.ts` | 2 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `browser/triggerInlineEditCommandsRegistry.ts` | 2 / 2 | 人工检查：已通读短模块的入口、边界及返回值；未发现本轮可复现缺陷。 |
| `browser/view.ts` | 38 / 6 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/view/domLineBreaksComputer.ts` | 1 / 2 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/view/dynamicViewOverlay.ts` | 9 / 0 | 人工检查：已通读短模块的入口、边界及返回值；未发现本轮可复现缺陷。 |
| `browser/view/renderingContext.ts` | 36 / 3 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `browser/view/viewController.ts` | 9 / 5 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/view/viewLayer.ts` | 6 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/view/viewOverlays.ts` | 1 / 0 | 人工追踪：HTML 来自动态装饰渲染器；仍需逐类核对渲染字符串来源。 |
| `browser/view/viewPart.ts` | 19 / 2 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/view/viewUserInputEvents.ts` | 1 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `browser/viewParts/blockDecorations/blockDecorations.ts` | 1 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `browser/viewParts/contentWidgets/contentWidgets.ts` | 1 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/viewParts/currentLineHighlight/currentLineHighlight.ts` | 1 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/viewParts/decorations/decorations.ts` | 1 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/viewParts/editorScrollbar/editorScrollbar.ts` | 1 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/viewParts/glyphMargin/glyphMargin.ts` | 3 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/viewParts/gpuMark/gpuMark.ts` | 1 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/viewParts/indentGuides/indentGuides.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/viewParts/lineNumbers/lineNumbers.ts` | 1 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/viewParts/linesDecorations/linesDecorations.ts` | 1 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/viewParts/margin/margin.ts` | 1 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `browser/viewParts/marginDecorations/marginDecorations.ts` | 1 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/viewParts/minimap/minimap.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/viewParts/minimap/minimapCharRenderer.ts` | 1 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `browser/viewParts/minimap/minimapCharRendererFactory.ts` | 0 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 未发现直接生产导入，保留并核对装配。 |
| `browser/viewParts/minimap/minimapCharSheet.ts` | 2 / 1 | 人工检查：字符码 128 可返回表外索引；反查仅到未接入生产的字形 renderer/factory，暂未确认可达渲染链，未修改。 |
| `browser/viewParts/minimap/minimapPreBaked.ts` | 1 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `browser/viewParts/overlayWidgets/overlayWidgets.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/viewParts/overviewRuler/decorationsOverviewRuler.ts` | 1 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/viewParts/overviewRuler/overviewRuler.ts` | 1 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/viewParts/rulers/rulers.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/viewParts/rulersGpu/rulersGpu.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/viewParts/scrollDecoration/scrollDecoration.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/viewParts/selections/selections.ts` | 1 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/viewParts/viewCursors/viewCursor.ts` | 2 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `browser/viewParts/viewCursors/viewCursors.ts` | 1 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/viewParts/viewLines/domReadingContext.ts` | 3 / 2 | 人工检查：一次上下文内缓存 DOM 测量和缩放，零 offsetWidth 避免除零。 |
| `browser/viewParts/viewLines/rangeUtil.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/viewParts/viewLines/viewLine.ts` | 10 / 2 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/viewParts/viewLines/viewLineOptions.ts` | 10 / 3 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `browser/viewParts/viewLines/viewLines.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/viewParts/viewLinesGpu/viewLinesGpu.ts` | 2 / 0 | 人工追踪：设备就绪后检查销毁状态；重复 init 的调用约束待核对。 |
| `browser/viewParts/viewZones/viewZones.ts` | 1 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/viewParts/whitespace/whitespace.ts` | 1 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/widget/codeEditor/codeEditorContributions.ts` | 1 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/widget/codeEditor/codeEditorWidget.ts` | 9 / 25 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/widget/codeEditor/embeddedCodeEditorWidget.ts` | 1 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/widget/diffEditor/diffEditorRows.ts` | 2 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/widget/diffEditor/diffEditorWidget.ts` | 3 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/widget/diffEditor/features/overviewRulerFeature.ts` | 1 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/widget/documentOutlineNavigator.ts` | 1 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/widget/multiDiffEditor/multiDiffEditorWidget.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/widget/richTextEditor/htmlDocumentFragment.ts` | 1 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `browser/widget/richTextEditor/richTextEditorWidget.ts` | 5 / 0 | 人工追踪：图片解码后恢复旧选区，版本与选区变化场景待验证。 |
| `common/commands/documentCommands.ts` | 2 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/config/diffEditor.ts` | 1 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/config/editorConfiguration.ts` | 9 / 4 | 人工检查：公开类型、请求参数及依赖方向；此文件不持有运行时资源。 |
| `common/config/editorConfigurationSchema.ts` | 2 / 1 | 静态语法与依赖已扫描；含异步路径；未作逐行行为结论。 |
| `common/config/editorOptions.ts` | 94 / 25 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/config/editorZoom.ts` | 3 / 3 | 人工检查：有限值校验、上下界裁剪及仅变化时发布事件。 |
| `common/config/fontInfo.ts` | 12 / 8 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/config/fontInfoFromSettings.ts` | 3 / 2 | 人工检查：原始字体设置经过各 EditorOption 校验，统一由 BareFontInfo 创建。 |
| `common/coordinatesConverter.ts` | 9 / 6 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/core/2d/dimension.ts` | 15 / 0 | 人工检查：公开类型、请求参数及依赖方向；此文件不持有运行时资源。 |
| `common/core/2d/point.ts` | 2 / 0 | 人工检查：已通读短模块的入口、边界及返回值；未发现本轮可复现缺陷。 |
| `common/core/2d/rect.ts` | 0 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 未发现直接生产导入，保留并核对装配。 |
| `common/core/2d/size.ts` | 1 / 0 | 人工检查：已通读入口、公开数据和同步状态变化；未发现本轮可复现缺陷。 |
| `common/core/characterClassifier.ts` | 2 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/core/cursorColumns.ts` | 12 / 1 | 人工检查：UTF-16、字素与制表位坐标转换；未发现本轮可复现缺陷。 |
| `common/core/documentPosition.ts` | 1 / 1 | 人工检查：文档位置解析、节点坐标与偏移边界；未发现本轮可复现缺陷。 |
| `common/core/documentSelection.ts` | 20 / 6 | 人工检查：文本/节点/全选描述与位置比较；运行时未知 kind 的拒绝位置待追踪。 |
| `common/core/editOperation.ts` | 10 / 0 | 人工检查：已通读入口、公开数据和同步状态变化；未发现本轮可复现缺陷。 |
| `common/core/misc/eolCounter.ts` | 3 / 0 | 人工检查：CR、LF、CRLF 计数和首尾行 UTF-16 长度；空文本返回值一致。 |
| `common/core/misc/indentation.ts` | 6 / 2 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/core/misc/rgba.ts` | 4 / 1 | 人工检查：已通读短模块的入口、边界及返回值；未发现本轮可复现缺陷。 |
| `common/core/misc/textModelDefaults.ts` | 3 / 0 | 人工检查：已通读短模块的入口、边界及返回值；未发现本轮可复现缺陷。 |
| `common/core/position.ts` | 171 / 137 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/core/range.ts` | 181 / 116 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/core/ranges/columnRange.ts` | 1 / 0 | 人工检查：已通读短模块的入口、边界及返回值；未发现本轮可复现缺陷。 |
| `common/core/ranges/lineRange.ts` | 4 / 1 | 人工检查：行范围交并和集合排序；构造输入是否已合并由调用方契约决定。 |
| `common/core/ranges/offsetRange.ts` | 15 / 2 | 人工检查：半开范围；clipCyclic 对负整数周期可能返回 endExclusive，目前没有生产调用，未改动。 |
| `common/core/ranges/rangeMapping.ts` | 0 / 1 | 人工检查：有序映射查找与 TextLength 偏移；目前没有直接生产引用，未改动公开端口。 |
| `common/core/ranges/rangeSingleLine.ts` | 0 / 1 | 人工检查：已通读短模块的入口、边界及返回值；未发现本轮可复现缺陷。 |
| `common/core/selection.ts` | 77 / 69 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/core/stringBuilder.ts` | 3 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/core/textChange.ts` | 50 / 9 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/core/textSegmentation.ts` | 7 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/core/wordCharacterClassifier.ts` | 5 / 2 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/core/wordHelper.ts` | 7 / 1 | 已修复：忽略零长度匹配并按 Unicode 字符推进正则游标，避免词语查询卡死；独立进程复现、g/gu/gv 回归及真实模型浏览器测试通过。 |
| `common/cursor/cursor.ts` | 5 / 13 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/cursor/cursorAtomicMoveOperations.ts` | 1 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/cursor/cursorCollection.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/cursor/cursorColumnSelection.ts` | 1 / 1 | 人工检查：列选择按 UTF-16 列号裁剪；混合 Tab/宽字符时的可视矩形语义需真实交互验证。 |
| `common/cursor/cursorContext.ts` | 3 / 2 | 人工检查：已通读短模块的入口、边界及返回值；未发现本轮可复现缺陷。 |
| `common/cursor/cursorDeleteOperations.ts` | 3 / 5 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/cursor/cursorMoveCommands.ts` | 4 / 3 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/cursor/cursorMoveOperations.ts` | 5 / 3 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/cursor/cursorTypeEditOperations.ts` | 3 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/cursor/cursorTypeOperations.ts` | 3 / 2 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/cursor/cursorWordOperations.ts` | 2 / 3 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/cursor/oneCursor.ts` | 1 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/cursorCommon.ts` | 15 / 17 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/cursorEvents.ts` | 14 / 10 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/diff/diffComputationService.ts` | 6 / 5 | 人工检查：公开类型、请求参数及依赖方向；此文件不持有运行时资源。 |
| `common/diff/diffModel.ts` | 9 / 3 | 人工追踪：两侧版本及请求代次校验；源模型先销毁的异常路径待验证。 |
| `common/diff/lineDiff.ts` | 12 / 5 | 人工检查：公开数据/渲染契约和依赖方向，无独立可释放状态。 |
| `common/editorCommon.ts` | 51 / 9 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/editorContextKeys.ts` | 3 / 0 | 人工检查：已通读短模块的入口、边界及返回值；未发现本轮可复现缺陷。 |
| `common/editorTheme.ts` | 3 / 2 | 人工检查：已通读入口、公开数据和同步状态变化；未发现本轮可复现缺陷。 |
| `common/encodedTokenAttributes.ts` | 19 / 6 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/inputMode.ts` | 3 / 1 | 人工检查：已通读短模块的入口、边界及返回值；未发现本轮可复现缺陷。 |
| `common/languageFeatureRegistry.ts` | 24 / 10 | 人工追踪：注册撤销、独占提供者、排序和候选缓存；缓存未包含模型同步资格，尺寸阈值变化场景待验证。 |
| `common/languageSelector.ts` | 4 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/languages.ts` | 54 / 10 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/languages/autoIndent.ts` | 1 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/languages/completion/languageCompletionCatalogWire.ts` | 2 / 2 | 静态语法与依赖已扫描；含异步路径、含资源/集合操作；未作逐行行为结论。 |
| `common/languages/completion/languageCompletionProviderModuleWire.ts` | 2 / 1 | 人工检查：模块通信协议标识与版本、客户端/服务端参数一致，资源交给共同 wire owner。 |
| `common/languages/completion/languageCompletionProviderModules.ts` | 3 / 2 | 人工检查：提供者模块复用共同 registry/host，协议与目录规范化无独立状态。 |
| `common/languages/completion/languageCompletionProviders.ts` | 20 / 15 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/languages/completion/languageCompletionResolveWire.ts` | 2 / 1 | 静态语法与依赖已扫描；含异步路径、含资源/集合操作；未作逐行行为结论。 |
| `common/languages/completion/languageCompletionService.ts` | 8 / 9 | 静态语法与依赖已扫描；含异步路径、含资源/集合操作；未作逐行行为结论。 |
| `common/languages/completion/languageCompletionWire.ts` | 2 / 3 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/languages/completion/languageCompletions.ts` | 16 / 9 | 结构问题：common 引用 contribution 的 snippetParser。 |
| `common/languages/completion/languageWordCompletionProvider.ts` | 2 / 3 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/languages/defaultDocumentColorsComputer.ts` | 1 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/languages/enterAction.ts` | 1 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/languages/language.ts` | 14 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/languages/languageBracketPairs.ts` | 6 / 5 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/languages/languageBuiltinConfigurations.ts` | 7 / 14 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/languages/languageBuiltinDescriptions.ts` | 2 / 1 | 人工检查：语言关联注册统一释放；内置后缀覆盖是现有产品能力边界。 |
| `common/languages/languageConfiguration.ts` | 19 / 3 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/languages/languageConfigurationRegistry.ts` | 39 / 8 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/languages/languageId.ts` | 9 / 0 | 人工检查：已通读短模块的入口、边界及返回值；未发现本轮可复现缺陷。 |
| `common/languages/languageLexicalConfiguration.ts` | 4 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/languages/languageLexicalContext.ts` | 5 / 7 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/languages/languageLexicalLineScanner.ts` | 5 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/languages/languageLexicalSyntaxCache.ts` | 1 / 4 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/languages/languageLexicalSyntaxProvider.ts` | 3 / 4 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/languages/languageProviderModuleWire.ts` | 2 / 0 | 静态语法与依赖已扫描；含异步路径、含资源/集合操作；未作逐行行为结论。 |
| `common/languages/languageProviderModules.ts` | 5 / 0 | 人工追踪：串行激活、加载后存活与模块身份检查。 |
| `common/languages/languageRegistry.ts` | 6 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/languages/languageRequestCoordinator.ts` | 14 / 14 | 静态语法与依赖已扫描；含异步路径、含资源/集合操作；未作逐行行为结论。 |
| `common/languages/languageResults.ts` | 21 / 14 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/languages/languageWorkerWire.ts` | 17 / 7 | 静态语法与依赖已扫描；含异步路径、含资源/集合操作；未作逐行行为结论。 |
| `common/languages/languageWorkerWireProtocol.ts` | 2 / 2 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/languages/languageWorkspaceEdit.ts` | 17 / 3 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/languages/supports.ts` | 5 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/languages/supports/characterPair.ts` | 2 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/languages/supports/electricCharacter.ts` | 2 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/languages/supports/indentRules.ts` | 3 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/languages/supports/indentationLineProcessor.ts` | 2 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/languages/supports/inplaceReplaceSupport.ts` | 1 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/languages/supports/languageBracketsConfiguration.ts` | 6 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/languages/supports/onEnter.ts` | 1 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/languages/supports/richEditBrackets.ts` | 4 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/languages/syntax/syntaxItemDelta.ts` | 1 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/languages/syntax/syntaxModuleWorkerClient.ts` | 2 / 1 | 静态语法与依赖已扫描；含异步路径、含资源/集合操作；未作逐行行为结论。 |
| `common/languages/syntax/syntaxProviderModuleWire.ts` | 3 / 2 | 人工检查：模块通信协议标识与版本、客户端/服务端参数一致，资源交给共同 wire owner。 |
| `common/languages/syntax/syntaxProviderModules.ts` | 5 / 3 | 人工检查：提供者模块复用共同 registry/host，协议与目录规范化无独立状态。 |
| `common/languages/syntax/syntaxProviders.ts` | 16 / 8 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/languages/syntax/syntaxService.ts` | 15 / 10 | 静态语法与依赖已扫描；含异步路径、含资源/集合操作；未作逐行行为结论。 |
| `common/languages/syntax/syntaxWire.ts` | 3 / 5 | 人工检查：请求 record/string 和语言参数校验；两类 lane 复用确认版本的结果协议。 |
| `common/languages/syntax/syntaxWireResult.ts` | 1 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/languages/workspaceSymbols.ts` | 8 / 3 | 人工追踪：resolve 选择首个提供者；未找到当前生产 resolve 调用，不计为用户可见故障。 |
| `common/model.ts` | 111 / 21 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/model/bracketPairsTextModelPart/bracketPairsImpl.ts` | 1 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/model/bracketPairsTextModelPart/bracketPairsTree/ast.ts` | 7 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/model/bracketPairsTextModelPart/bracketPairsTree/beforeEditPositionMapper.ts` | 3 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/model/bracketPairsTextModelPart/bracketPairsTree/bracketPairsTree.ts` | 1 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/model/bracketPairsTextModelPart/bracketPairsTree/brackets.ts` | 2 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/model/bracketPairsTextModelPart/bracketPairsTree/combineTextEditInfos.ts` | 1 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/model/bracketPairsTextModelPart/bracketPairsTree/concat23Trees.ts` | 1 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/model/bracketPairsTextModelPart/bracketPairsTree/length.ts` | 8 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/model/bracketPairsTextModelPart/bracketPairsTree/nodeReader.ts` | 1 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/model/bracketPairsTextModelPart/bracketPairsTree/parser.ts` | 1 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/model/bracketPairsTextModelPart/bracketPairsTree/smallImmutableSet.ts` | 5 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/model/bracketPairsTextModelPart/bracketPairsTree/tokenizer.ts` | 4 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/model/decorationCollection.ts` | 20 / 11 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/model/document.ts` | 32 / 4 | 人工追踪：不可变节点、结构共享、插入/删除/替换及重复 id 检测；外部树的 schema 验证由调用边界负责。 |
| `common/model/documentDecoration.ts` | 3 / 2 | 人工追踪：装饰 id 唯一性、不可变集合及事务选区映射；未发现本轮可复现缺陷。 |
| `common/model/documentFragment.ts` | 1 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/model/documentHistory.ts` | 3 / 0 | 人工追踪：撤销重做分支、历史合并顺序、容量限制与 rebase；未发现本轮可复现缺陷。 |
| `common/model/documentOutline.ts` | 4 / 1 | 人工追踪：标题栈、层级规范化、标题文字与图片替代文本；未发现本轮可复现缺陷。 |
| `common/model/documentPlugin.ts` | 6 / 2 | 人工检查：插件 key、状态/事务/装饰回调契约与描述符校验；实际执行原子性由 TextModel 持有。 |
| `common/model/documentSchema.ts` | 27 / 10 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/model/documentSerialization.ts` | 11 / 6 | 人工追踪：版本 envelope、节点/marks 解码与 schema 校验；深层递归和特殊属性名边界待验证。 |
| `common/model/documentText.ts` | 2 / 1 | 人工追踪：纯文本换行、同块/跨块选择与图片替代文本；跨容器选择返回 undefined 的能力边界保留。 |
| `common/model/documentTransaction.ts` | 14 / 6 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/model/documentTransactionSerialization.ts` | 3 / 3 | 人工追踪：step/selection 解码和元数据 JSON 编码；对象输入的元数据规范化及特殊键往返待验证。 |
| `common/model/editStack.ts` | 1 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/model/guidesTextModelPart.ts` | 1 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/model/lineDocument.ts` | 4 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/model/lineDocumentProjection.ts` | 2 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/model/pieceTreeTextBuffer/pieceTreeBase.ts` | 2 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/model/pieceTreeTextBuffer/pieceTreeTextBuffer.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/model/pieceTreeTextBuffer/pieceTreeTextBufferBuilder.ts` | 1 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/model/pieceTreeTextBuffer/rbTreeBase.ts` | 2 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/model/textModel.ts` | 106 / 163 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/model/textModelBlockState.ts` | 3 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/model/textModelSearch.ts` | 4 / 2 | 人工追踪：正则空匹配推进、Unicode 代理对、查找数量上限与行内/多行分支；未发现本轮可复现缺陷。 |
| `common/model/tokens/annotations.ts` | 1 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/model/tokens/tokenizationTextModelPart.ts` | 1 / 0 | 静态语法与依赖已扫描；含异步路径、含资源/集合操作；未作逐行行为结论。 |
| `common/modelLineProjectionData.ts` | 8 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/services/completionsEnablement.ts` | 3 / 1 | 人工检查：已通读短模块的入口、边界及返回值；未发现本轮可复现缺陷。 |
| `common/services/documentCollaborationService.ts` | 8 / 3 | 结构问题：common 引用 contribution 的协议契约。 |
| `common/services/editorBaseApi.ts` | 1 / 0 | 人工检查：已通读短模块的入口、边界及返回值；未发现本轮可复现缺陷。 |
| `common/services/editorWebWorkerMain.ts` | 1 / 0 | 人工检查：已通读短模块的入口、边界及返回值；未发现本轮可复现缺陷。 |
| `common/services/editorWorkerProtocol.ts` | 3 / 1 | 人工检查：已通读入口、公开数据和同步状态变化；未发现本轮可复现缺陷。 |
| `common/services/editorWorkerWire.ts` | 2 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/services/findSectionHeaders.ts` | 1 / 1 | 已修复：MARK 表达式的前瞻空匹配显式推进游标，后续有效标题仍能返回；独立进程复现，真实 TextModel 回归通过。 |
| `common/services/languageCompletionWorkerMain.ts` | 1 / 0 | 人工检查：已通读入口、公开数据和同步状态变化；未发现本轮可复现缺陷。 |
| `common/services/languageDiagnosticsService.ts` | 12 / 2 | 人工检查：公开数据/渲染契约和依赖方向，无独立可释放状态。 |
| `common/services/languageFeatures.ts` | 28 / 5 | 结构问题：共享注册表引用 contribution 的语言契约。 |
| `common/services/languageFeaturesService.ts` | 2 / 9 | 结构问题：共享注册表实现引用 contribution 的语言契约。 |
| `common/services/languageService.ts` | 5 / 7 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/services/languageTokenStylingResolver.ts` | 2 / 2 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/services/markerDecorations.ts` | 5 / 0 | 人工检查：公开类型、请求参数及依赖方向；此文件不持有运行时资源。 |
| `common/services/markerDecorationsService.ts` | 2 / 1 | 人工追踪：模型引用计数、抑制范围、重入和销毁清理。 |
| `common/services/model.ts` | 4 / 0 | 人工检查：公开类型、请求参数及依赖方向；此文件不持有运行时资源。 |
| `common/services/modelService.ts` | 1 / 1 | 人工追踪：模型创建/注销、资源唯一性、配置失效、文本/EOL 更新及历史恢复；关闭模型缓存随服务释放的清理待验证。 |
| `common/services/resolvedSemanticTokens.ts` | 10 / 3 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/services/resolvedSemanticTokensService.ts` | 1 / 2 | 人工追踪：缓存失效、语义层合并、服务持有源监听。 |
| `common/services/resolverService.ts` | 1 / 1 | 人工检查：公开数据/服务契约及依赖方向，无独立可释放状态。 |
| `common/services/retainedModelUndoRedoHistory.ts` | 1 / 1 | 人工追踪：按模型数及文本量限制缓存，恢复时消费快照。 |
| `common/services/semanticTokensDto.ts` | 3 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/services/semanticTokensProviderStyling.ts` | 2 / 0 | 人工检查：已通读短模块的入口、边界及返回值；未发现本轮可复现缺陷。 |
| `common/services/semanticTokensStyling.ts` | 2 / 0 | 人工检查：公开类型、请求参数及依赖方向；此文件不持有运行时资源。 |
| `common/services/semanticTokensStylingService.ts` | 1 / 0 | 人工检查：已通读入口、公开数据和同步状态变化；未发现本轮可复现缺陷。 |
| `common/services/syntaxWorkerMain.ts` | 1 / 0 | 人工检查：配置、registry、模块 host、wire server 在 worker scope 中统一释放。 |
| `common/services/textModelResourceService.ts` | 10 / 4 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/services/textModelSync/textModelSync.impl.ts` | 1 / 1 | 人工追踪：版本、范围、换行校验后提交镜像。 |
| `common/services/textModelSync/textModelSync.protocol.ts` | 9 / 0 | 人工检查：公开类型、请求参数及依赖方向；此文件不持有运行时资源。 |
| `common/services/textResourceConfiguration.ts` | 2 / 1 | 人工检查：资源 EOL 服务契约，无独立运行时状态。 |
| `common/services/textResourceStore.ts` | 5 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/services/treeViewsDnd.ts` | 1 / 1 | 人工检查：拖拽 transfer 按 id 存取并消费后删除；拖拽取消未消费的清理路径待验证。 |
| `common/services/treeViewsDndService.ts` | 1 / 1 | 人工检查：已通读短模块的入口、边界及返回值；未发现本轮可复现缺陷。 |
| `common/services/unicodeTextModelHighlighter.ts` | 5 / 0 | 已修复：按物理换行分行，CRLF 不再作为不可见字符报告；真实 worker 回归先失败后通过，并验证下一行字符坐标。 |
| `common/standalone/standaloneEnums.ts` | 1 / 0 | 人工检查：已通读短模块的入口、边界及返回值；未发现本轮可复现缺陷。 |
| `common/textModelBracketPairs.ts` | 4 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/textModelEditSource.ts` | 11 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/textModelEvents.ts` | 16 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/textModelGuides.ts` | 5 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/tokenizationRegistry.ts` | 1 / 1 | 人工追踪：异步工厂替换和销毁后的注册门禁。 |
| `common/tokenizationTextModelPart.ts` | 3 / 1 | 人工检查：公开数据/服务契约及依赖方向，无独立可释放状态。 |
| `common/tokens/common.ts` | 1 / 0 | 人工检查：已通读短模块的入口、边界及返回值；未发现本轮可复现缺陷。 |
| `common/tokens/languageTokenLineIndex.ts` | 2 / 3 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/tokens/languageTokens.ts` | 12 / 3 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/tokens/lineTokens.ts` | 13 / 4 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/tokens/sparseMultilineTokens.ts` | 3 / 2 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/tokens/sparseTokensStore.ts` | 1 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/viewEventHandler.ts` | 13 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/viewEvents.ts` | 42 / 6 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/viewLayout/lineDecorations.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/viewLayout/lineHeights.ts` | 2 / 2 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/viewLayout/linePart.ts` | 1 / 0 | 人工检查：已通读入口、公开数据和同步状态变化；未发现本轮可复现缺陷。 |
| `common/viewLayout/linesLayout.ts` | 1 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/viewLayout/viewLayout.ts` | 3 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/viewLayout/viewLineRenderer.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/viewLayout/viewLinesViewportData.ts` | 14 / 2 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/viewModel.ts` | 31 / 3 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/viewModel/editorViewportContracts.ts` | 12 / 1 | 人工检查：公开数据/服务契约及依赖方向，无独立可释放状态。 |
| `common/viewModel/glyphLanesModel.ts` | 1 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/viewModel/inlineDecorations.ts` | 9 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/viewModel/minimapTokensColorTracker.ts` | 2 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/viewModel/modelLineProjection.ts` | 14 / 4 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/viewModel/monospaceLineBreaksComputer.ts` | 1 / 2 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/viewModel/overviewZoneManager.ts` | 2 / 2 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/viewModel/pointerHitTest.ts` | 1 / 2 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/viewModel/rangeGeometry.ts` | 1 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/viewModel/screenReaderSimpleModel.ts` | 2 / 0 | 人工检查：公开类型、请求参数及依赖方向；此文件不持有运行时资源。 |
| `common/viewModel/textMeasurer.ts` | 11 / 25 | 人工检查：公开类型、请求参数及依赖方向；此文件不持有运行时资源。 |
| `common/viewModel/viewContext.ts` | 45 / 7 | 人工检查：复用 viewModel 的布局/事件 owner，不另建缓存；主题更新由 EditorTheme 承接。 |
| `common/viewModel/viewModelDecoration.ts` | 5 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/viewModel/viewModelDecorations.ts` | 1 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/viewModel/viewModelImpl.ts` | 1 / 2 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/viewModel/viewModelLines.ts` | 2 / 2 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/viewModel/visualCursorNavigation.ts` | 1 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/viewModel/visualRangeGeometry.ts` | 1 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/viewModel/visualSelectionGeometry.ts` | 2 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/viewModelEventDispatcher.ts` | 4 / 10 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/academic/browser/nodeViews.ts` | 1 / 1 | 人工检查：已通读短模块的入口、边界及返回值；未发现本轮可复现缺陷。 |
| `contrib/academic/common/schema.ts` | 2 / 3 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `contrib/anchorSelect/browser/anchorSelect.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/bracketMatching/browser/bracketColorizationPresentation.ts` | 1 / 1 | 人工检查：已通读入口、公开数据和同步状态变化；未发现本轮可复现缺陷。 |
| `contrib/bracketMatching/browser/bracketMatching.contribution.ts` | 1 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `contrib/bracketMatching/browser/bracketMatching.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/bracketMatching/common/bracketEditing.ts` | 1 / 1 | 已修复：未命中括号的选区返回空命令，复用执行器跟踪选区；正反向选区、快捷键/正式 action 和撤销回归通过。 |
| `contrib/bracketMatching/common/bracketNavigation.ts` | 1 / 1 | 人工检查：多光标括号匹配、跳转/选择与无变化时复用选区。 |
| `contrib/callHierarchy/browser/languageHierarchy.contribution.ts` | 1 / 0 | 人工检查：贡献注册入口、安装条件与服务/控制器归属；功能实现结论见对应文件。 |
| `contrib/callHierarchy/browser/languageHierarchyController.ts` | 1 / 0 | 人工追踪：关闭 Peek 后 expand 返回仍访问旧 DOM，待场景验证。 |
| `contrib/callHierarchy/common/languageHierarchy.ts` | 7 / 1 | 已复现并修复：后续查询绑定准备阶段的版本及语言。 |
| `contrib/caretOperations/browser/transpose.ts` | 1 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `contrib/citation/browser/nodeViews.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/citation/browser/toolbarAction.ts` | 1 / 1 | 人工检查：已通读入口、公开数据和同步状态变化；未发现本轮可复现缺陷。 |
| `contrib/citation/common/citationCommands.ts` | 1 / 1 | 人工检查：schema 能力检查、引用节点创建和书目插入点；空标签保留有效段落。 |
| `contrib/citation/common/references.ts` | 2 / 2 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/citation/common/schema.ts` | 3 / 0 | 人工检查：已通读入口、公开数据和同步状态变化；未发现本轮可复现缺陷。 |
| `contrib/clipboard/browser/clipboard.ts` | 1 / 2 | 静态语法与依赖已扫描；含异步路径、含资源/集合操作；未作逐行行为结论。 |
| `contrib/codeAction/browser/codeActionContributions.ts` | 1 / 0 | 人工检查：贡献注册入口、安装条件与服务/控制器归属；功能实现结论见对应文件。 |
| `contrib/codeAction/browser/codeActionController.ts` | 1 / 1 | 已复现并修复：销毁时取消请求。 |
| `contrib/codelens/browser/codeLensCache.ts` | 2 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/codelens/browser/codelens.ts` | 3 / 1 | 静态语法与依赖已扫描；含异步路径、含资源/集合操作；未作逐行行为结论。 |
| `contrib/codelens/browser/codelensController.ts` | 1 / 1 | 静态语法与依赖已扫描；含异步路径、含资源/集合操作；未作逐行行为结论。 |
| `contrib/codelens/browser/codelensWidget.ts` | 1 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/collaboration/browser/collaborationContribution.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/collaboration/common/controller.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/collaboration/common/envelopeSerialization.ts` | 0 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 未发现直接生产导入，保留并核对装配。 |
| `contrib/collaboration/common/protocol.ts` | 6 / 3 | 人工检查：有序协作 envelope 契约；被 common 服务反向引用的归属问题保留。 |
| `contrib/collaboration/common/rebase.ts` | 2 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/collaboration/common/synchronizer.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/colorPicker/browser/colorDetector.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/colorPicker/browser/colorPickerController.ts` | 1 / 1 | 静态语法与依赖已扫描；含异步路径、含资源/集合操作；未作逐行行为结论。 |
| `contrib/colorPicker/browser/colorPickerModel.ts` | 2 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/colorPicker/browser/editorColorPickerDialog.ts` | 1 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/comment/browser/blockCommentCommand.ts` | 2 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `contrib/comment/browser/comment.ts` | 1 / 2 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `contrib/comment/browser/lineCommentCommand.ts` | 1 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `contrib/contextmenu/browser/contextmenu.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/cursorUndo/browser/cursorUndo.ts` | 1 / 2 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/diffEditorBreadcrumbs/browser/diffEditorBreadcrumbs.ts` | 1 / 0 | 人工检查：根节点移除、模型监听释放、节点自有 click 监听；大量变更逐行生成按钮的成本待测。 |
| `contrib/documentEditor.contribution.ts` | 1 / 1 | 人工检查：仅 document 模式安装格式与协作贡献，句柄交给 context 的 setter owner。 |
| `contrib/dropOrPasteInto/browser/copyPasteContribution.ts` | 1 / 1 | 人工检查：贡献注册入口、安装条件与服务/控制器归属；功能实现结论见对应文件。 |
| `contrib/dropOrPasteInto/browser/copyPasteController.ts` | 1 / 2 | 静态语法与依赖已扫描；含异步路径、含资源/集合操作；未作逐行行为结论。 |
| `contrib/dropOrPasteInto/browser/dropIntoEditorContribution.ts` | 1 / 1 | 人工检查：贡献注册入口、安装条件与服务/控制器归属；功能实现结论见对应文件。 |
| `contrib/dropOrPasteInto/browser/dropIntoEditorController.ts` | 1 / 0 | 静态语法与依赖已扫描；含异步路径、含资源/集合操作；未作逐行行为结论。 |
| `contrib/dropOrPasteInto/browser/textFileTransfer.ts` | 2 / 2 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `contrib/editorState/browser/editorState.ts` | 4 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/editorState/browser/editorStateController.ts` | 1 / 0 | 人工检查：焦点/选区/滚动监听均注册释放；创建时已有焦点与滚动状态的同步待验证。 |
| `contrib/editorState/browser/keybindingCancellation.ts` | 1 / 1 | 人工检查：WeakMap 请求栈、Escape 仅取消最新请求及编辑器销毁取消；父 token 已取消时的同步清理需专门回归。 |
| `contrib/editorState/common/editorInteractionState.ts` | 1 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/find/browser/findController.ts` | 1 / 4 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/find/common/textSearchCommands.ts` | 1 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `contrib/folding/browser/folding.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/folding/browser/foldingDecorations.ts` | 1 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `contrib/folding/browser/foldingModel.ts` | 5 / 3 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/folding/browser/foldingRanges.ts` | 4 / 4 | 已复现并修复：祖先范围交叉校验。 |
| `contrib/folding/browser/hiddenRangeModel.ts` | 1 / 2 | 人工检查：合并已排序折叠区间，折叠/正文事件监听释放；消费本轮折叠交叉校验修复。 |
| `contrib/folding/browser/indentRangeProvider.ts` | 1 / 2 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `contrib/folding/browser/syntaxRangeProvider.ts` | 1 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `contrib/fontZoom/browser/fontZoom.ts` | 1 / 1 | 人工检查：三个正式命令委托 EditorZoom，增减和复位共享同一状态。 |
| `contrib/format/browser/format.ts` | 3 / 4 | 静态语法与依赖已扫描；含异步路径、含资源/集合操作；未作逐行行为结论。 |
| `contrib/format/browser/formatActions.ts` | 1 / 1 | 静态语法与依赖已扫描；含异步路径；未作逐行行为结论。 |
| `contrib/format/browser/formattingEdit.ts` | 1 / 0 | 人工检查：只读/空编辑拒绝、末次 EOL、撤销边界和滚动恢复；消费本轮格式化回归。 |
| `contrib/formatting/browser/formattingContribution.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/gotoError/browser/gotoError.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/gotoError/common/diagnosticDecorations.ts` | 1 / 3 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/gotoSymbol/browser/gotoSymbol.contribution.ts` | 1 / 0 | 人工检查：贡献注册入口、安装条件与服务/控制器归属；功能实现结论见对应文件。 |
| `contrib/gotoSymbol/browser/gotoSymbolController.ts` | 1 / 0 | 人工追踪：取消请求后渲染门禁、列表监听清理。 |
| `contrib/gotoSymbol/browser/languageNavigation.contribution.ts` | 1 / 0 | 人工检查：贡献安装条件与服务/控制器装配；具体生命周期见对应实现。 |
| `contrib/gotoSymbol/browser/languageNavigationController.ts` | 1 / 0 | 静态语法与依赖已扫描；含异步路径、含资源/集合操作；未作逐行行为结论。 |
| `contrib/gotoSymbol/common/languageDocumentSymbolSearch.ts` | 2 / 0 | 人工检查：持有并释放文档符号服务，符号展开和名称排序；异步时效由提供者服务及 controller 负责。 |
| `contrib/hover/browser/diagnosticHoverController.ts` | 0 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 未发现直接生产导入，保留并核对装配。 |
| `contrib/hover/browser/hoverContribution.ts` | 1 / 0 | 人工检查：贡献注册入口、安装条件与服务/控制器归属；功能实现结论见对应文件。 |
| `contrib/hover/browser/hoverController.ts` | 1 / 0 | 人工追踪：延时、请求和 DOM 同步释放。 |
| `contrib/inPlaceReplace/browser/inPlaceReplace.ts` | 1 / 1 | 人工追踪：worker 结果和选区复核；模型/功能卸载交错待验证。 |
| `contrib/indentation/browser/indentation.ts` | 1 / 1 | 人工追踪：转换命令遍历正文缩进、生成 edits 并恢复 tracked selection；混合缩进回归通过。 |
| `contrib/indentation/common/indentUtils.ts` | 2 / 1 | 已修复：Tab 推进至下一制表位，混合缩进转换保持文字对齐；真实缩进命令与选区回归先失败后通过。 |
| `contrib/indentation/common/indentation.ts` | 1 / 1 | 人工追踪：重缩进规则、首行列宽与输出 edit 的调用链；消费同批 Tab 列宽修复。 |
| `contrib/inlayHints/browser/inlayHintsController.ts` | 1 / 0 | 人工追踪：dispose 取消请求但不清理已绘制提示，待功能卸载验证。 |
| `contrib/inlineCompletions/browser/controller/inlineCompletionsController.ts` | 1 / 1 | 静态语法与依赖已扫描；含异步路径、含资源/集合操作；未作逐行行为结论。 |
| `contrib/inlineCompletions/common/inlineCompletions.ts` | 6 / 1 | 人工检查：公开类型、请求参数及依赖方向；此文件不持有运行时资源。 |
| `contrib/inlineProgress/browser/inlineProgress.ts` | 2 / 1 | 静态语法与依赖已扫描；含异步路径、含资源/集合操作；未作逐行行为结论。 |
| `contrib/languageAnalysis/browser/languageAnalysis.contribution.ts` | 1 / 0 | 人工检查：贡献注册入口、安装条件与服务/控制器归属；功能实现结论见对应文件。 |
| `contrib/lineSelection/browser/lineSelection.ts` | 1 / 1 | 人工检查：已通读入口、公开数据和同步状态变化；未发现本轮可复现缺陷。 |
| `contrib/linesOperations/browser/copyLinesCommand.ts` | 1 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `contrib/linesOperations/browser/linesOperations.ts` | 1 / 7 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/linesOperations/browser/moveLinesCommand.ts` | 1 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `contrib/linesOperations/browser/sortLinesCommand.ts` | 1 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `contrib/linkedEditing/browser/linkedEditing.ts` | 1 / 1 | 静态语法与依赖已扫描；含异步路径、含资源/集合操作；未作逐行行为结论。 |
| `contrib/links/browser/linksController.ts` | 1 / 0 | 人工追踪：dispose 未调用 clear，待卸载时的请求及 class 清理验证。 |
| `contrib/message/browser/messageController.ts` | 2 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/middleScroll/browser/middleScroll.contribution.ts` | 1 / 1 | 人工检查：贡献注册入口、安装条件与服务/控制器归属；功能实现结论见对应文件。 |
| `contrib/middleScroll/browser/middleScrollController.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/multicursor/browser/multicursor.ts` | 1 / 2 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/multicursor/common/occurrenceSelection.ts` | 1 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `contrib/parameterHints/browser/parameterHintsController.ts` | 1 / 0 | 已复现并修复：功能卸载取消请求并阻止后续微任务。 |
| `contrib/peekView/browser/editorPeekViewWidget.ts` | 3 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `contrib/placeholderText/browser/placeholderText.contribution.ts` | 2 / 1 | 人工检查：贡献注册入口、安装条件与服务/控制器归属；功能实现结论见对应文件。 |
| `contrib/placeholderText/browser/placeholderTextContribution.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/quickAccess/browser/quickAccessController.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/quickAccess/common/gotoLocation.ts` | 1 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `contrib/readOnlyMessage/browser/contribution.ts` | 1 / 1 | 人工检查：贡献安装条件与服务/控制器装配；具体生命周期见对应实现。 |
| `contrib/rename/browser/renameController.ts` | 1 / 1 | 已复现并修复：销毁时取消请求；重复提交的取消顺序待验证。 |
| `contrib/sectionHeaders/browser/sectionHeaders.contribution.ts` | 1 / 0 | 人工检查：贡献注册入口、安装条件与服务/控制器归属；功能实现结论见对应文件。 |
| `contrib/sectionHeaders/browser/sectionHeadersController.ts` | 1 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/smartSelect/browser/smartSelectController.ts` | 1 / 0 | 人工追踪：展开前版本/选区复核；异常返回路径仍待验证。 |
| `contrib/smartSelect/common/smartSelectionExpansion.ts` | 1 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `contrib/snippet/browser/snippetSession.ts` | 1 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/snippet/common/snippetParser.ts` | 4 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/snippet/common/snippetTransform.ts` | 2 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `contrib/stickyScroll/browser/stickyScrollContribution.ts` | 1 / 0 | 人工检查：贡献注册入口、安装条件与服务/控制器归属；功能实现结论见对应文件。 |
| `contrib/stickyScroll/browser/stickyScrollController.ts` | 1 / 0 | 人工检查：DOM 与订阅由 controller 清理，字面文字写入 textContent；每次布局重建按钮的焦点保留待验证。 |
| `contrib/stickyScroll/common/stickyScrollModel.ts` | 1 / 1 | 人工检查：祖先区域筛选、排序和数量裁剪；maxEntries 范围校验由配置入口负责。 |
| `contrib/suggest/browser/suggestController.ts` | 2 / 3 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/suggest/browser/suggestModel.ts` | 3 / 4 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/suggest/browser/suggestWidget.ts` | 1 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/symbolIcons/browser/symbolIcons.contribution.ts` | 1 / 0 | 人工检查：贡献注册入口、安装条件与服务/控制器归属；功能实现结论见对应文件。 |
| `contrib/symbolIcons/browser/symbolIcons.ts` | 1 / 0 | 静态语法与依赖已扫描；含异步路径、含资源/集合操作；未作逐行行为结论。 |
| `contrib/textEditorCapabilities.ts` | 7 / 0 | 人工检查：已通读短模块的入口、边界及返回值；未发现本轮可复现缺陷。 |
| `contrib/toggleTabFocusMode/browser/toggleTabFocusMode.ts` | 1 / 0 | 人工检查：正式 action/keybinding 切换 TabFocus 并发布无障碍提示。 |
| `contrib/tokenization/browser/tokenization.contribution.ts` | 1 / 0 | 人工检查：贡献注册入口、安装条件与服务/控制器归属；功能实现结论见对应文件。 |
| `contrib/unicodeHighlighter/browser/unicodeHighlighter.contribution.ts` | 1 / 1 | 人工检查：贡献注册入口、安装条件与服务/控制器归属；功能实现结论见对应文件。 |
| `contrib/unicodeHighlighter/browser/unicodeHighlighterController.ts` | 1 / 0 | 静态语法与依赖已扫描；含异步路径、含资源/集合操作；未作逐行行为结论。 |
| `contrib/unicodeHighlighter/common/unicodeHighlights.ts` | 2 / 1 | 人工检查：已通读短模块的入口、边界及返回值；未发现本轮可复现缺陷。 |
| `contrib/unusualLineTerminators/browser/unusualLineTerminators.contribution.ts` | 1 / 0 | 人工检查：贡献注册入口、安装条件与服务/控制器归属；功能实现结论见对应文件。 |
| `contrib/unusualLineTerminators/browser/unusualLineTerminatorsController.ts` | 1 / 0 | 人工检查：依模型版本更新装饰，监听由 controller 释放，装饰集合归贡献 scope。 |
| `contrib/unusualLineTerminators/common/unusualLineTerminatorRanges.ts` | 1 / 0 | 人工检查：已通读短模块的入口、边界及返回值；未发现本轮可复现缺陷。 |
| `contrib/wordHighlighter/browser/highlightDecorations.ts` | 1 / 0 | 人工检查：已通读短模块的入口、边界及返回值；未发现本轮可复现缺陷。 |
| `contrib/wordHighlighter/browser/textualHighlightProvider.ts` | 1 / 2 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/wordHighlighter/browser/wordHighlighter.contribution.ts` | 1 / 1 | 静态语法与依赖已扫描；含异步路径、含资源/集合操作；未作逐行行为结论。 |
| `contrib/wordWrap/browser/wordWrapController.ts` | 1 / 1 | 人工检查：已通读入口、公开数据和同步状态变化；未发现本轮可复现缺陷。 |
| `contrib/zoneWidget/browser/zoneWidget.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `editor.academic.all.ts` | 1 / 1 | 人工检查：已通读短模块的入口、边界及返回值；未发现本轮可复现缺陷。 |
| `editor.all.ts` | 2 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `editor.api.ts` | 1 / 2 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `editor.code.all.ts` | 1 / 4 | 人工检查：已通读短模块的入口、边界及返回值；未发现本轮可复现缺陷。 |
| `editor.main.ts` | 0 / 3 | 公开构建入口，已核对 editor.main 与 standalone 使用。 |
| `editor.worker.start.ts` | 4 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `standalone/browser/namedEditorThemeService.ts` | 1 / 1 | 人工追踪：强制颜色监听配对释放，主题切换复用已有 owner。 |
| `standalone/browser/standaloneCodeEditor.ts` | 2 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `standalone/browser/standaloneEditor.ts` | 1 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `standalone/browser/standaloneLanguages.ts` | 1 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `standalone/browser/standaloneServices.ts` | 3 / 2 | 人工追踪：服务装配、覆盖及作用域释放。 |
| `standalone/common/namedEditorTheme.ts` | 4 / 0 | 人工检查：公开类型、请求参数及依赖方向；此文件不持有运行时资源。 |

</details>

## 当前结论

- 本轮验证：295 项 Playwright 浏览器测试通过；包含正则修复的 238/238 个 Editor 及相关 Workbench 单测文件通过，随后新增的缩进与 CRLF 回归连同所属两份测试文件共 19 项通过。三份 Editor 架构测试已在本轮执行并通过；最终 Stanza 和 Renderer 正常构建通过，未新增构建 warning。浏览器验证包含功能销毁取消、排队任务销毁和空匹配词语查询。保留既有 CSS 债务及测试环境 Canvas/颜色提示。全量静态检查已完成，逐文件人工行为审查仍未覆盖全部 490 个文件，不能把本次结果表述为全部 Editor 问题已经修完。

- 复制、剪切、粘贴成批统一命令目标选择：正文聚焦时操作正文，其他文本输入框聚焦时交给 DOM 命令，从外部按钮调用时恢复最近使用的编辑器焦点。只读正文允许复制，阻止剪切与粘贴。新增 50 项浏览器用例，覆盖三个命令的目标、服务读写、DOM 分发、撤销，以及外部发起的异步请求在选区、焦点、只读、组合输入、Escape、模型切换和销毁后取消；整组 82 项定向回归通过。

- 公共全选命令区分正文、普通文本输入框和活动编辑器：从外部按钮调用时选中最近使用的编辑器全文，查找框聚焦时只选中输入框文本，只读状态允许选择。两种输入模式均先复现外部调用与查找框全选无效，再从命令注册表入口验证正文选区、另一编辑器选区和输入框选区。

- 公共撤销与重做命令在 `coreCommands.ts` 绑定现有模型历史，`default:undo`、`default:redo` 共用相同实现。命令遵守实时只读状态；从外部按钮调用时作用于最近使用的编辑器，焦点位于查找等文本输入框时不修改正文。两种输入模式均先复现公共撤销无效，再通过注册表入口验证正式命令与别名、撤销与重做、只读切换和多编辑器目标。

- 查找与替换输入框的公共撤销、重做交给浏览器编辑历史处理，正文只读状态不阻止输入框自己的编辑。8 项新增浏览器回归通过真实键盘输入建立历史，以键盘撤销结果校验正式命令和别名；浏览器如何合并连续输入不由编辑器另建记录或假定。

- 公共 API 不再在模块求值时注册格式化选择策略；默认策略由 `StandaloneServiceCollection` 创建并持有，服务释放时注销，恢复宿主先前的策略。架构测试先暴露了入口职责混合，服务生命周期回归覆盖创建前后和释放后的选择结果。

- 编辑器焦点与命令目标按整条链路修正：`CodeEditorWidget` 在稳定根节点跟踪整体焦点，输入适配器只报告文本焦点；查找与替换输入之间移动不会发出整体失焦。上下文键与 `ObservableCodeEditor` 消费同一组公共事件。浏览器编辑器服务按最近使用顺序选择活动编辑器，新建未聚焦实例不抢占命令目标，移除后恢复此前使用的实例并释放焦点监听。浏览器回归已先复现从外部按钮执行复制行却修改另一个编辑器的问题。

- 文件拖放的异步提交改由编辑器状态取消机制守护。等待文件解码期间变为只读、文本变化、换模型、销毁或启动新拖放，旧请求均失效；切回可写不会恢复旧请求。进度提示与同一请求一起结束，正常文件拖放仍作为一个可撤销编辑提交。Widget 回归先复现了只读及切回可写后的过期结果问题。

- 修复多光标与 Linked Editing 的快捷键冲突：Linked Editing 使用 Ctrl/Cmd+Shift+F2，不再在捕获阶段吞掉 Ctrl/Cmd+Shift+L。浏览器测试覆盖键盘与 Action 混用、选区变化、同时输入和撤销；Linked Editing 测试覆盖 Escape 退出、F2 重新激活及不拦截匹配选择快捷键。

- 多光标输入按整条行为链收敛：上/下添加光标、选中行末添加光标、下一个匹配和全部匹配共用 `multicursor.ts` 的五个 Action。键盘入口直接运行相同 Action，两个仅转发事件的 Controller 退出；光标状态仍由现有 ViewModel 管理，选区高亮保留独立生命周期。匹配辅助操作改用 `ITextModel.findMatches/getOffsetAt/getValueInRange`，不再依赖具体模型实现。未实现的查找会话联动与其他多光标命令不计为完成。

- 诊断导航与多光标注册分别回收到 `gotoError.ts`、`multicursor.ts`，两个独立注册文件退出。诊断装饰、多光标输入和选区高亮继续由原对象承担，注册顺序不变。Suggest 注册现已回收到 `suggestController.ts`，旧注册文件退出；聊天输入框使用已有的 `suggestions: false` 关闭普通补全的自动装配，继续由聊天宿主创建专用控制器。回归测试先复现了聊天框出现两个补全组件，再验证修复后只有一个；此项不代表 Suggest 的全部上游契约已对齐。

- 批量迁移 Code Action、Hover、Sticky Scroll 的注册入口至上游对应路径 `codeActionContributions.ts`、`hoverContribution.ts`、`stickyScrollContribution.ts`。旧路径退出，bundle 保持原来的注册顺序与创建条件；控制器行为和生命周期未改。此项仅完成注册文件落位，不代表三个功能的全部公开 API 已对齐。Middle Scroll 与 Placeholder 的 `.contribution.ts` 是双方已有入口，继续保留。

- 格式化职责回收：按用户指定删除 `contrib/format/browser/formatController.ts`。请求编排、交叠处理和取消归回 `format.ts`；命令、现有键盘入口与保存钩子归回 `formatActions.ts`；`formattingEdit.ts` 继续提交编辑。贡献只注册触发入口，不再返回控制器。Widget 将原本拥有的 `IVersionedEditorWorkerClient` 注册到模型作用域，Action 通过容器取得同一实例，模型解绑时仍由 Widget 释放。`formatEditor` 是当前模型绑定的调用入口，不冒充完整上游调度 API；资源级 worker 缺口仍保留。

- 职责回收验证：旧控制器的 TypeScript 引用清零；62 项定向单测、119 项浏览器回归、Editor 对齐与类型检查、Stanza 和 Renderer 构建通过。覆盖保存模式、当前模型格式化选项、worker 实例复用与解绑释放、无模型命令、快捷键、重复请求取消、语言与模型切换、交叠处理和撤销。保留既有 JSDOM Canvas、颜色环境提示及未触及 CSS 债务。

- 格式化回归修复：先用浏览器测试确认，在选择提供者期间或取得编辑结果前改变模型语言，旧请求仍会写回文本。`FormatController` 现监听模型语言变化，复用现有取消流程；监听随请求释放。该修复不改变公开 API、提供者选择规则或文件归属，也不表示资源级 worker 和格式化器选择界面已经完成。

- 本次验证：新增两项浏览器用例修复前均失败，修复后 119 项浏览器测试通过；Editor 对齐与类型检查、Stanza 和 Renderer 构建通过。仅修改一行实现、两份测试文件及本记录，保留既有颜色环境提示和未触及的 CSS 债务。

- 2026-09-15 格式化提供者选择契约：在同路径 `format.ts` 补齐 `FormattingKind`、`FormattingMode`、`IFormattingEditProviderSelector` 和 `FormattingConflicts` 的公开契约。后注册的选择策略优先，释放后恢复旧策略；拒绝选择不继续调用旧策略。整文与选区控制器在同一取消范围内先选择再执行，保存格式化传递 `Silent`，手动命令传递 `Explicit`。选中提供者返回空结果或失败时，不再改用另一个提供者。

- 本批修改 10 个文件：选择契约、控制器、Standalone API 注册、Workbench 生命周期注册、四份行为测试和两份现有文档。Standalone 和 Workbench 当前策略均选择排序首位；默认格式化器配置和选择界面仍待补齐，不能据此宣称冲突处理产品功能完成。原签名不完整的 `getDocumentFormattingEditsUntilResult` 在生产调用退出后删除，其标准查询能力仍待资源级 worker 就绪后按真实调用需求实现。其余完整调度函数和 `formatOnType` 自动触发仍待处理，80/41 声明计数不变。

- 选择契约批次验证：57 项定向单测、117 项浏览器测试、Editor 对齐与类型检查、Stanza 和 Renderer 构建通过。覆盖策略优先级与释放、拒绝选择、指定第二个提供者、空结果不换提供者、异常报告、选择期间取消、手动与保存模式传递，以及既有多选区合并和撤销。保留既有 JSDOM Canvas、颜色环境提示及 7 份未触及 CSS 债务，生产构建无新增警告。

- 2026-09-15 选区格式化交叠结果：在现有 `FormatController` 内补齐逐范围结果的冲突合并。已完成的结果与新结果交叠时，合并它们对应的请求范围并重新查询，丢弃被替换的文本和 EOL 指令；每次合并减少一个分组，查询完成前不修改模型。批量提供者仍一次调用；单次响应自身包含非法交叠编辑时，worker 继续拒绝，不把该错误解释成可合并的多个请求。次选区变化也取消合并查询，即使提供者忽略令牌，命令仍结束等待。

- 本批没有新增公开 API 或服务；资源级 worker、格式化调度函数完整签名和提供者冲突选择仍待完成，80/41 声明计数不变。修改限定在现有控制器、六份行为测试及三份职责文档，共 10 个文件。

- 交叠结果批次验证：71 项定向单测、111 项浏览器测试、Editor 对齐与类型检查、Stanza 和 Renderer 构建通过。覆盖连续合并、旧文本与 EOL 丢弃、一次撤销、次选区取消、提供者忽略令牌、worker 非法结果拒绝和后续请求恢复；保留既有 JSDOM Canvas、颜色环境提示及 7 份未触及 CSS 债务，生产构建无新增警告。

- 2026-09-15 选区格式化入口：本批修改 10 个已有文件。`formatActions.ts` 注册 `editor.action.formatSelection` 与 Ctrl/Cmd+K、Ctrl/Cmd+F；`FormatController` 复用现有取消、worker 和编辑提交流程，使用最高优先级范围提供者，空选区按当前行处理，多选区支持批量接口与逐范围查询。选区起点变化也取消请求，所有结果一次提交并可一次撤销。`editorContextKeys.ts` 的两种格式化可用状态由 `CodeEditorWidget` 按提供者注册、注销和模型语言更新。本批没有新建服务或修改 worker 消息协议；现有 worker 实例只绑定一个模型，不能将协议没有资源字段视为当前已存在的跨模型混用缺陷。

- 本批验证：68 项定向单测、109 项浏览器测试、Editor 对齐与类型检查、Stanza 和 Renderer 生产构建、diff 检查通过。覆盖范围批量与逐条调用、空选区按行处理、只读、选区起点变化取消、一次撤销及提供者状态更新。单测仍有既有 JSDOM Canvas 提示，浏览器仍有颜色环境提示；保留未触及的 7 份 CSS 债务，生产构建无新增警告。

- 对齐边界：本批完成命令 ID、快捷键、可用状态与范围提供者调用链；尚未实现提供者冲突选择、返回编辑交叠后的合并重新查询，也未补齐资源级 `IEditorWorkerService` 与格式化调度函数的完整签名。`formatOnType` 自动触发仍待处理，80/41 声明计数不变。

- 2026-09-15 格式化查询与 worker 职责：三类 provider 补齐 `extensionId`，扩展桥接传递运行时扩展身份。新增上游同路径 `ExtensionIdentifier` 和同签名 `getRealAndSyntheticDocumentFormattersOrdered`，按整文优先、范围补充、扩展 ID 忽略大小写去重的规则查询提供者；范围提供者接收完整模型范围。提供者异常报告后继续查询，取消仍结束等待。worker 的消息编码与最小编辑计算保留最后一个 EOL 指令，控制器移除重复补回逻辑。`getDocumentFormattingEditsUntilResult` 返回值已改为 `TextEdit[] | undefined`，但参数仍缺 `IEditorWorkerService`，最小化仍由控制器调用模型绑定 client；该函数不能标为完整对齐。Ash 尚无完整资源级 worker-service 契约与实现，禁止创建同名子集服务掩盖此缺口。整体 80/41 声明计数不变。

- 格式化查询批次验证：23 项定向单测、104 项浏览器回归、对齐与类型检查、Stanza 和桌面 Renderer 构建通过。覆盖扩展去重、提供者失败后继续查询、范围提供者执行整文格式化与撤销、worker 消息往返、纯换行符和混合文本/EOL 编辑。保留既有 7 份 CSS 债务与终端颜色环境提示，构建无新增警告。

- 2026-09-15 输入格式化 provider 契约：新增 `OnTypeFormattingEditProvider`，参数为模型、位置、触发字符、选项和取消令牌，提供者必须声明 `autoFormatTriggerCharacters`。旧 `LanguageFormattingProvider/Request` 退出，三类格式化 registry 与批量注册统一使用独立公共契约；Standalone 测试覆盖触发字符、参数和注册释放。扩展协议未提供触发字符，移除扩展桥接中不完整的输入格式化注册，保留文档与范围格式化。此批未接通 `formatOnType` 自动触发链，选区格式化命令与完整上游调度仍待处理；80/41 声明计数不变。

- 输入格式化契约批次验证：31 项定向单测、103 项浏览器回归、对齐检查、类型检查、Stanza 和桌面 Renderer 构建通过。批量注册的可调用方法检查调整后，31 项定向单测再次通过。保留既有 7 份 CSS 债务和终端颜色环境提示，构建无新增警告。

- 2026-09-15 范围格式化 provider 契约：`DocumentRangeFormattingEditProvider` 归 `common/languages.ts`，registry、Standalone、App Server 和扩展桥接统一使用 `ITextModel + Range + FormattingOptions + CancellationToken`。旧 `provideRangeFormattingEdits` 及范围格式化的独立请求包装退出；App Server 从模型创建快照并拒绝模型变化后的迟到结果。移除 App Server 没有实现却注册的输入格式化 provider，批量注册测试覆盖范围专用 provider 的替换与释放。输入格式化仍保留原有契约，选区格式化命令和完整上游调度语义未在本批实现，80/41 声明计数不变。

- 范围格式化批次验证：26 项定向单测、103 项浏览器回归、对齐与类型检查、Stanza 和桌面 Renderer 构建通过。覆盖范围及选项传递、请求快照、取消、迟到结果和 provider 注册/替换/释放；未新增选区格式化 UI。保留既有 7 份 CSS 债务与颜色环境提示，构建无新增警告。

- 2026-09-15 文档格式化 provider 契约：新增 `common/languages.ts` 的 `DocumentFormattingEditProvider`，文档格式化 registry、Standalone、JSON、App Server 和扩展桥接统一使用 `ITextModel + FormattingOptions + CancellationToken`，结果接受标准 `ProviderResult<TextEdit[]>`。文档格式化不再使用 `LanguageFormattingRequest` 或独立传入的资源/语言 ID，适配器从模型创建传输快照；控制器直接传递当前请求令牌。范围与输入格式化仍使用原有契约，`LanguageFormattingProvider` 已移除文档格式化方法。26 项定向单测、103 项浏览器回归、对齐与类型检查、Stanza 和桌面 Renderer 构建通过；新增覆盖空结果、扩展请求取消及监听释放。完整上游调度签名、范围/输入格式化接口及其他贡献依赖仍待处理，80/41 声明计数不变；保留既有 7 份 CSS 债务与颜色环境提示，构建无新增警告。

- 2026-09-15 格式化职责迁移：公共 `LanguageFormattingOptions/Request/Provider` 迁入 `common/languages.ts`，registry、Standalone、公开导出和 JSON/App Server/扩展适配器同步改用公共 owner。删除 `contrib/format/common/formatCommands.ts` 和 `FormatService`；文档格式化调度由 `contrib/format/browser/format.ts` 的函数承担，取消与结果提交仍由 `FormatController` 负责。原 common 测试迁至 `test/browser/format.test.ts`，宿主测试直接验证提供者与 registry。生产文件为 599 个，同路径 401、仅 Ash 198、仅上游 332，大小写差异为 0。此批完成职责迁移，保留现有 request/AbortSignal 契约；三类标准 provider 签名、范围与输入格式化的编辑器入口及完整上游调度语义仍待处理，80/41 声明计数不变。其他 contribution 的类型反向依赖尚未迁移。

- 本次职责迁移验证：18 项定向单测、103 项浏览器回归、Editor 对齐检查与类型检查、Stanza 和桌面 Renderer 生产构建通过。定向测试覆盖取消、模型释放与版本变化、提供者顺序、请求参数、registry 替换、JSON 和 App Server 适配。既有 7 份 CSS 债务及终端颜色环境提示仍保留；本批未改 CSS，构建无新增警告。

- 2026-09-15 文档方向修正：移除“每个 contribution 从 common 文件暴露 API”、`common/services → contrib/*/common` 和“每个功能构造 model-level service”的要求；区分职责归属与运行环境限制，并在对齐技能中加入公共 registry 的类型依赖检查。当时只修改 10 份文档，代码尚未迁移：`formatCommands.ts` 混合 provider 契约与调度，`ILanguageFeaturesService` 导入 contribution 类型。此前格式化行为测试通过不代表这些职责已对齐，声明计数保持 80/41。后续按公共契约、registry、功能编排与调用方的顺序修正，不按缺失文件数扩大实现。

- 2026-09-15 格式化取消与命令入口：本批修改 11 个文件，新增上游同路径 `contrib/editorState/browser/keybindingCancellation.ts` 和 `contrib/format/browser/formatActions.ts`，并在现有 `editorState.ts` 补齐 `EditorStateCancellationTokenSource`。格式化请求在光标移动、模型变化、只读切换、Escape、重复请求和释放时传递取消信号；提供者忽略信号时，调用方也能结束等待。既有快捷键与标准 `editor.action.formatDocument` Action 共用同一控制器；bundle 显式加载 Action 和贡献注册。文本、光标和滚动仍由既有 owner 管理，无 DOM 或 CSS 改动。10 项定向单测、103 项完整浏览器回归、对齐与类型检查、Stanza 构建及 diff 检查通过；保留既有颜色环境提示和 7 份 CSS 债务。全目录为 599 个生产文件、400 个同路径、199 个仅 Ash、333 个仅上游，大小写差异为 0。完整格式化提供者调度、选区格式化及 `TextModelCancellationTokenSource` 仍未补齐，121 组声明的 80/41 计数不变。

- 本次格式化批次最终验证：100 项完整浏览器测试、Editor 对齐检查（含 Stanza 类型检查）、Stanza 生产构建和 `git diff --check` 通过。验证直接使用真实 Standalone Widget、贡献装配和 Worker；未新增单测。保留既有终端颜色环境提示与 7 份未触及的 CSS 债务，无新增生产构建警告。

- 2026-09-15 格式化调用链补齐：新增上游同路径 `contrib/editorState/browser/editorState.ts` 的 `EditorState` / `CodeEditorStateFlag`，以及 `contrib/format/browser/formattingEdit.ts` 的 `FormattingEdit`。现有 `FormatController` 在提供者和 Worker 返回后核对模型身份、版本与光标，释放后不提交；格式化编辑统一处理只读、撤销边界、滚动恢复及换行符。仅换行符变化也保留，避免被最小编辑计算丢弃。生产文本和选区仍由 TextModel / Widget 持有；未新增 DOM 或 CSS。5 项 Chromium 定向回归覆盖正常格式化、移动光标、切换模型、只读和仅换行符变更，并验证文本及换行符撤销/重做。全目录为 597 个生产文件、398 个同路径、199 个仅 Ash、335 个仅上游，大小写差异为 0；既有 121 组声明的 80/41 计数不变。EditorState 的取消令牌类与完整格式化提供者调度仍未补齐，不能据此宣称整个文件 API 或 Editor 对齐完成。

- 2026-09-15 多光标命令身份修复：交换字符在跳过非空选区或文件起点光标时保留对应命令位置，防止主选区被后续命令覆盖；行注释完成重叠行判断后恢复原选区顺序，防止主光标被换到较早的行。两个问题均先由真实 Widget 与 Chromium 用例复现，再验证选区方向、注释切换和撤销/重做。交换字符批次通过 243/243 个 Editor 单测文件；随后行注释及交换字符共 10 项定向单测、最终 95 项 Chromium 浏览器测试、结构与类型检查及 Stanza 构建通过。此前因生成协议过期导致的聊天类型编译阻塞已解除；文件和 API 台账计数不变。

- 2026-09-15 空末行复制修复：同时向下复制倒数第二行和空末行时，两条命令原先在同一点插入，导致其中一条被冲突检查舍弃。`CopyLinesCommand` 统一在源行起点插入，根据实际插入范围和复制方向恢复选区，不再保存末尾换行状态。12 项定向单测、93 项 Chromium 浏览器测试、结构与类型检查及 Stanza 构建通过；新增浏览器用例先复现少复制一行，再验证选区方向、撤销与重做。完整单测编译被 `workbench/services/chat/browser/chatService.ts` 的 `userAudioAttachment` 类型错误阻塞；定向单测继承仓库原编译选项单独编译并执行通过，不将完整单测记为通过。文件和 API 台账计数不变。

- 2026-09-15 颜色扫描与行命令评审：补齐 `common/languages/defaultDocumentColorsComputer.ts` 的 `IDocumentColorComputerTarget` / `computeDefaultDocumentColors`，将 `languageColors.ts` 中既有 Ash 字面量解析迁入该路径。生产链为 ColorPicker → ColorDetector → ColorService → DefaultDocumentColorProvider → 扫描函数；服务继续负责提供者与请求版本，扫描只消费调用方的文本和坐标。默认提供者改从请求快照计算坐标，并在无匹配时也拒绝已取消请求。复制行改用模型返回的实际插入范围恢复多光标选区；复制、重复选区、移动、排序动作分别隔开撤销记录。全目录现为 595 个生产文件、396 个同路径、199 个仅 Ash、337 个仅上游，大小写差异为 0；121 组声明的 80/41 状态不变，整体 Editor 对齐仍未完成。 验证：16 项定向测试、243/243 个 Editor 单测文件、91 项 Chromium 浏览器测试、完整结构与类型检查、Stanza 生产构建通过；保留既有 JSDOM Canvas 与终端颜色变量提示，生产构建无新增警告。

- 2026-09-15 Editor 文件命名复查：扫描全部 594 个生产文件，395 个与 VS Code 同路径、199 个仅 Ash 存在，大小写不一致为 0。仅 Ash 文件数量不作为命名错误数量。确认 `test/common/languageCompletionService.test.ts` 创建 JSDOM 与真实 CodeEditor，`test/common/cursorInsertion.test.ts` 创建 JSDOM 与 TestView，已按用户确认迁入 `test/browser/`，同步调整浏览器测试工具的相对导入；两个旧路径退出，测试断言保持不变。`test/common/viewport.test.ts` 实测 common ViewLayout，保留 common。`contrib/format` 负责代码格式化，`contrib/formatting` 负责富文档工具栏，两者不能按近似名字合并；后者命名可在工具栏职责范围内另行整理。`common/languages/completion/` 的长前缀文件和 Peek/ColorPicker 的 Editor 前缀需结合公开契约与调用方逐项处理，不作批量字符串改名。本批只迁移两份测试，未改生产代码。验证：9 项定向测试、243/243 个 Editor 单测文件、结构与类型检查及 Stanza 构建通过；既有 JSDOM Canvas 提示仍存在，未新增此类提示。

- 2026-09-15 命名整理（用户已确认）：`contrib/snippet/common/languageCompletionSnippetParser.ts` 改为 `contrib/snippet/common/snippetParser.ts`，作为 Ash 的纯解析模块继续供 common 层使用；导出统一为 `parseSnippet`、`Snippet`、`SnippetOptions`、`SnippetVariableResolver` 等名称，转换函数同步使用 `createSnippetTransform` / `applySnippetTransform`。`contrib/suggest/test/common/suggestModel.test.ts` 移至 `contrib/suggest/test/browser/suggestModel.test.ts`，对应真实 Widget 测试环境。两个旧路径退出，生产调用与测试同步迁移；本次不代表完整 VS Code Snippet API 对齐。验证：243/243 个 Editor 单测文件、86 项浏览器回归、2 个扩展调用方测试文件、结构与类型检查及 Stanza 构建通过。

- 2026-09-15 前置镜像与嵌套选项修复：普通 `$1` 镜像在完整声明解析后读取默认值，选项列表在嵌套合并与前置引用中保持完整；最终输出继续只包含实际存在的选项字段。13 项解析单测、全量 243/243 个 Editor 单测文件、86 项浏览器回归（含 3 项选项切换/撤销/重做测试）、结构与类型检查及 Stanza 构建通过。完整 Suggest/Snippet API 仍待验收。

- 2026-09-15 片段选项修复：选项、镜像与转换结果通过一次 `ICodeEditor.executeEdits` 同步修改，一次撤销即可整体恢复；当前选项从模型文本读取，撤销或重做后继续切换不会使用旧索引。17 项补全会话单测、84 项完整浏览器回归（含 2 项片段键盘测试）、结构检查、类型检查及 Stanza 构建通过。完整 Suggest/Snippet API 仍待验收；后续已按用户的修复请求，在现有 `contrib/snippet/common/snippetParser.ts` 中修复前置转换的首次展开：解析完声明后计算转换文本和最终范围，保持现有解析入口与调用方。11 项解析单测、Editor 全量 243/243 个单测文件、85 项浏览器回归、结构与类型检查及 Stanza 构建通过；该修复不改变完整 API 对齐状态。

- 2026-09-15 补全会话与 View Zone 修复：用户确认将 `contrib/suggest/common/languageCompletionSessionController.ts` 迁入 `contrib/suggest/browser/suggestModel.ts`，将 `contrib/snippet/common/languageCompletionSnippetSession.ts` 迁入 `contrib/snippet/browser/snippetSession.ts`，并删除两个旧文件。生产贡献与聊天输入统一使用 `ICodeEditor`，两个会话不再导入内部光标控制器；模型切换和编辑器释放会取消请求并释放会话。只读补全不再报告接受成功或执行后续命令，片段选项与转换遵守编辑器只读边界，Tab/Shift+Tab 结束前一个占位符的撤销组。View Zone 回调保留区域对象作为 `this`，覆盖折叠隐藏、展开恢复与滚动通知。两个恢复同路径的声明加入待处理表；这批完成依赖迁移与行为修复，不代表完整 Suggest/Snippet API 已对齐。 验证：Editor 全量单测 243/243 个文件通过；模型切换通知修正后，补全会话、聊天输入与架构共 47 项复验通过，最终浏览器 83/83 项、Electron 文件打开/编辑/保存 1 项、聊天输入 1 项、Stanza 与桌面构建通过。完整结构与浏览器检查入口通过；既有 7 份品牌替换式 CSS 仍作为债务记录，本批未改 CSS。

- 2026-09-15 命名与聊天输入评审：移除聊天实现、CSS、命令/技能补全、测试与构建配置文件名中的引擎前缀；注册表单独命名为 `chatInputEditorRegistry.ts`，实现使用 `chatInputEditor.ts`。聊天高度按编辑器末行实际底部计算，并在内容或容器尺寸变化后统一调度布局；命令补全替换完整命令词并保留参数。聊天宿主通过注入的 `ICodeEditorService` 登记/移除编辑器，恢复全局全选。`ObservableCodeEditor` 改接编辑器内容事件，布局通知只更新布局状态，避免清空折行文本时先通知内容、后更新光标导致的渲染越界。验证通过：16 项定向单测、Editor 全量 243/243 个测试文件、81 项浏览器回归、聊天尺寸/全选 Web 与 Electron 各 1 项、Electron 文件打开/编辑/保存 1 项、Stanza 与桌面构建。台账整体仍为 80/39；补全 common 会话及片段的内部光标依赖未在本批迁移。

- 2026-09-15 补全浏览器依赖批次：`SuggestController` 与 `CompletionWidget` 改为通过 `ICodeEditor.getModel/getSelections/getPosition` 读取编辑器状态，普通 contribution 与聊天输入同步传递编辑器对象。两个浏览器类不再引用内部 `CursorsController`；请求刷新重新读取当前选区并处理无模型状态。补全测试改用容器装配的真实 Widget，覆盖触发字符、提交字符、片段导航、撤销与关闭后的普通方向键导航。20 项补全/聊天定向测试、81 项浏览器测试、Electron 打开/编辑/保存 1 项、类型检查与 Stanza/桌面构建通过。common 补全会话与片段仍直接依赖内部光标控制器，View 定位及完整 Suggest API 尚未对齐，80/39 台账计数不变。

- 2026-09-15 输入装配清理：删除从未参与输入执行的语言编辑适配器、Widget 创建链与 contribution 词法上下文注入钩子。输入和回车继续由 `IViewModel.type` 进入 common cursor，`ViewController` 不再直接引用 `CursorsController`；语言分析服务仍由贡献持有并供括号匹配与章节标题使用。新增无贡献 Widget 回归覆盖补括号、成对删除、回车和撤销；全量单测 243/243 个文件、浏览器 81 项、Electron 打开/编辑/保存 1 项、Stanza 与桌面构建通过。结构台账仍为 80/39，贡献上下文其余直接内部依赖尚未完成。

- 2026-09-15 服务装配批次：`CodeEditorWidget` 通过构造注入取得主题、语言配置和语言功能服务，删除 options 中的对应服务字段、自建共享服务分支和空的 Widget 子作用域。Workbench 文件、聊天、提交信息、Embedded 与 Standalone 创建链改用宿主容器；模型挂载作用域继续拥有贡献和局部资源。`CodeEditorPane` 不再转传语言服务，Standalone 同时注入模型与编辑器服务。新增测试验证缺失服务在 Widget 创建前失败、构造器贡献与安装钩子使用同一宿主服务，以及换模型和销毁不释放共享服务。全量 Editor 单测 243/243 个文件、浏览器 81 项、聊天输入 5 项与桌面构建通过；贡献上下文、内部光标接口和其余 Widget API 仍待处理，80/39 台账计数不变。

- 公开接口修复批次保留创建时的 `wordWrap`，把滚动参数和动画查询接到现有 ViewLayout；View 区分自身同步 DOM 位置产生的通知与外部滚动，修复动画被中途取消的问题。`onDidChangeModelContent` 直接使用 ViewModel 的完整事件，旧无参数事件退出；空模型的视图状态与 View Zone 操作遵循空状态契约。Standalone 接口不再继承 Widget 实现类，Workbench 的状态与保存处理改用公开选区接口。73 项相关单测、62 项浏览器测试、结构检查、类型检查及 Renderer 构建通过；强化后的换行几何和外部滚动中断场景单独复验通过。功能上下文及服务装配的整体收拢尚未完成，声明完成计数不变。

- `setSelection` 参数批次补齐 `Range / IRange` 输入，并保留 `Selection / ISelection` 方向、显式事件来源和默认 `api` 来源。Find 的命中导航直接传入范围；测试改用真实 `CodeEditorWidget`，不再用假 Editor 绕过参数入口。Widget 与 Find 共 48 项单测、61 项 Editor 浏览器测试、Stanza 类型检查、结构检查及 Renderer 构建通过。新增回归覆盖范围输入、次光标清理、坐标约束、方向、无效参数、模型分离、键盘替换和撤销；本批未改变整体声明完成计数。
- 2026-09-13 按相对路径扫描非测试 `.ts`、`.tsx`、`.js`、`.css` 生产文件：Ash Editor 597 个，VS Code Editor 733 个；392 个同路径，205 个仅本地，341 个仅上游。
- 首次重扫发现 49 个目录大小写错误，全部来自工作区实际目录 `browser/viewparts` 与上游 `browser/viewParts` 不一致；已做两步大小写重命名，当前大小写错误为 0。
- 账目摘要：当前表格记录 121 组同名声明结构差异，已处理 80 组，剩余 41 组。只有通过文件集合、import owner、生产调用链和生命周期复核的声明才计入已处理；调试工具需明确证明其不进入生产创建链是职责本身。
- 205 个仅本地文件正在逐项分类为“错误承载，迁移并删除”或“Ash 专有”。分类完成前，不再声称不存在 import owner、重复 owner 或错放文件问题。上游存在而本地缺失的文件按原相对路径直接建立，先恢复 API 名称并独立实现逻辑，再把现有 import 迁入该 owner；同路径文件只原地修改。
- 用户已确认仅本地项的处理原则：架构文档明确归属的 Ash 专属能力按既有职责保留；与 VS Code 重叠的职责迁回对应路径。文件删除仍需在每批执行前按准确路径、原因、剩余调用方和 Git 可恢复性单独确认。
- import 集合不同不单独判错：缺少上游能力会自然缺少对应 import，本地真实扩展也会增加 import。只有同一符号从错误 owner 导入才属于路径错误。
- 输入、参数和返回类型一致不代表行为已经一致。剩余项仍需继续核对状态 owner、事件顺序、失效条件、调度阶段、坐标转换、可见副作用、失败语义和释放时机。
- `comment.ts`、`dropIntoEditorController.ts`、`dropIntoEditorContribution.ts` 与 `completionsEnablement.ts` 已有上游同路径 owner；Find contribution ID 为 `editor.contrib.findController`，drop 的 `BeforeFirstInteraction` 阶段已覆盖 `dragover` / `drop`。注释快捷键此前仍通过 `comment.contribution.ts` 使用两个旧 Controller，原先“无外部生产调用”的记录有误。现按用户要求回收重复职责：快捷键与命令共用 `comment.ts` 的 Action，读取当前注释配置，两个 Controller 和独立注册文件退出，测试迁入浏览器真实入口。Find 注册已回到 `findController.ts`，独立注册文件退出，控件及装饰生命周期保持不变。旧 `textDropController.ts` 和直接构造它的测试已删除；实际拖放由 `DropIntoEditorController` 承接，Widget 测试覆盖文本、HTML、文件解码、只读和非文本输入。`ownedCompletionsEnablement.ts`、`selectionSetTracker.ts`、`clipboard.contribution.ts` 和 `languageDiagnosticPresentation.ts` 已删除。
- Controller 初筛覆盖 contrib 下 36 个同名后缀文件：11 个上游同路径、25 个仅 Ash。文件关系不代表可删除性；已回收两个注释 Controller。括号导航、删除和匹配高亮现收敛到 `bracketMatching.ts` 的 `BracketMatchingController`，旧三个 Controller 文件退出；沿用既有模型、括号索引和装饰生命周期，快捷键与标准跳转/删除 Action 共用操作。该类仍通过 Ash contribution 装配，未完成全部上游契约。换行开关仍需核对 View 与编辑器配置的关系；诊断悬浮与异常行分隔符控制器持有 DOM 或装饰更新生命周期，不能按薄转发层直接删除。
- Editor contribution 批次已把 Placeholder、Message、Read-only Message、Cursor Undo 与 Context Menu 接入标准 `registerEditorContribution`；`transpose.ts` 与 `linesOperations.ts` 删除不存在于上游的运行时 contribution，action 直接执行标准 `ICommand`。`editorEditCommand.ts` 与 `editorCommand.ts` 已删除且残留引用为 0。Clipboard 已建立上游同路径 `clipboard.ts`，命令与菜单使用标准 `MultiCommand`，默认 copy/cut/paste 回到 TextArea/Native EditContext；URI-list 与有界文本文件粘贴迁入上游同路径 `CopyPasteController`，贡献统一进入 `registerEditorContribution`，模型配置与安装钩子由 `CodeEditorContributions` 执行。`NativeEditContext.handleWillCopy` / `handleWillPaste` 已接回标准 Clipboard action 调用链。旧 `clipboard.contribution.ts`、`clipboardController.ts` 及直接构造旧控制器的测试已删除；复制、剪切与粘贴不再保留第二套实现。
- 剪贴板行为验收确认 TextArea 与 Native EditContext 的 DOM 复制、剪切和粘贴只由聚焦输入节点处理。`clipboard.ts` 的标准贡献接管 Web Native 输入节点的键盘快捷键，Code bundle 已停止导入旧 capability 注册；多光标元数据、外部换行分发、整行复制保留列位置、关闭空选区复制，以及粘贴撤销均通过两种输入模式的真实 DOM 事件验证。浏览器对 `execCommand('cut')` 报成功却不发事件时，命令改按实际事件决定是否需要写入并删除。命令式剪切与粘贴通过 `EditorStateCancellationTokenSource` 监听模型、内容、选区、失焦、只读切换、组合输入、Escape 和释放；状态恢复也不会让旧结果生效。取消立即结束等待，迟到的系统剪贴板结果不再改动模型，操作监听随完成或取消释放。Standalone 注册唯一的 `IContextKeyService`，标准剪贴板命令可直接执行，并由编辑器建立局部上下文。
- 文件粘贴由 `CopyPasteController` 独占当前请求，复用 `EditorStateCancellationTokenSource` 与 `raceCancellation`。内容、模型、选区、只读状态、组合输入开始、Escape、后一次粘贴或销毁均取消旧请求；选区或可写状态恢复不会使旧结果重新生效。取消立即结束 `finishedPaste()` 的等待，底层文件读取仍可能继续，但结果不再写入。解码失败或超限保留原文，后续粘贴仍可正常执行；这不代表 paste-as provider 等其余上游能力已完成。
- HTML 复制现由 `ViewModel.getRichTextToCopy()` 使用模型已有 token 与颜色表生成；选区、整行和多选区沿用纯文本复制的范围，输出转义文本及可携带的颜色、字形样式。`copyWithSyntaxHighlighting` 控制默认 HTML 输出。HTML-only 粘贴由 `CopyPasteController` 复用拖放使用的 HTML 转纯文本能力，再走标准粘贴命令；转换区分块分隔与内容换行，保留连续 `<br>`、首尾换行及 `<pre>` 内空白，相邻代码块保持分行；纯文本优先、只读限制和撤销保持一致，URI-list 的空记录不再截断 HTML 处理。两种输入模式已覆盖 token 样式、部分选区、整行、多选区、关闭高亮、外部 HTML 和撤销；显式高亮复制已从系统剪贴板读回验证；强制高亮开关仅覆盖同步复制数据生成，在等待系统写入前恢复，写入成功或失败都不影响期间及后续的普通复制。Chromium 将命令 copy 事件送到 `body` 时，由该命令的短期监听使用同一份模型复制数据写入，监听随命令结束释放。旧的私有 MIME、逐选区粘贴模式和控制器专用配置随旧实现退出；当前生产入口使用 `vscode-editor-data`、`emptySelectionClipboard` 与模型换行配置。
- 行布局与软换行批次沿现有 `ViewModelLinesFromProjectedModel → ViewLayout → ViewLines` 生产链验证调整宽度、增量编辑、续行点击和模型坐标；`DOMLineBreaksComputerFactory` 对非等宽字体优先在空白处换行，并让 `wordBreak: keepAll` 避开连续 CJK 文本的优先断点，超宽内容仍按字素边界换行。本批只局部修改已有浏览器测量文件，没有新增投影 owner 或 CSS。
- 可见行复用批次让同路径 `ViewLayer` 与其覆盖行 owner `ViewPartRows` 只调整视口增减的 DOM 子节点，不再在每次滚动时重挂全部行。Chromium 验证重叠行从未脱离文档、节点身份和文字更新保持正确、离屏与编辑器释放均断开旧节点；没有改动 ViewLines 的公开契约或 CSS。
- 光标与 gutter 行为验收沿现有 `ViewModel` 坐标转换和 `ViewLayout` 几何，核对软换行、相对行号、glyph 锚点、焦点、移动与增量编辑。Chromium 场景和既有 owner 测试通过；`ViewCursors`、`LineNumbersOverlay`、`GlyphMarginWidgets` 的生产职责与 DOM/CSS 本批保持不变。
- ViewPart 根节点批次将 `Margin`、`Minimap`、`OverviewRuler`、`ViewCursors` 和 `ViewLines` 的外部 DOM 访问统一到各自上游 `getDomNode()` 入口；内部节点不再额外公开。`Margin` 恢复 `OUTER_CLASS_NAME = 'margin'` 与独立 `glyph-margin` 背景层，沿用 Ash 的滚动和尺寸计算，未修改或复制 CSS。`ViewLines` 的公开成员差异归零，并接通 `ViewModel → ViewRevealRangeRequestEvent → ViewLines` 的纵向与延迟横向 reveal；`CodeEditorWidget.revealRange` 不再绕过事件链直接调用 `View`。View 释放阶段不再由组合输入和 overtype 清理回调触发已释放 Part 的重绘；Widget、Minimap、视区、光标和 ZoneWidget 共 34 项相关测试通过。
- View Zone 批次把 `ViewZones` 的公开成员差异归零，`changeViewZones` 只通过 `ViewModel.changeWhitespace` 改动标准空白区，CodeLens、ZoneWidget 与鼠标抑制链不再使用并行 zone handle 或 ViewLayout zone API。真实 Chromium 验证高度、最小宽度、移除、gutter 横向固定和释放；编辑器根尺寸及 Minimap、OverviewRuler、输入层、scrollbar 的定位回到各自现有 Ash DOM/CSS owner，没有引入 Monaco class 或变量。
- Widget 端口批次把 `ViewContentWidgets` 与 `GlyphMarginWidgets` 的公开成员差异同时归零。Content Widget 构造只接收标准 `ViewContext + FastDomNode`，配置、模型坐标、失效和释放均由 Part 自己读取；`suppressMouseDown` 进入 `MouseHandler` 的真实焦点/默认事件链。Glyph Margin 的 add/layout/remove API 已从 `ICodeEditor → CodeEditorWidget → View → GlyphMarginWidgets` 接通，构造只接收 `ViewContext`，标准模型 decoration 与 caller widget 按 line、lane、z-index 选出 winner。
- Decoration owner 批次恢复了标准 `DecorationsOverlay(ViewContext)`：它只读取 `RenderingContext.getDecorationsInViewport()`，处理整行、普通、collapsed、换行填充、z-index 与逐行片段；`View` 在任一 Part 因模型 decoration 事件需要重绘时统一执行投影。Diagnostics、Color Picker、Debug、Quick Diff、Bracket、Anchor、Selection Highlight、Find、Unicode、异常行终止符与 Word Highlight 均写入标准模型 decoration options，生产 View、Widget 与 Workbench 不再接受或聚合 `DecorationSource`。旧定义只剩无生产调用的仅本地文件，待按删除确认规则处理。
- 标准边栏与块装饰批次把 `Margin`、`LinesDecorationsOverlay` 和 `BlockDecorations` 的构造器、公开成员及布局输入收敛到 `ViewContext + EditorLayoutInfo + RenderingContext`。Folding 与 Symbol Icons 已移除 `DecorationSource` 注册并直接写标准模型 decoration options；真实 Chromium 验证 Rust syntax provider、折叠、符号图标、标准 line/block decoration 以及横向滚动后的固定 gutter。Workbench 文本模型服务在创建 `TextModel` 时设置真实 resource 和语言，显式语言优先，其次 MIME、路径与首行；`CodeEditorPane` 不再另算一份语言。
- Injected Text 批次接通 `TextModel.getLineInjectedText → ViewModelLines → ViewLineData → ViewLine → MouseTarget`。无换行模式不再跳过 injection projection，行 token、inline class、model/view 坐标和 `attachedData` 使用同一 `ModelLineProjectionData`；Color Picker swatch 因此通过标准 before decoration 渲染并从鼠标目标读取 marker，不再按附近坐标猜测颜色。`DynamicCssRules` 的 owner/ref 释放顺序也已闭合，Color Picker、软换行装饰、语义 token、指针命中、ViewModel 与动态 CSS 聚焦测试通过。
- 鼠标目标批次建立 `editorDom.ts` 的标准页面/客户区/编辑器相对坐标和可释放事件工厂，`MouseTargetFactory` 直接生成公开 `IMouseTarget`，不再发布仅本地的中间 target 类型。`MouseHandler(ViewContext, ViewController, IPointerHandlerHelper)` 统一处理指针、拖动、drop、context menu 和选择分发；Folding、Debug 与 Color Picker 均消费编辑器公开鼠标事件，相关 DOM 监听及单次拖动会话由可释放 owner 持有。
- 越界拖选批次把同路径 `dragScrolling.ts` 原地改为 `DragScrolling`、`DragScrollingOperation`、`TopBottomDragScrolling` 与 `LeftRightDragScrolling` owner；`MouseHandler` 只生成标准 `OUTSIDE_EDITOR` target，并按轴启动或停止对应 operation。每帧通过 `ViewLayout` 滚动、同步 render、重新命中边缘位置并使用 `NavigationCommandRevealType.None` 扩选；返回编辑器、pointerup、cancel、blur、布局变化或释放都会清理当前 operation 和动画帧。
- 光标批次先修正 `RenderingContext → IViewLines` 的坐标端口：DOM 与 GPU 行几何统一接收视图行范围，选区、装饰、内容小组件、组合输入和双向文字调用方在边界处明确转换。`ViewCursor` 与 `ViewCursors` 的公开成员差异已归零；`ViewCursors` 只持有光标 DOM、配置和闪烁状态，组合输入范围改由 `CompositionController` 写入标准模型 decoration，再由普通装饰渲染链投影。光标 CSS 使用 Ash 主题变量和动画名，未新增 Monaco 名称。
- 光标状态 owner 批次继续收口 `CursorsController`：文档 `undo` / `redo` 已从该控制器公开面移除，浏览器输入与 26 个相关测试文件直接进入 `TextModel` 历史；自动闭合记录改为控制器内部实现，不再作为测试或跨文件 API。仅测试调用的 `beginComposition → CompositionSession` 平行实现也已退出，组合输入只保留生产 `startComposition → compositionType → endComposition` 链；成员差异由 12 项降至 8 项。剩余 read-only、cursor-only history 与事件入口仍依赖尚未完成的 ViewModel/contribution 迁移，因此本声明继续留在待处理表。
- 输入与选区端口批次继续沿现有生产链收口，而没有按上游缺失文件横向铺开：`View → ViewController → IViewModel` 统一读取和提交选区，TextArea、Native EditContext、ScreenReaderSupport 与 CompositionController 不再直接依赖 `CursorsController`；Anchor Select、In-place Replace、Line Selection、Selection Highlighter 以及 14 个只读写选区的 contribution controller 已改用 `ICodeEditor` 或 `IViewModel`。当前 Editor 生产代码有 16 个文件引用 `CursorsController`，扣除 `cursor.ts` 与 `viewModelImpl.ts` 两个 owner 后还有 14 个外部调用方；剩余文件涉及编辑事务、光标历史、只读事件、仅 Ash 文件或尚未闭合的装配链，本批不强行迁移，也不新增上游外围文件。
- Native 辅助阅读端口批次把 `ScreenReaderSupport` 的公开成员差异从 9 项收敛为 0，并把 `IScreenReaderContent` 收敛为标准的 cut、paste、focus、configuration、content 和 scroll 六个入口：简单内容 owner 直接实现现有分页镜像、DOM 选区监听与映射和滚动行为，富内容 owner 继承这些入口并只覆盖自身 token/bracket DOM 渲染，没有添加只调用 `super` 的包装方法。系统 `selectionchange` 只在内容聚焦期间由当前 simple/rich content 持有，经过 `ViewController.setSelection` 回到唯一 ViewModel owner；内容切换、失焦和释放会同步释放监听，`ScreenReaderSupport` 不再读取内容内部 DOM 选区状态。`EditorConfiguration` 现在是 page size 与 rich/simple 选择的唯一配置 owner，Widget、ViewController 和 EditContext 不再传递第二份构造快照；运行时切换会由一个可替换资源 owner 释放旧内容并保持焦点与当前模型投影。装饰、flush、行、滚动和空白区变化仍由 `NativeEditContext` 自身的 ViewPart 事件决定重绘，再在 `prepareRender` 统一同步内容；构造时强制内容模型、ViewModel 与 Viewport 使用同一 `TextModel`。本批保持 Ash 现有 DOM child 和布局 owner，没有改动 CSS、DOM 层级或上游外围文件。
- Cursor Undo 端口批次把 `CursorStateChangedEvent` 的 primary/secondary selection、旧 selection、模型版本、来源和原因完整投影为标准 `ICodeEditor.onDidChangeCursorPosition` / `onDidChangeCursorSelection`。同路径 `cursorUndo.ts` 只记录同版本 selection 事件并在模型变化时清空有界历史；同路径 `linkedEditing.ts` 改由 `ICodeEditor` 读取 selection 和订阅位置事件，不再直接依赖内部 selection controller。上游已有而本地缺失的 `contrib/cursorUndo/test/browser/cursorUndo.test.ts` 已原路径建立并独立覆盖状态恢复与模型失效。
- Overview Ruler 批次把 `DecorationsOverviewRuler` 的公开成员差异归零：标准光标事件、配置/主题/滚动失效、`prepareRender` 读取阶段和显式释放进入同一 `ViewPart` 生命周期；装饰 lane、光标标记、边框、DPR 与隐藏光标配置由同一 canvas owner 绘制。`editorOverviewRuler.border/background` 已进入 Ash 主题注册表，高对比度边框和透明背景不依赖 Monaco CSS。`EditorScrollbar` 已通过 `SmoothScrollableElement` 连接现有 `Scrollable`，构造接口、DOM/overview ruler 挂载、滚轮与指针委托进入生产调用；显隐、轨道/滑块尺寸、分页点击、滚轮配置和零尺寸焦点由基础控件处理。浏览器验证覆盖这些入口与主题切换，Editor 类型检查和构建通过。箭头配置（双轴启用与尺寸）和 inertialScroll 已接入基础控件：箭头支持点击、长按、键盘与边界禁用，轨道扣除箭头占用；连续像素滚轮输入可衰减续滚，反向输入替换方向，键盘/指针、配置变化、尺寸变化和释放取消续滚。新增 Chromium 回归验证长按释放、运行时移除、焦点、高对比度、边界、续滚衰减与销毁；本批编辑器浏览器测试 20 项、基础滚动条单测 7 项及 Stanza 构建通过。后续设备判断改为记录连续输入与固定步长，在灵敏度和轴映射前分类，并防止边界处同一滚轮事件重复处理。对 VS Code `6a932e0f957` 的 9 组、581 条设备事件，在相同单位下运行双方分类逻辑，分类结果全部一致；未复制上游实现或样本到 Ash。新增独立 Chromium 回归覆盖大幅整数像素输入、固定步长、非整数步长、设备切换及边界重复事件，编辑器浏览器回归 21 项通过，Electron UI 布局 2 项通过，桌面构建通过。更新本地 App Server 打包产物以解决协议版本 5/7 不匹配后，真实文件的 Electron 滚轮、Home/End、滑块拖拽场景通过（1 项）。后续已修复大段文本输入卡住渲染进程的问题：CursorsController 将连续普通字符合并提交，保留空格撤销边界、语言字符拦截与覆盖输入行为；ScreenReaderSupport 在编辑结束后的同步阶段读取最终选区，避免布局变化期间读取旧选区越界。新增长文本替换、撤销重做，以及多光标下批量输入与逐字输入等价性回归；输入相关单测 42 项、编辑器浏览器回归 22 项、真实 Electron 大段替换后保存并继续输入场景 1 项通过，渲染器构建与自动化测试类型检查通过。尚未完成整体 VS Code 同场景滚动曲线与布局运行对照，因此本项继续保留在待处理表，不把分类结果一致计为全部行为对齐。仅本地 `workbench/contrib/debug/browser/debugBreakpointDecorations.ts` 没有生产调用方、本批未修改，也没有被接入该链。
- GPU 渲染只保留标准 `ViewportData + ViewLineOptions → cell buffer → atlas storage/texture` 链，旧 `GpuFrame`、逐 glyph vertex frame 和 `IStyled*` 接口已删除。`View` 唯一持有 `ViewGpuContext`，`ViewLines` 自己投影 GPU 行 DOM 状态；`BaseRenderStrategy` 只保留标准抽象和事件生命周期，完整文件与视口策略分别在自身文件编码 cell，不再通过 base 的额外成员共享实现。canvas 继续标记为 `aria-hidden`，颜色由 Ash 主题快照进入共享 atlas；canvas、行层和 gutter 只补充 Ash 自有布局规则，没有复制上游 CSS 或引入 Monaco class。
- Language Features Registry 批次保留现有 provider 请求、版本门禁和 App Server/Extension Host 适配逻辑，只把单一 `formattingProvider` 拆成标准 `documentFormattingEditProvider`、`documentRangeFormattingEditProvider` 与 `onTypeFormattingEditProvider` 三个独立 owner，并把 `parameterHintsProvider`、`semanticTokensProvider` 分别迁为 `signatureHelpProvider`、`documentSemanticTokensProvider`。Standalone、Format/Parameter Hints contribution、ModelService、BrowserTextModelService、Workbench JSON、App Server 与 Extension Host 共 15 个文件已改接，旧字段生产引用为 0；两个同名声明的成员差异分别由 19/20 降至 11/12。paste/drop、range semantic tokens、inline values、evaluatable expression 与 new symbol names 当前没有闭合的生产消费者，未添加空 Registry。

## 处理规则

1. 同名、同职责且本地能力完整时，恢复上游名称、参数、返回值、owner 和调用链。
2. 本地职责与上游同名声明不同，且它确实是 Ash 专有能力时，移出上游 owner 或改成明确的本地名称；不保留别名、包装入口或重复导出。
3. 缺少基础模型、视图上下文或服务契约时，从基础 owner 向调用方逐层实现，不在下游伪造同名接口。
4. `editor` 可以依赖 `base` 和 `platform`；`common` 不能依赖 DOM，`browser` 才能使用 DOM，依赖方向不能反转。

## 已处理的同名契约

| 文件 | 声明 | 结果 |
| --- | --- | --- |
| `browser/controller/editContext/native/debugEditContext.ts` | `DebugEditContext` | 构造入口、状态代理、事件包装、调试开关和边界标记职责与上游一致；该类型只用于手动诊断，明确不进入生产输入创建链，所有标记使用调用方 document 并从无障碍树隐藏，定向测试覆盖状态、事件、开关与清理 |
| `browser/controller/editContext/clipboardUtils.ts` | `IClipboardPasteEvent` | 字段、构造行为和外部数据转换与上游一致；生产调用由 TextArea/Native EditContext 默认消费并保留 `onWillPaste` 拦截点，Observable Editor 继续发布同一事件；浏览器测试覆盖 metadata、外部数据转换和默认粘贴 |
| `browser/controller/editContext/clipboardUtils.ts` | `IClipboardCopyEvent` | 公开成员与上游归零；事件在输入上下文中生成选区文本、来源范围、富文本和内存元数据，TextArea/Native EditContext 在拦截器未处理时写入标准数据并执行剪切；浏览器测试覆盖复制、剪切、多选区、整行和系统剪贴板回退 |
| `browser/controller/editContext/clipboardUtils.ts` | `createClipboardCopyEvent` | 五参数入口与上游一致；由 `ViewContext` 读取配置和选区并负责标准剪贴板数据及元数据写入，旧的无模型事件入口已删除，生产调用只经过两个输入实现 |
| `browser/controller/editContext/textArea/textAreaEditContextInput.ts` | `TextAreaInput` | 标准 `ITextAreaInputHost`、焦点、键盘、type、composition、selection 和 clipboard 事件均由唯一 textarea DOM owner 发布，普通文本与组合替换统一进入 `ITypeData`，系统选区与屏幕阅读器状态仍由同一 owner 映射并释放。失焦后不可取消的 `beforeinput` 不再发出 type，迟到的 `compositionstart` 不重建组合状态，copy/cut/paste 不再读取旧选区或提交编辑；上游 `_initializeFromTest` 没有生产职责，`dispose` 由 `Disposable` 基类继承，不添加空包装；本地 wrapper 方法和 raw before/input 事件服务于现有单 owner，不为形似上游另拆私有 wrapper 类图 |
| `browser/controller/editContext/native/nativeEditContextUtils.ts` | `FocusTracker` | 构造契约恢复日志服务、目标元素和焦点回调三个参数；生产日志依赖从编辑器服务容器经 `CodeEditorWidget` 和 `View` 进入原生输入，Standalone 明确注册空日志实现。测试覆盖焦点、失焦、暂停恢复、Shadow DOM、日志与监听释放 |
| `browser/services/codeEditorService.ts` | `ICodeEditorOpenHandler` | 由 `AbstractCodeEditorService` 按新注册优先顺序调用，首个返回编辑器的处理器终止链路；单项释放只移除对应处理器，测试覆盖继续查找、短路和释放 |
| `browser/services/codeEditorService.ts` | `ICodeEditorService` | 公共成员差异归零；代码与差异编辑器的创建、加入和移除由各 Widget 的真实生命周期触发，打开处理器、资源模型属性、临时模型属性、装饰类型和当前编辑器均由同一浏览器服务提供，Workbench 差异窗格与快速差异视图使用同一服务实例 |
| `browser/services/abstractCodeEditorService.ts` | `AbstractCodeEditorService` | 抽象层只持有跨宿主共享的编辑器注册表、处理器链、资源属性、临时属性和装饰类型；当前编辑器由具体浏览器宿主持有；临时属性按 URI 与模型销毁释放，装饰样式按引用计数和服务生命周期释放，测试覆盖事件顺序、资源身份、父子装饰与释放 |
| `browser/stableEditorScroll.ts` | `StableEditorScrollState`、`StableEditorBottomScrollState` | 参数收敛到 `ICodeEditor`；滚动位置、内容高度、可见范围和行坐标由 `CodeEditorWidget` 持有，CodeLens 在增删 Widget 前后使用同一编辑器恢复顶部或底部锚点，测试覆盖首末可见行、光标相对位置和真实 Widget 几何 |
| `browser/observableCodeEditor.ts` | `observableCodeEditor` | 单参数入口直接接受 `ICodeEditor`，同一编辑器始终返回同一 facade，编辑器销毁时同步释放并移出缓存 |
| `browser/observableCodeEditor.ts` | `ObservableCodeEditor` | 公共成员与上游归零；模型、版本、选区、焦点、组合输入、键入、粘贴、布局、滚动、内容尺寸、装饰和 Widget 均通过 `ICodeEditor` 观察，不再读取 `CodeEditorWidget.view` 或 `viewport`，3 项测试覆盖响应式更新、行坐标、装饰所有权与销毁 |
| `browser/view/viewUserInputEvents.ts` | `ViewUserInputEvents` | 公开回调、构造参数、事件类型和静态目标转换入口与上游一致；鼠标事件由 `MouseHandler` 解析为视图坐标，经 `ViewController` 转发后在此统一转换为模型坐标，Widget 不再另建 DOM 监听链；测试覆盖普通 target、View Zone 嵌套坐标和真实 Widget 事件发布 |
| `browser/controller/mouseHandler.ts` | `MouseHandler` | 构造参数、protected/public 成员和 `ViewEventHandler` 生命周期与上游一致；生产链通过 `EditorMouseEventFactory`、`EditorPointerEventFactory`、`MouseTargetFactory` 和 `IPointerHandlerHelper` 发布标准 `IMouseTarget`，不再生成或二次翻译仅本地 target。鼠标 pointer ID 与 `mousedown` 点击次数由 `PointerHandler` 合并；释放时只发布一次 MouseUp，兼容事件仍能补齐丢失的 `pointerup`。拖动会话、全局监听、捕获与 ViewContext 注销随实例释放；owner 和 Chromium 用例覆盖文本、边栏、View Zone、Widget、Injected Text、drop、Folding、Debug、拖选与释放 |
| `browser/controller/dragScrolling.ts` | `DragScrolling` | 同路径文件保留上游抽象 owner、`start` / `stop` 生命周期及上下/左右 operation 拆分；生产由 `MouseHandler` 根据 `IMouseTargetOutsideEditor` 轴向调用，滚动、同步 render、边缘命中、RTL 行首尾和 `dispatchMouse` 形成闭环。operation 由可替换资源持有，重复位置更新不重建，停止与释放取消后续动画帧；直接生命周期测试和真实 Widget 双轴拖选测试覆盖调用链 |
| `contrib/zoneWidget/browser/zoneWidget.ts` | `ZoneWidget` | 恢复 `IOptions`、`IStyles`、`OverlayWidgetDelegate`、`ZoneWidget` 及其子类扩展点；独立实现通过 `ICodeEditor` 持有模型锚点、视图区、布局、滚动、选区与释放，Peek、Call/Type Hierarchy、跳转结果和 Quick Diff 均传递真实编辑器对象，定向测试覆盖换行锚点、布局、缩放、样式和选区保持 |
| `contrib/wordHighlighter/browser/textualHighlightProvider.ts` | `TextualMultiDocumentHighlightFeature` | 由语言能力服务统一注册单文档与多文档文本高亮 provider；多编辑器共享同一服务时按引用计数持有注册，不再维护重复的模型 target 表，provider 直接使用 `ITextModel.uri` 返回跨文档结果，Word/Selection Highlighter 7 项测试覆盖 Unicode、语义优先、多文件、取消和导航 |
| `common/cursor/cursorColumnSelection.ts` | `ColumnSelection` | 人工检查：列选择按 UTF-16 列号裁剪；混合 Tab/宽字符时的可视矩形语义需真实交互验证。 |
| `common/cursor/cursorMoveOperations.ts` | `MoveOperations` | 公开成员差异归零；17 个标准移动入口直接使用 `CursorConfiguration`、`ICursorSimpleModel` 与 `SingleCursorState`，旧 `navigate` 总入口及全部调用已移除。键盘控制器按命令调用标准入口，删除、输入、转置与行操作使用标准位置 API；定向测试覆盖水平、垂直、可视列余量、原子缩进、空行、行/文档边界以及真实 Widget 连续键盘导航 |
| `common/cursor/cursorMoveCommands.ts` | `CursorMoveCommands`、`CursorMove` | 15 个标准命令入口、参数元数据、方向、单位和解析契约的公开差异归零；实现直接使用真实 `IViewModel`、模型/视图光标状态及坐标转换。键盘、行选择和多光标生产调用统一进入该 owner，指针选区合并与行尾多光标辅助逻辑分别回到 `ViewController` 和 `multicursor.ts`；契约测试锁定公开面，真实 Widget 与 contribution 测试覆盖连续垂直移动、重复 caret 归一化和行选择 |
| `common/cursor/cursorWordOperations.ts` | `WordOperations` | 公开成员差异归零；标准 classifier、移动、删除、词内删除、词段、选词和 `getWordAtPosition` 由同路径 common owner 实现，并同时导出标准 `WordPartOperations`。浏览器双击/拖选、平台词移动和 `beforeinput deleteWord*` 均改接该 API；旧 `getWordSelectionRange`、`getTextWordRanges` 及浏览器自算词边界已移除，common 与真实 Widget 聚焦测试覆盖调用链 |
| `common/cursor/cursorCollection.ts` | `CursorCollection` | 公开成员、primary-first 状态、last-added cursor、tracked marker 生命周期、重叠归一化和 model/view selection 投影与上游职责一致；生产由 `ViewModelImpl → CursorsController` 直接构造并持有，模型 flush 重建 collection，单命令执行先移除 secondary cursors，定向测试覆盖归一化、位置 tie、flush 与释放 |
| `common/cursor/oneCursor.ts` | `Cursor` | 公开成员、model/view 双状态、tracked selection 与折行坐标转换进入 `CursorCollection` 的生产生命周期；marker 缺失或停止跟踪时明确失败，不再返回可能过期的 selection，定向测试覆盖 marker 恢复与释放 |
| `contrib/colorPicker/browser/colorPickerModel.ts` | `ColorPickerModel` | 公共成员、颜色与 presentation 事件、切换和释放生命周期与上游一致；生产由 Color Picker controller 创建并由 dialog 消费 |
| `contrib/folding/browser/foldingDecorations.ts` | `FoldingDecorationProvider` | 公共配置与装饰事务由该 provider 持有；生产链从 Folding Model 经编辑器所有者写入 TextModel，再由标准 line/block/minimap ViewPart 渲染，释放时只清理对应编辑器的装饰；折叠背景、占位符和控制图标颜色由主题 token 持有，测试覆盖配置、所有权、折叠状态和 DOM 输出 |
| `standalone/browser/standaloneEditor.ts` | `createModel`、`getModel`、`getModels`、`setModelLanguage` | 公共模型边界使用 `ITextModel`；`createModel` 委托 `standaloneCodeEditor.ts::createTextModel`，未显式给语言时按 URI 和首行推断，显式语言优先；模型注册、查询、语言事件和释放由 Standalone 测试覆盖 |
| `common/viewLayout/lineHeights.ts` | `CustomLineHeightData` | 构造参数、公开字段和 `fromDecorations` owner 与上游一致；生产由 `ViewModelImpl` 转换模型装饰，再交给 `LinesLayout`，测试覆盖视觉范围转换与配置行高倍率 |
| `common/model/pieceTreeTextBuffer/pieceTreeTextBuffer.ts` | `PieceTreeTextBuffer` | 实现 `common/model.ts` 的 `ITextBuffer` 契约；独立红黑树实现负责 1-based 查询、原子编辑与逆编辑、搜索、内容事件、BOM/EOL、快照和释放；单个码元查询不物化整行，测试覆盖跨 chunk 代理对与树不变量 |
| `common/model/pieceTreeTextBuffer/pieceTreeTextBufferBuilder.ts` | `PieceTreeTextBufferBuilder` | 保持 Builder → Factory 两阶段 owner；跨 chunk 连接 CRLF 与代理对，按主导换行选择 EOL，并把 `finish(false)` 的保留换行语义传给主缓冲区 |
| `common/services/model.ts` | `IModelService` | 人工检查：公开类型、请求参数及依赖方向；此文件不持有运行时资源。 |
| `common/model.ts` | `ITextModel` | 同名成员差异归零；模型统一持有装饰事务和 owner 查询、外部 undo/redo 入口、token/语言配置/字体/行高事件以及 ViewModel 注册生命周期，27 项测试覆盖事务回滚、事件顺序、所有者隔离、历史负载和释放 |
| `common/services/modelService.ts` | `ModelService` | 人工追踪：模型创建/注销、资源唯一性、配置失效、文本/EOL 更新及历史恢复；关闭模型缓存随服务释放的清理待验证。 |
| `common/viewLayout/lineHeights.ts` | `LineHeightsManager` | 由 `LinesLayout` 唯一持有默认行高和自定义行高范围；重叠范围取最大高度，插删行移动或收缩范围，5 项测试覆盖累计高度、范围变更和装饰转换 |
| `common/viewLayout/linesLayout.ts` | `LinesLayout` | 文件只保留行高、纵向几何与空白区职责；视区编排移回 `viewLayout.ts`，生产由布局 owner 调用，3 项直接测试与 11 项布局测试覆盖批处理、坐标、插删行、视图区间和空白区查询 |
| `standalone/browser/standaloneEditor.ts` | `create` | 创建并返回同一个 `StandaloneEditor` 实例；贡献和主题绑定完成后才由代码编辑器服务登记并触发创建事件，回调可立即使用或释放该实例。释放时从服务移除，仅隐式创建的模型随编辑器释放；Standalone 单测与真实 Chromium 输入、注册、DOM 和释放用例覆盖 |
| `standalone/browser/standaloneEditor.ts` | `getEditors` | 直接读取代码编辑器服务持有的 `ICodeEditor` 实例，`onDidCreateEditor` 回调也使用同一公开类型；与 `create` 共享对象身份和释放时机，Standalone 测试覆盖双编辑器登记、共享模型和独立释放 |
| `browser/viewParts/viewLines/viewLineOptions.ts` | `ViewLineOptions` | 公开成员差异归零；从计算后的编辑器配置和主题类型生成不可变行渲染快照，由 `ViewLines` 持有并在配置变化时比较后通知已渲染行；段落方向、制表宽度和 GPU 输入不再错误归入该类型，定向测试覆盖全部快照字段、相等比较与调用链 |
| `browser/gpu/atlas/textureAtlas.ts` | `TextureAtlas` | 删除本地 styled atlas 分支；页面查找、子像素键、空闲预热、清空事件、用量预览和统计统一由标准 atlas owner 持有，生产帧只调用标准 token metadata 入口 |
| `browser/gpu/atlas/textureAtlasPage.ts` | `TextureAtlasPage` | 删除页面 `index` 和 styled glyph API；页面以标准四元缓存键持有 OffscreenCanvas、glyph 顺序、版本与使用区域，页索引由 atlas 数组位置决定 |
| `browser/gpu/atlas/textureAtlasShelfAllocator.ts` | `TextureAtlasShelfAllocator` | 直接实现标准 `ITextureAtlasAllocator`，接收 `IRasterizedGlyph` 并输出不含本地 `advance` 字段的标准 glyph；预览与像素统计由 allocator 持有 |
| `browser/gpu/atlas/textureAtlasSlabAllocator.ts` | `TextureAtlasSlabAllocator` | 直接实现标准 `ITextureAtlasAllocator`，按 OffscreenCanvas 分配标准 glyph 并保留 slab 粒度与溢出语义；不再依赖 styled raster 接口 |
| `browser/gpu/raster/glyphRasterizer.ts` | `GlyphRasterizer` | 构造输入恢复字体大小、字体族、设备像素比和 decoration cache；公开成员、token metadata、颜色表、子像素偏移与复用 glyph 契约归零，atlas 为唯一生产调用方 |
| `browser/gpu/viewGpuContext.ts` | `ViewGpuContext` | 公开成员差异归零；`View` 唯一创建并挂载 `FastDomNode` canvas，`ctx`、共享 `device` / `deviceSync`、共享 atlas、物理尺寸、DPR 与 contentLeft 均由标准 owner 提供，RectangleRenderer 直接消费 observable；主题更新清理共享 decoration/atlas 状态，窗口级 device 在 pagehide 释放。GPU 定向测试覆盖 canvas/ARIA、observable 更新、handler/ResizeObserver 释放和 rectangle/ruler 调用链 |
| `browser/gpu/rectangleRenderer.ts` | `RectangleRenderer` | 公开成员与 `draw(ViewportData)` 契约归零；该 owner 自行清屏、写入布局与滚动 uniform、提交 rectangle pass，并在释放时注销 `ViewContext` 事件监听 |
| `browser/gpu/renderStrategy/baseRenderStrategy.ts` | `BaseRenderStrategy` | 人工检查：已通读入口、公开数据和同步状态变化；未发现本轮可复现缺陷。 |
| `browser/gpu/renderStrategy/fullFileRenderStrategy.ts` | `FullFileRenderStrategy` | 标准 `ViewportData` 更新写入文档行定位的 cell storage buffer，滚动偏移扣除 `bigNumbersDelta`，绘制从对应文档实例起点开始；配置、装饰、token、行映射和行变化统一失效 |
| `browser/gpu/renderStrategy/viewportRenderStrategy.ts` | `ViewportRenderStrategy` | 标准 `ViewportData` 更新写入视口 cell storage buffer，容量按视口增长并通过 `onDidChangeBindGroupEntries` 重建 bind group；滚动与全部视图失效事件接入同一 owner |
| `browser/viewParts/viewLinesGpu/viewLinesGpu.ts` | `ViewLinesGpu` | 构造入口、公开成员与上游归零；生产只消费 `View` 持有的 `ViewGpuContext`，上传 glyph metadata/atlas、调用标准策略并提供 GPU 行几何，不再创建 context、修改兄弟 Part DOM 或公开本地失效入口 |
| `browser/viewParts/viewLines/viewLines.ts` | `ViewLines` | 公开成员差异归零；根节点只通过 `getDomNode()` 暴露，标准 reveal 事件使用未来视口计算纵向位置，并在目标行进入 DOM 后完成横向 reveal。范围与位置几何按标准接收视图坐标，软换行不再被当成模型行；`CodeEditorWidget.revealRange` 已改经 `ViewModel` 发布事件，定向测试覆盖普通、居中滚动和软换行光标/装饰 |
| `browser/viewParts/viewZones/viewZones.ts` | `ViewZones` | 公开成员差异归零；标准 `IViewZoneChangeAccessor` 只在回调生命周期内有效，新增、重排和移除统一进入 `ViewModel.changeWhitespace`。模型到视图坐标、隐藏区、高度、最小宽度、DOM top 回调和鼠标抑制由同一 owner 持有；CodeLens 与 ZoneWidget 只调用编辑器公开 `changeViewZones`。33 项相关单测和真实 Chromium 几何/释放场景通过；零像素/零行高度允许收起，新增两个 Standalone Chromium 用例验证展开、移动、收起、块装饰与光标几何及删除 |
| `browser/viewParts/viewCursors/viewCursor.ts` | `ViewCursor` | 公开成员差异归零；光标样式、宽高和字体从计算配置读取，位置使用视图选区，token 展示在边界转换回模型坐标；完整字素、软换行、双向文本和行尾空光标仍由独立实现渲染 |
| `browser/viewParts/viewCursors/viewCursors.ts` | `ViewCursors` | 公开成员差异归零；只持有配置、焦点、只读、组合输入事件、光标 DOM 和可释放闪烁计时器。组合输入范围由 `CompositionController` 写入标准模型 decoration，不再通过 View 和 ViewCursors 的额外公开入口投影 |
| `browser/view/dynamicViewOverlay.ts` | `DynamicViewOverlay` | 人工检查：已通读短模块的入口、边界及返回值；未发现本轮可复现缺陷。 |
| `browser/viewParts/currentLineHighlight/currentLineHighlight.ts` | `CurrentLineHighlightOverlay` | 公开构造和成员契约归零；正文与边栏覆盖层共享 `ViewContext` 的配置、焦点、选区、换行坐标和释放链，主题系统提供聚焦、失焦及高对比度颜色，组件 CSS 负责状态投影。定向测试覆盖焦点、选区与正文/边栏 class，真实 Chromium 验证自定义主题切换和高对比度边框 |
| `browser/viewParts/rulers/rulers.ts` | `Rulers` | 公开成员差异归零；配置与字体变化从 `ViewContext` 读取，滚动尺寸变化触发重绘，DOM 标尺节点按数量稳定复用并随 Part 释放；CSS 使用 Ash 类名与主题 token，定向测试覆盖配置、几何、颜色、节点复用和释放 |
| `browser/viewParts/rulersGpu/rulersGpu.ts` | `RulersGpu` | 公开成员差异归零；CPU 与 GPU 路径共享同一标尺配置和主题颜色，GPU 矩形按设备像素比与文字起点更新、按数量复用并随 Part 释放，定向测试覆盖配置、主题切换、缓存和释放 |
| `browser/viewParts/blockDecorations/blockDecorations.ts` | `BlockDecorations` | 公开成员差异归零；独立 Part 读取可见装饰并持有稳定块级 DOM，配置、滚动、装饰和 View Zone 事件进入统一渲染链，组件 CSS 使用实际 Ash 类名且不拦截输入；测试覆盖块级几何、节点复用、可访问性属性和布局变化 |
| `browser/viewParts/margin/margin.ts` | `Margin` | 构造器和公开成员与上游一致；只从 `EditorLayoutInfo` 读取 content、glyph、line-number 与 decoration 几何，`View` 不再维护第二份 gutter 测量。Ash 宿主的横向滚动补偿和 CSS 变量由同一布局快照写入，真实 Chromium 验证滚动后 margin 仍固定 |
| `contrib/middleScroll/browser/middleScrollController.ts` | `MiddleScrollController` | 构造入口恢复为 `ICodeEditor`，由标准 editor contribution 注册表在首次交互前安装；滚动只通过编辑器公开位置 API，配置在触发与动画帧读取，窗口监听、动画帧和装饰节点随 contribution 释放，定向测试覆盖首次交互实例化、横纵滚动、键盘/指针结束和无障碍隐藏 |
| `browser/view/viewOverlays.ts` | `ViewOverlays` | 公开成员差异归零；动态 overlay 由同一 `Disposable` 链持有，释放时子层先释放再清除引用，真实 Widget 创建与销毁测试覆盖 DOM 和 Part 生命周期 |
| `browser/viewParts/lineNumbers/lineNumbers.ts` | `LineNumbersOverlay` | 公开成员差异归零；配置、主光标、文本行、滚动、View Zone 和行号装饰事件均进入 margin overlay 失效链，行号配置不再保留构造时快照；真实 Widget 测试覆盖相对行号随光标变化以及运行时关闭行号后的内容和 gutter 几何 |
| `browser/viewParts/selections/selections.ts` | `SelectionsOverlay` | 公开成员差异归零；配置、光标、装饰、文本行、滚动和 View Zone 事件均触发选区几何重算，逐行输出仍只由 `ContentViewOverlays` 持有且释放时清空缓存；真实 Widget 测试覆盖选区变化后的 DOM 投影 |
| `browser/viewParts/whitespace/whitespace.ts` | `WhitespaceOverlay` | 公开成员差异归零；`renderWhitespace` 从计算配置动态读取，selection 模式只在光标变化时失效，配置、装饰、文本行、滚动和 View Zone 变化进入同一覆盖层；真实 Widget 测试覆盖 selection → all 运行时切换和空白字符数量 |
| `browser/viewParts/indentGuides/indentGuides.ts` | `IndentGuidesOverlay` | 公开成员差异归零；guides 配置、主光标、装饰、语言配置、文本行、滚动和 View Zone 事件进入同一失效链，模型 tabSize 变化通过 `ViewModel` flush 更新；真实 Widget 和 ViewModel 测试覆盖逐行 guide、运行时关闭、tabSize 映射刷新与语言配置事件 |
| `browser/viewParts/linesDecorations/linesDecorations.ts` | `LinesDecorationsOverlay` | `_getDecorations` 恢复为子类可扩展的 protected owner；生产仍从统一 Decorations overlay 读取可见装饰，装饰视口测试覆盖行侧 lane、软换行和更新投影 |
| `browser/viewParts/marginDecorations/marginDecorations.ts` | `MarginViewLineDecorationsOverlay` | `_getDecorations` 恢复为 protected owner；诊断严重度、边栏 DOM 与 hover 均沿 Decorations → Margin overlay 链投影，现有装饰和诊断 hover 测试覆盖 |
| `browser/viewParts/scrollDecoration/scrollDecoration.ts` | `ScrollDecorationViewPart` | 删除本地公开 `domNode`，恢复 canonical `getDomNode()`；View 和测试均改接该入口，阴影几何、配置变化、ARIA presentation 和释放行为通过定向测试 |
| `browser/viewParts/overviewRuler/decorationsOverviewRuler.ts` | `DecorationsOverviewRuler` | 公开成员差异归零；标准光标、装饰、配置、主题、滚动和 View Zone 事件进入同一失效状态机，`prepareRender` 读取模型 decoration 后由 canvas owner 绘制 lane、光标和主题边框；canvas 保持 `aria-hidden`，29 项配置、主题、几何和投影测试通过 |
| `browser/viewParts/contentWidgets/contentWidgets.ts` | `ViewContentWidgets` | 公开成员差异归零；标准配置、装饰、flush、line mapping、行增删、滚动和 View Zone 事件进入同一 Part 失效链，构造只接收 `ViewContext + FastDomNode`。Content Widget 的测量、定位、overflow root、鼠标抑制和释放由该 owner 持有，真实 Widget API 与 Chromium 几何场景通过 |
| `contrib/codelens/browser/codelensController.ts` | `CodeLensContribution` | 公开成员差异归零且 contribution ID 恢复为 `css.editor.codeLens`；显式 `dispose()` 取消当前请求、清理模型和 Widget 引用，CodeLens provider、缓存、解析、命令与释放 7 项测试通过 |
| `contrib/message/browser/messageController.ts` | `MessageController` | 公开成员差异归零并通过标准 `registerEditorContribution` 延迟创建；消息使用编辑器公开 Widget、光标、模型和鼠标事件，ARIA alert、可见 Context Key、Markdown 链接、blur timer 与释放均由同一实例持有；只读消息调用链测试覆盖显示、关闭和释放 |
| `contrib/placeholderText/browser/placeholderTextContribution.ts` | `PlaceholderTextContribution` | 公开成员差异归零并通过标准 contribution 注册表 eager 创建；占位文本、空模型、配置、字体和布局只从 `ICodeEditor` 与 `observableCodeEditor` 读取，Overlay Widget 随 contribution 释放；真实 Widget 测试覆盖空/非空切换、padding 和 content 几何 |
| `contrib/multicursor/browser/multicursor.ts` | `SelectionHighlighter` | `ID` 与 `dispose()` 恢复且实际拆成 `editor.contrib.selectionHighlighter` owner；释放后清空装饰并移除选区/模型监听，3 项定向测试覆盖文本匹配、策略和释放后不再更新 |
| `browser/widget/codeEditor/codeEditorContributions.ts` | `CodeEditorContributions` | 所有贡献共用注册表、延迟调度、显式读取和释放；配置钩子在 View 创建前运行，安装与 Quick Diff 构造在对应阶段运行。Context Menu 依赖 `ICodeEditor` 和平台菜单服务，Clipboard 默认输入职责属于 EditContext；Widget 测试覆盖模型切换、安装失败后重绘和共享数据的模型作用域注入 |
| `common/cursor/cursorTypeOperations.ts` | `TypeOperations` | 10 个公开入口的成员和签名差异归零；Tab 区分部分选区、跨行选区与纯空白行，每个光标按自身语言配置构造自动闭合命令，组合输入替换局部窗口或选区并把结束结果交回同一组合历史修订。生产调用覆盖 `CursorsController`、`ViewController` 与文本 drop，定向测试覆盖输入、粘贴、缩进、覆盖模式、组合环绕、多光标、语言配置和一次撤销 |

## 尚未补齐的同名契约

下表第一部分保留此前的处理说明，便于追查错误判断；这些结论已经撤回，表内所有声明都需要按对应 owner 切片继续迁移。三个 Render Strategy 的路径已从错误的 `gpu/raster` 修正为上游实际的 `gpu/renderStrategy`。

| 文件 | 声明 | 此前结论（已撤回） |
| --- | --- | --- |
| `browser/controller/editContext/editContext.ts` | `AbstractEditContext` | 已进入 `ViewPart` 生命周期并统一剪贴板事件、输入路由和组合输入状态；键盘输入先由补全等 `onWillKeydown` 消费者处理，再向公共按键事件和导航控制器传递。失焦后的 `beforeinput`、键盘命令和新组合会话不进入模型事务；Widget 与 Chromium 验证正常 Enter/撤销、候选改写一次撤销、Escape/失焦取消和迟到事件拒绝；抽象层其余公开成员差异仍待收敛 |
| `browser/controller/editContext/native/nativeEditContext.ts` | `NativeEditContext` | 已进入 `View` 的 Part 生命周期，接入 `ViewContext`、视图事件、预渲染几何读取、渲染写入、按编辑器 ID 注册及跨 document 重新挂接；`handleWillCopy` / `handleWillPaste` 已由标准 Clipboard action 调用。无生产消费方的本地 `onDidSelect` 已退出；主元素和 IME textarea 的键盘事件都在当前 DOM owner 转为标准 `IKeyboardEvent`，Native `textupdate` 在组合期间转成 `ITypeData` 后进入唯一组合历史；失焦时拒绝迟到的 `textupdate`、`compositionstart` 和 copy/cut/paste，并恢复浏览器文本窗口。内部 `onDidComposition*` 名称保留用于避开 `ViewPart` 渲染生命周期方法，浏览器缓冲区和辅助阅读器的其余成员契约仍待收敛 |
| `browser/controller/editContext/native/screenReaderContentRich.ts` | `RichScreenReaderContent` | 已恢复公开名并由 `ScreenReaderSupport` 实际选择；标准内容入口由简单内容基类继承，富内容类只保留 token/bracket DOM 渲染差异，没有为成员报告添加空转发方法。运行时配置切换会创建当前实现并释放旧内容；构造契约仍待收敛 |
| `browser/controller/editContext/native/screenReaderContentSimple.ts` | `SimpleScreenReaderContent` | 已恢复公开名并实际承担简单无障碍镜像；标准 cut、paste、focus、configuration、content 和 scroll 入口已由生产 `ScreenReaderSupport` 调用。聚焦期间的 `selectionchange` 监听、节流、DOM offset 映射和释放已回到当前内容 owner，再通过 `ViewController.setSelection` 更新唯一 ViewModel 选区；分页、滚动和精确 UTF-16 快照保持原实现。构造依赖已收敛为 FastDomNode、ViewContext、ViewController 与 accessibility service 四个角色，但本地内容 child 与上游输入节点并非同一 DOM owner，因此仍待最终核对 |
| `browser/controller/editContext/native/screenReaderSupport.ts` | `ScreenReaderSupport` | 公开成员名差异已归零；由 `NativeEditContext` 持有，焦点、配置、剪切、粘贴与光标进入标准内容入口，其余 ViewPart 变化直接触发 `prepareRender` 内容同步。`EditorConfiguration` 已成为 page size 与 rich/simple 选择的唯一配置 owner，动态重建由单个可替换资源持有并释放旧内容；Support 不再持有 document selection listener，也不读取内容内部 DOM 选区状态。Ash 现有分页、DOM child 和布局 owner 保持不变，并验证 Context、ViewModel 与 Viewport 共享同一模型。构造签名仍待收敛，因此继续留在待处理表 |
| `browser/controller/editContext/textArea/textAreaEditContext.ts` | `TextAreaEditContext` | 已由 `View` 持有，接入 `ViewContext`、视图事件、渲染阶段、按编辑器 ID 注册、`getTextAreaDomNode` 和真实输入调用链；屏幕阅读器内容只由该 host 计算，系统选区请求通过 `TextAreaInput.onSelectionChangeRequest → ViewController.setSelection` 返回唯一 ViewModel。Clipboard、键盘、type 和 composition 都只中继 `TextAreaInput` 的标准语义事件，不再重复解析 DOM 载荷；内部 composition 接缝继续使用 `onDidComposition*`，因为同名的 `ViewPart.onCompositionStart/onCompositionEnd` 已属于渲染生命周期。文本窗口与其余输入成员契约仍待收敛 |
| `browser/viewParts/overlayWidgets/overlayWidgets.ts` | `ViewOverlayWidgets` | 拥有小组件 DOM、配置驱动的溢出与布局策略、最小内容宽度和生命周期；仅保留本地渲染调度依赖 |
| `browser/view/viewController.ts` | `ViewController` | 已移除 `layout`、焦点、ARIA 和辅助阅读器转发入口，只保留命令、组合输入协调、输入事件桥接和 `dispatchMouse` 选区策略；输入实例仍需从 Controller 构造阶段完全移回 `View` 后，才能继续删除其余错位公开成员 |
| `browser/viewParts/gpuMark/gpuMark.ts` | `GpuMarkOverlay` | 已由 View 接入 MarginViewOverlays，跟随 GPU 能力变化更新标记；样式使用 Ash 警告色，浏览器验证开关字体连字后的标记更新与主题颜色 |
| `browser/viewParts/decorations/decorations.ts` | `DecorationsOverlay` | 构造器、公开成员和标准模型 decoration 渲染职责与上游一致；只从 `RenderingContext` 读取视区 decoration，由 `ContentViewOverlays` 持有，生产 View 不再装配第二套 source overlay |
| `browser/viewParts/editorScrollbar/editorScrollbar.ts` | `EditorScrollbar` | 已恢复公开名并接入 `ViewPart` 事件与释放链 |
| `browser/viewParts/glyphMargin/glyphMargin.ts` | `GlyphMarginWidgets` | 构造只接收 `ViewContext`；共享 `DecorationToRender`、`LineDecorationToRender`、`VisibleLineDecorationsToRender` 与 `DedupOverlay` 供标准 model decoration 和 caller widget 使用，不再读取 browser source |
| `browser/viewParts/minimap/minimap.ts` | `Minimap` | 已恢复公开名并接入 `ViewPart` 事件与释放链 |
| `browser/viewParts/overviewRuler/overviewRuler.ts` | `OverviewRuler` | 已接通标准 `IOverviewRuler`：`CodeEditorWidget.createOverviewRuler → View.createOverviewRuler → OverviewRuler`，canvas、zone manager、layout、DPR/lineHeight 更新及 context 注销均由该 owner 持有 |
| `browser/viewParts/viewLines/viewLine.ts` | `ViewLine` | 类成员名差异归零；单行独立持有 DOM、字符映射、宽度缓存、等宽假设校验和范围测量，调用方不再读取内部文本节点；渲染参数签名仍需随标准 `ViewportData` 输入继续收敛 |
| `browser/widget/diffEditor/diffEditorWidget.ts` | `DiffEditorWidget` | 本地只读虚拟化审阅面板改为 `EditorDiffWidget` |
| `browser/widget/multiDiffEditor/multiDiffEditorWidget.ts` | `MultiDiffEditorWidget` | 本地多文件审阅面板改为 `EditorMultiDiffWidget` |
| `common/services/languageService.ts` | `LanguageService` | 已按上游契约对齐 |
| `common/services/languageFeatures.ts` | `ILanguageFeaturesService` | 本地 provider 集合契约改为 `IEditorLanguageFeaturesService` |
| `common/services/languageFeaturesService.ts` | `LanguageFeaturesService` | 本地 provider registry 改为 `EditorLanguageFeaturesService` |
| `common/viewLayout/viewLayout.ts` | `ViewLayout` | View Zone 的并行 map、`addViewZone` / `changeViewZone` / `removeViewZone` / `getViewZoneLayout` 已删除，标准 whitespace 同时决定纵向空间和最小内容宽度；仍多出 `layout`、`lineCount`、`onDidChange`、`setLineHeight`、`setViewportSize` 及两个零基行坐标入口，需等待 View/Widget 调用方迁完后收敛 |
| `common/cursor/cursorTypeEditOperations.ts` | `TypeWithoutInterceptorsOperation` | 只拥有无拦截输入的编辑构造；结果选区由标准 `ICommand` 收集和 `CursorsController` 事务归一化，不再依赖仅本地编辑命令协议 |
| `common/cursor/cursorTypeEditOperations.ts` | `AutoClosingOvertypeOperation` | 只根据自动闭合来源和当前位置构造覆盖命令；多光标、完整字素和物理行边界由本地行为测试直接验证，不要求复刻上游私有执行阶段 |
| `contrib/colorPicker/browser/colorPickerWidget.ts` | `ColorPickerWidget` | 本地职责已改名或移出上游 owner |
| `contrib/peekView/browser/peekView.ts` | `PeekViewWidget` | 本地职责已改名或移出上游 owner |
| `contrib/codeAction/browser/codeActionController.ts` | `CodeActionController` | 同路径贡献负责本地 Code Action 菜单；内容变化只在菜单拥有焦点时恢复所属输入节点，避免共享模型的另一编辑器抢焦点。菜单的其余公开契约仍待 Code Action 分部验收 |
| `contrib/codelens/browser/codelensWidget.ts` | `CodeLensWidget` | 本地 contribution Widget 改为 `EditorCodeLensWidget` |
| `contrib/colorPicker/browser/colorDetector.ts` | `ColorDetector` | 已恢复上游公开名；颜色 provider 结果写入标准 before decoration，动态 class ref 先于 CSS owner 释放，注入 marker 由标准鼠标目标读取 |
| `contrib/find/browser/findController.ts` | `FindController` | 本地 contribution 实现改为 `EditorFindController` |
| `contrib/folding/browser/folding.ts` | `FoldingController` | 本地 contribution 实现改为 `EditorFoldingController` |
| `contrib/inlayHints/browser/inlayHintsController.ts` | `InlayHintsController` | 本地 contribution 实现改为 `EditorInlayHintsController` |
| `contrib/inlineCompletions/browser/controller/inlineCompletionsController.ts` | `InlineCompletionsController` | 本地 contribution 实现改为 `EditorInlineCompletionsController` |
| `contrib/stickyScroll/browser/stickyScrollController.ts` | `StickyScrollController` | 人工检查：DOM 与订阅由 controller 清理，字面文字写入 textContent；每次布局重建按钮的焦点保留待验证。 |
| `contrib/suggest/browser/suggestController.ts` | `SuggestController` | 本地 contribution 实现改为 `EditorSuggestController` |

### 原待处理项

| 文件 | 声明 | 分类 |
| --- | --- | --- |
| `browser/view.ts` | `View` | 根节点已从仅本地 `element` 迁为标准 `domNode`，40 余个 Editor/Workbench 调用方全部改接；焦点、Widget 焦点、ARIA、辅助阅读器、强制渲染、行宽缓存与 `onWillCopy` / `onWillCut` / `onWillPaste` 已回到该 owner。输入实例当前仍由 Controller 构造回调建立，需继续迁回 `View` 后再计为完成 |
| `browser/widget/codeEditor/codeEditorWidget.ts` | `CodeEditorWidget` | 已接通标准 editor contribution 注册表与滚动、配置 API；`setModel`、`onWillChangeModel`、`onDidChangeModel` 和模型装饰事件沿同一 Widget 的可替换模型资源生效，根 DOM、注册身份、外部 Widget 与装饰集合句柄保持稳定，旧 View/worker/贡献/监听释放。`setValue` 直接进入模型重置，同值写入也发布新版本；Standalone 处理隐式模型所有权，单测及 Chromium 验证共享模型、输入、焦点、事件、空模型、错误恢复与释放。Widget 仍有其他公开成员差异，按对应行为分部继续处理 |
| `common/cursor/cursor.ts` | `CursorsController` | 已恢复上游公开名；文档 undo/redo 已回到 `TextModel`，标准 Cursor Undo 已改走 `ICodeEditor` 事件，自动闭合和组合输入结果已改为内部会话状态，仅测试调用的 `beginComposition` / `CompositionSession` 平行入口已移除。多光标 Alt 点选、同位取消及一次键入两个位置由 owner 与 Chromium 验证，模型只提交一个版本，另一编辑器选区隔离。成员差异由 12 项降至 8 项；View、EditContext、ScreenReaderSupport、Anchor Select、In-place Replace、Line Selection、Selection Highlighter 和 14 个只读写选区的 contribution controller 已改走 `IViewModel` 或 `ICodeEditor`。Editor 内仍有 9 个外部生产调用方，剩余链涉及编辑事务、光标历史、只读事件、仅 Ash 文件和装配契约，不能按成员差异直接删除或包一层转发 |
| `common/cursor/cursorDeleteOperations.ts` | `DeleteOperations` | 4 个公开入口的成员边界比较为 0，已恢复 `CursorConfiguration`、`Selection[]`、`ICommand`、`EditOperationResult` 和自动闭合范围语义；浏览器删除、语言成对删除与剪贴板剪切均通过 `CursorsController.executeCommands` 进入模型事务，连续同向删除由 `pushUndoStop` 和 `EditOperationType` 控制撤销边界 |
| `common/model/textModel.ts` | `TextModel` | 1.1–1.5 已验收：编辑范围按 UTF-16 边界约束，失败不留半次提交；同值重置推进版本，快照可读，undo/redo 恢复选区；行 ID 预检和普通、结构文档映射已覆盖。创建时的大文件分级尊重设置，整份读取受堆预算限制而快照可继续读取。其余公开成员与私有 owner 仍待随其他分部核对 |

| `contrib/suggest/browser/suggestModel.ts` | `SuggestModel` | 补全会话迁入浏览器层并消费 `ICodeEditor`；模型切换取消请求，只读接受无副作用。完整触发、请求调度与公开事件契约仍需按补全部分验收 |
| `contrib/snippet/browser/snippetSession.ts` | `SnippetSession` | 片段导航、选项和转换经 `ICodeEditor` 执行，Tab/Shift+Tab 保持独立撤销边界；完整片段合并、插入选项与公开契约仍待验收 |

## 当前已验证能力

- 当前 80 项严格完成项均已进入生产调用链并核对 owner 与生命周期，或属于已验证不会进入生产创建链的诊断工具；“类名已改名”“成员数量相同”或“本地实现能工作”都不作为完成依据。
- Standalone 模型创建现在由 `standaloneCodeEditor.ts::createTextModel` 统一决定语言：显式语言优先，否则读取 URI 与第一行；Model Service 仍是模型注册、查询、语言事件和释放 owner。
- Code 模式入口只加载行式编辑 bundle，Academic 模式入口只加载文档格式与协作 bundle；独立浏览器入口验证真实 pane 中的贡献激活、模式隔离和销毁。Academic 工具栏与重复成员操作的监听由贡献持有并释放，销毁后的异步成员结果不再更新 DOM。
- 同一 `CodeEditorWidget` 已支持 `setModel` 切换与 `null` 拆除，`View` 复用 Widget 拥有的稳定根 DOM；每次挂接的 ViewModel、View、worker、输入和贡献由模型资源集合释放。Observable facade 重绑内容与装饰，调用方 Widget 和装饰集合句柄继续可用；Standalone 在切走隐式模型后释放它。完整 Widget 公开成员仍待按视图、输入和宿主行为分别验收。
- `IClipboardPasteEvent`、`ColumnSelection`、`ColorPickerModel` 已分别通过真实输入、鼠标列选和 Color Picker 生产调用链复核。
- `cursorColumns.ts`、`base/common/charCode.ts`、`base/common/uint.ts` 已作为后续 Cursor 迁移的同路径基础能力落地；它们不计入 119 项完成数。
- `ITextModel` 的公开成员、内部历史入口和 ViewModel 生命周期已对齐；`TextModel` 现在唯一持有 decoration range、owner 隔离、模型部件事件与 tokenization/bracket pairs 调度。实现类仍需继续统一私有 owner，因此 `TextModel` 声明本身尚未计入完成数。
- `LineNumbersOverlay`、`SelectionsOverlay`、`WhitespaceOverlay` 与 `IndentGuidesOverlay` 的公开成员差异归零；配置不再由各 Part 保存构造时快照，`CodeEditorWidget` 的标准配置 API 驱动 `EditorConfiguration → ViewModel → ViewContext`，模型 tabSize 与语言配置变化也进入对应视图事件。

## 待处理 owner 顺序

| 顺序 | 所有权切片 | 当前问题 | 闭环条件 |
| --- | --- | --- | --- |
| 1 | Platform 配置与语言身份 | 配置注册表已由标准 `Registry.as(...Extensions.Configuration)` 唯一持有，24 个配置声明、服务与 UI 调用文件不再导入并行 `ConfigurationsRegistry` 单例；配置节点/默认 override、Modes Registry、语言实例 Registry 和语言配置 Registry 仍未形成完整上游链，现有语言配置服务有 28 个生产调用方 | 继续统一标准配置节点和 override，再迁移语言身份和语言配置调用方，删除旧 owner |
| 2 | TextModel parts | `ITextModel` 成员、模型部件事件和 ViewModel 注册链已闭合；实现类仍保留 Ash 文档块、行身份与历史能力，并与上游私有阶段存在差异 | 明确这些 Ash 能力在同一 TextModel 内的长期边界，继续统一基础模型私有 owner，不为私有常量或字段制造同名壳 |
| 3 | ViewModel 与 Cursor | 生产构造链已收敛为 `CodeEditorWidget → ViewModel → View`；行映射、坐标转换、光标、布局、装饰和事件只有一份，`ViewModelLinesFromProjectedModel` 只由 `ViewModel` 创建。当前缺口是输入与 contribution 仍通过内部光标执行器工作，Widget 还保留获取该执行器的内部入口 | 将选择、输入、组合输入、命令执行和只读事件逐项改为 `ViewModel` 契约，删除内部执行器入口；相关调用方完成迁移后再把本切片计为完成 |
| 4 | ViewContext、ViewPart 与 View | `ViewContext → ViewPart → View` 生命周期已经接通，内容/margin 覆盖层统一逐行 DOM，块装饰和光标回到独立 Part；标准渲染上下文与 DOM/GPU `IViewLines` 几何已接通。当前缺口只剩两个输入实现尚未进入同一 Part 渲染阶段 | 迁移输入 Part，不保留第二套调度框架 |
| 5 | CodeEditor Widget 与服务 | `CodeEditorWidget`、`ICodeEditor`、编辑器服务和 contribution 生命周期不完整；Workbench 仍导入缺失的 Diff/MultiDiff canonical export | Widget、服务、贡献初始化、model attach/detach、view state 和公开对象身份同批闭环 |
| 6 | GPU 与 Editor contribution | GPU context、atlas、page、allocator、glyph rasterizer、两个 strategy、RectangleRenderer 与 ViewLinesGpu 已统一到标准 buffer/atlas 链；19 个 contribution 仍通过改成 `Editor*` 隐藏同路径声明缺口 | GPU 基础链已闭合，后续按各自 Widget/服务 owner 迁移 contribution |

## 验证状态

- 文件集合审计：395 个同路径、0 个大小写错误、199 个仅本地、338 个仅上游；Ash 594 个生产文件，VS Code 733 个。该结果只说明路径集合，不说明同路径文件的职责和 API 已一致。
- 121 项账本：80 项已处理、41 项待处理、总计 121 个唯一声明。
- `tsconfig.test.json` 编译通过；`MoveOperations` 的 17 个标准入口通过 12 项定向行为测试，真实 `CodeEditorWidget` 连续向下移动测试证明短行后的可视列余量能够恢复。`tsconfig.json --noEmit` 仍只报既有 Electron、Embedded Editor、BrowserView、Workbench 与 TextMate 基线错误，本批文件无新增类型错误。
- Editor 浏览器测试 TypeScript 已编译通过；GPU Chromium 用例通过，证明 WGSL pipeline、Rectangle clear pass、ViewLinesGpu load pass、编辑与 undo 的真实帧链可用。本批 Widget、pointer、decoration 与 CodeEditorWidget 相关 40 项单测全部通过；Decoration owner 本批另有 25 项聚焦单测通过，真实 Chromium 验证标准 inline、whole-line、collapsed decoration 的非零几何和删除重绘。View Zone 场景精确验证 4 行 × 18px + 500px 空白区高度、1200px 最小宽度及移除后恢复，Widget 场景验证 Content Widget 非零几何、Glyph Widget 跨行迁移、模型 decoration z-index winner 和释放。全量浏览器入口仍有既有 Academic 多行键入、旧 token/语法分析断言和旧 minimap slider 断言，不通过兼容文件恢复退场 API。
- Editor 完整单测运行到 882 项时为 845 项通过、11 项失败；`codeEditorPane.test.js` 挂起约 4 分钟后终止，后续 26 项被取消。失败覆盖 Cursor Undo/Redo、Folding、Join Lines、输入事件次数、占位符几何、字体配置和换行符等既有基线，本批 4 个定向用例均通过。
- 当前行高亮的 Widget 行为测试和主题 token 测试通过；真实 Chromium 验证普通主题下聚焦/失焦背景分别读取对应 token，高对比度主题使用 `1px` 语义边框。Editor 根 DOM 和组件 CSS 已统一使用 `.stanza-editor`，不再依赖上游产品 class，并由架构测试守住该边界。完整设计 token 门禁仍被范围外 `multiDiffEditorPane.css` 使用未注册的 `--ash-widget-background` 阻断，本批新增变量均已注册。
- 本轮 `findController`、canonical comment actions、canonical drop 事件与 controller、completion enablement 共 19 条定向断言通过；`tsconfig.test.json --noEmit` 通过。整份 `codeEditorWidget.test.ts` 仍有既有 placeholder 几何 1px 波动，相关 drop / shared-event 3 条测试按测试名独立通过。
- View overlay、行/边栏装饰、Scroll Decoration、CodeLens、Message 和 Selection Highlighter 本轮共 23 条定向断言通过；成员审计的精确项由 12 增至 19，差异项由 63 降至 56。泄漏审计确认 DOM 监听均走可释放入口，重复 blur timer 改为单实例持有。
- View DOM owner、焦点/ARIA、Suggest、Clipboard、CopyPasteController、CodeLens、Selection/Word Highlight 与 Linked Editing 共 60 条相关断言通过；`tsconfig.test.json --noEmit` 和 Stanza 类型检查通过。文件/API 扫描与账本校验在本批结束时复跑。本批没有修改 CSS。
- 本批 `typecheck:stanza`、`tsconfig.test.json` 和浏览器测试 TypeScript 编译通过；模型 language/resource owner 4 项聚焦测试通过。Chromium 的 Rust syntax/diagnostics/folding/symbols、gutter 顺序与横向滚动固定、标准 line/block decoration 三个场景全部通过。本批没有修改 CSS。
- 鼠标目标批次的 Stanza 类型检查、测试类型检查和测试编译通过；坐标/指针、Widget、Context Menu、Middle Scroll、Color Picker、CodeLens、Folding 与 Debug 共 56 项聚焦测试全部通过。统一检查器当时确认对应账本、文件集合、diff 和生成文件检查通过；CSS ownership 子进程因当前大工作区 diff 超出其默认缓冲区报 `ENOBUFS`，无 diff 的全文件检查确认 55 个 CSS 中不存在上游原样副本或 `monaco-editor` 产品根。本批未修改 CSS。完整 browser 入口当前为 7/15，通过项和失败项继续按既有基线分别处理，失败仍集中在 Academic 多行输入、undo、18/20px 光标断言、旧 diagnostics/minimap/gutter/overview-ruler DOM 断言及 GPU folding marker。
- 本轮光标历史 owner 批次的 `tsconfig.test.json` 与 Stanza 类型检查通过；common、composition、自动闭合和 contribution 聚焦测试 179 项通过。另一个 Suggest Widget 布局断言在本批 undo 调用之前失败（期望 `68px`、实际 `24px`），不通过恢复 `CursorsController.undo/redo` 掩盖。统一成员检查确认 `CursorsController` 只剩 9 项差异；CSS ownership 审计仍因当前大工作区 Git 输出触发 `ENOBUFS`，本批没有修改 CSS。
- Cursor Undo 端口批次的 Stanza 与测试类型检查通过；Cursor Undo、Linked Editing、Message、Inline Completions、Observable Editor 和真实 CodeEditorWidget 共 43 项聚焦测试通过，覆盖完整 cursor event、同版本 undo/redo、模型变化失效和下游事件消费。本批没有新增交互、快捷键、焦点目标或视觉表面，既有 `Ctrl/Cmd+U` 键盘路径保持不变，无需新增 accessibility help 或样式。
- Overview Ruler 批次的 Stanza 与测试 TypeScript 编译通过；成员比较从 3 项差异降为 0，配置、装饰 canvas、标准 zone geometry 和主题共 29 项聚焦测试通过。本批没有修改 CSS；canvas 继续从无障碍树隐藏，没有新增焦点目标、快捷键或可操作控件。包含 User Theme 的扩展定向集合仍有 2 个既有颜色序列化断言失败（旧断言期望十六进制 alpha，当前返回 `rgba()`；序列化后的 `rgba()` 又未被 parser 接受），失败行未在本批修改。
- 本轮 `TypeOperations`、组合会话和模型历史修订共 66 项定向测试通过；覆盖模式组合结束与组合环绕均在一次撤销内恢复原文。CSS ownership 审计工具已能处理当前大工作树，并只报告 9 个未触及的 branding-equivalent 历史债务，没有新增上游品牌引用或本批阻断项。
- 输入与选区端口批次的 Stanza 类型检查和 `tsconfig.test.json` 编译通过。三组精确 Node 运行分别为 17、33、67 项通过，其中 history 的 13 项在两组中重复执行；覆盖 ViewModel owner、Anchor Select、Line Selection、CodeEditorWidget、TextArea/Native EditContext、组合输入、word delete、in-place replace、选区事件和模型历史。真实 Chromium 的公开输入/撤销/保存链及无障碍契约 2 项通过。结构门禁仍为 392 个同路径、0 个大小写错误、205 个仅本地、337 个仅上游；CSS 审计没有新增上游品牌引用或本批等价复制，`CursorsController` 保持 9 项差异并继续留在待处理表。
- Native 辅助阅读端口的 Stanza、测试和浏览器 TypeScript 编译通过；完整 `codeEditorWidget.test.ts` 32 项及 `editorConfiguration.test.ts` 11 项通过。新增用例覆盖简单与富内容分支、内容随模型更新、失焦清理、模型 owner 错配拒绝、simple/rich DOM 选区回写和监听释放，以及 `CodeEditorWidget → View → NativeEditContext → ScreenReaderSupport` 的运行时配置切换和旧 DOM 释放。真实 Chromium 的 WCAG/ARIA 场景 1 项同时验证焦点后的简单内容、simple/rich 系统选区回到公开 editor selection、rich 切换、旧节点释放和切回简单内容；先前公开输入/撤销链 1 项保持通过。成员检查器现在解析 Editor 范围内的继承，并按声明 owner 比较：继承可以满足上游声明，但基类额外成员不会重复算到每个子类，也不需要添加只调用 `super` 的包装方法；脚本与 CSS ownership 共 6 项回归测试通过。结构门禁保持 10 个精确成员项、28 个差异项；CSS ownership 仍为 0 个新增上游品牌引用、0 个本批等价复制，本批没有修改 CSS。
- TextArea 系统选区与剪贴板端口的 Stanza、测试和浏览器 TypeScript 编译通过；`TextAreaInput` / `TextAreaState` 9 项、完整 `codeEditorWidget.test.ts` 43 项和真实 Chromium textarea fallback 2 项通过。用例覆盖 host 屏幕阅读器状态、方向无关 offset 映射、LF 投影返回 CRLF 模型、聚焦期间系统光标回写、composition blur、失焦/dispose 释放，以及 copy/paste/cut 从 DOM 事件到 `TextAreaInput` 语义事件再到模型事务的完整链。`AbstractEditContext`、Native 与 TextArea 的无消费 `onDidSelect` 双轨，TextArea 外层重复 selection/clipboard 映射和额外公开连接入口已退出；`beforeinput/input` 仍承担 Ash 当前 keybinding 缺口，未为成员名强行迁移。结构门禁保持 392 个同路径、0 个大小写错误、205 个仅本地、337 个仅上游，CSS ownership 没有新增上游品牌引用或本批等价复制，本批没有修改 CSS。
- Cursor 组合输入端口批次移除了生产调用方为 0 的 `beginComposition`、`CompositionSession` 与对应私有更新链，测试改为直接经过标准 `startComposition`、`compositionType`、`endComposition`。外部模型修改和 Cursor 释放现在都会结束唯一的 `TextModel` 历史修订，避免后续组合输入被残留 revision 阻塞；组合替换、换行归一化、一次撤销、零历史预算、无修改、外部修改、释放和多光标等 56 项聚焦测试通过。成员审计确认 `CursorsController` 差异由 9 项降至 8 项，本批没有修改 CSS、DOM 或 contribution 文件。
- 键盘、type 与 composition 端口批次把 TextArea 与 Native 两个 DOM owner 的原始 `keydown/keyup` 就地转为 `IKeyboardEvent`，通过标准 `onKeyDown/onKeyUp` 进入公共 Editor 事件；Textarea 普通文本和组合替换、Native 组合 `textupdate` 都通过 `ITypeData` 进入同一个 `CompositionController`，composition lifecycle 则使用标准 data/void 载荷。测试覆盖 TextArea/Native 原始键盘事件身份、释放、公共事件阻止、普通 type 顺序、组合文本内部光标、Native textupdate、decoration 和一次撤销；Stanza、测试 TypeScript 编译及三份聚焦测试共 49 项通过，真实 Chromium textarea fallback 1 项同时验证普通键入、组合内部光标、生命周期 class 和一次撤销。完整浏览器基线为 11/18，7 个失败仍是此前记录的 Academic 多行输入、18/20px 光标、diagnostics/minimap/gutter/overview-ruler 和 GPU folding marker。本批没有修改 CSS、DOM 层级、焦点目标、快捷键或 contribution。
- Platform 配置入口批次保留 Ash 现有解析、持久化和事件实现，只把同路径 `configurationRegistry.ts` 注册到标准 `Registry` 的 `Extensions.Configuration` owner，并让 24 个配置声明、服务、Settings/List/Sash/Workbench 消费文件统一经 `IConfigurationRegistry` 取得同一实例；旧 `ConfigurationsRegistry` 导出与引用均为 0，没有增加包装层或第二份状态。Stanza 与测试 TypeScript 编译通过，配置默认值、更新事件、语言 override、Settings、List、Sash 和 Workbench 共 40 项定向测试通过。完整标准配置节点、默认 override 与语言 Registry 仍留在顺序 1，不把本批计为整个配置系统完成。
- Language Features Registry 批次的 Stanza 与测试 TypeScript 编译通过；Workbench Registry 分离、App Server、Extension Host、语义 token、通用 Registry 和 Standalone 共 31 项相关测试通过，其中 Extension Host 为 5/5，App Server 为 4/8。App Server 剩余 4 项均由测试模型仍为 `plaintext`、却按 `typescript` 查询 Registry 触发，涉及 definition、rename 和权限刷新，不在本批格式化/参数提示/语义 token 改动内。统一结构检查确认成员差异总项由 28 降至 27、旧 Registry 字段引用为 0、没有新增上游品牌引用或等价 CSS，本批未修改 CSS。完整 ModelService 与 BrowserTextModelService 测试仍分别有 1 个 EOL 基线失败和 3 个 undo/EOL 基线失败；Editor 架构入口仍有 10 个已记录的旧文件/owner 断言失败，均未通过恢复旧文件或修改范围外实现规避。
- Selection contribution 批次只迁移已经证明仅需读取、提交或监听选区的 14 个生产 controller：Bracket Match/Navigation、Diagnostics、Symbol/Language Navigation、Format、Parameter Hints、Go to Line、Smart Select、Occurrence/Multi Cursor、Rename、Language Hierarchy 和 Color Picker。它们直接改接现有 `ICodeEditor` 或 `IViewModel`，旧 `CursorsController` import 为 0，选区来源字符串、模型一致性检查和原有快捷键/显示逻辑保留；没有新建文件，没有修改 CSS、DOM、焦点目标或快捷键。Stanza 与测试 TypeScript 检查通过，16 项 controller 定向测试和 39 项 Smart Select、语言跳转、`CodeEditorWidget` 集成测试通过。结构门禁保持 392 个同路径、0 个大小写错误、205 个仅本地、337 个仅上游，账本仍为 80 项已处理、39 项待处理；Editor 内 `CursorsController` 引用由 31 个生产文件降至 17 个，剩余项不在本批伪造兼容入口。
- Selection Highlighter 批次在双方同路径 `contrib/multicursor/browser/multicursor.ts` 原地把选区读取和监听改接 `ICodeEditor`，文本查找与 decoration 生命周期继续由现有模型和 `TextDecorationCollection` 持有；生产装配同步改接 `context.editor`。测试不再手写 Editor 假对象或注入第二份选区 controller，而是通过真实 `CodeEditorWidget` 触发标准选区事件。Stanza、测试 TypeScript 检查和 47 项 Multi Cursor/Selection Highlighter/Widget 测试通过；没有新建文件，也没有修改 CSS、DOM、ARIA、焦点或快捷键。Editor 内 `CursorsController` 引用由 17 个生产文件降至 16 个。Suggest 浏览器文件虽为同路径，但仍被仅 Ash `chatInputEditor.ts` 和补全会话链直接构造，本批保持不动，未添加兼容构造函数或修改仅 Ash 调用方。
- 下一批按上表 owner 顺序推进；只有完成生产调用方迁移、删除旧入口并通过相关测试后，才会从 80 项中继续扣减。
