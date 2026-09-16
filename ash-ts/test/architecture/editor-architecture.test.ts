import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "mocha";
import { findDesktopRoot } from "./testPaths.js";

const desktopRoot = findDesktopRoot(import.meta.dirname);
const editorRoot = resolve(desktopRoot, "src/ash/editor");
const workbenchRoot = resolve(desktopRoot, "src/ash/workbench");
const workbenchImportPattern = /(?:from\s+|import\s*(?:\(\s*)?)["'][^"']*\/workbench\/[^"']*["']/u;

test("Editor keeps explicit feature files without index barrels", () => {
	const indexFiles = collectFiles(editorRoot).filter(file => file.endsWith("\\index.ts") || file.endsWith("/index.ts"));
	assert.deepEqual(indexFiles, []);
});

test("Cursor operations keep one canonical owner", () => {
	assert.deepEqual(readdirSync(join(editorRoot, "common/cursor")).sort(), [
		"cursor.ts",
		"cursorAtomicMoveOperations.ts",
		"cursorCollection.ts",
		"cursorColumnSelection.ts",
		"cursorContext.ts",
		"cursorDeleteOperations.ts",
		"cursorMoveCommands.ts",
		"cursorMoveOperations.ts",
		"cursorTypeEditOperations.ts",
		"cursorTypeOperations.ts",
		"cursorWordOperations.ts",
		"oneCursor.ts",
	]);
});

test('Cursor owner files expose their canonical API names', () => {
	const expectedClasses = new Map([
		['cursor.ts', 'CursorsController'],
		['cursorAtomicMoveOperations.ts', 'AtomicTabMoveOperations'],
		['cursorCollection.ts', 'CursorCollection'],
		['cursorColumnSelection.ts', 'ColumnSelection'],
		['cursorContext.ts', 'CursorContext'],
		['cursorDeleteOperations.ts', 'DeleteOperations'],
		['cursorMoveCommands.ts', 'CursorMoveCommands'],
		['cursorMoveOperations.ts', 'MoveOperations'],
		['cursorTypeOperations.ts', 'TypeOperations'],
		['cursorWordOperations.ts', 'WordOperations'],
		['oneCursor.ts', 'Cursor'],
	]);
	for (const [file, className] of expectedClasses) {
		const source = readFileSync(join(editorRoot, 'common/cursor', file), 'utf8');
		assert.match(source, new RegExp(`export (?:abstract )?class ${className}\\b`, 'u'), file);
	}
	const typeEditOperations = readFileSync(join(editorRoot, 'common/cursor/cursorTypeEditOperations.ts'), 'utf8');
	assert.match(typeEditOperations, /export class TypeWithoutInterceptorsOperation\b/u);
	assert.match(typeEditOperations, /export class AutoClosingOvertypeOperation\b/u);
	const cursorSources = collectFiles(join(editorRoot, 'common/cursor')).map(file => readFileSync(file, 'utf8')).join('\n');
	assert.doesNotMatch(cursorSources, /export (?:class|function|interface|type|enum) (?:EditorSelectionController|createEditorColumnSelectionSet|navigateEditorCursors|createTypeTextCommand|createBackspaceCommand)\b/u);
});

test("Editor production code does not depend on Workbench or generated transport DTOs", () => {
	for (const file of collectFiles(editorRoot)) {
		if (!file.endsWith(".ts") || isTestFile(file)) continue;
		const source = readFileSync(file, "utf8");
		assert.doesNotMatch(source, workbenchImportPattern, relative(editorRoot, file));
		assert.doesNotMatch(source, /from\s+["'][^"']*app-server\/common\/generated[^"']*["']/u, relative(editorRoot, file));
		assert.doesNotMatch(source, /from\s+["'][^"']*platform\/(?:syntax|diff)\/[^"']*["']/u, relative(editorRoot, file));
	}
});

test('Editor dependency checks distinguish layer paths from Platform filenames', () => {
	assert.doesNotMatch("import { editorBackground } from '../../../platform/theme/common/colors/workbenchColors.js';", workbenchImportPattern);
	assert.match("import { EditorPart } from '../../../workbench/browser/parts/editor/editorPart.js';", workbenchImportPattern);
	assert.match("import '../../../workbench/browser/workbench.contribution.js';", workbenchImportPattern);
	assert.match("await import('../../../workbench/browser/workbench.js');", workbenchImportPattern);
});

test("Bracket structure, cursor editing, and browser presentation keep separate owners", () => {
	for (const file of [
		"common/languages/languageBracketPairs.ts",
		"common/cursor/cursor.ts",
		"common/cursor/cursorTypeOperations.ts",
		"common/cursor/cursorTypeEditOperations.ts",
		"browser/view/viewController.ts",
	]) assert.equal(existsSync(join(editorRoot, file)), true, file);
	for (const file of [
		"contrib/bracketMatching/common/bracketMatching.ts",
		"contrib/bracketMatching/common/bracketColorization.ts",
		"contrib/bracketMatching/common/autoClosingTracker.ts",
		"contrib/bracketMatching/common/pairEditing.ts",
		"contrib/bracketMatching/common/enter.ts",
		"contrib/bracketMatching/browser/languageEditingAdapter.ts",
	]) assert.equal(existsSync(join(editorRoot, file)), false, file);
	const contribution = readFileSync(join(editorRoot, "contrib/bracketMatching/browser/bracketMatching.contribution.ts"), "utf8");
	assert.match(contribution, /LanguageBracketPairs/u);
	assert.doesNotMatch(contribution, /LanguageLexicalContextIndex|TokenAwareLanguageLexicalContext|LanguageEditingAdapter|LanguageAutoClosingTracker/u);
	const adapter = readFileSync(join(editorRoot, "browser/view/viewController.ts"), "utf8");
	assert.match(adapter, /common\/cursor\/cursorTypeOperations/u);
	assert.doesNotMatch(adapter, /\/contrib\//u);
});

test("Workbench owns App Server language, diff, and text-model adapters", () => {
	for (const file of [
		"services/language/browser/appServerSyntaxProviders.ts",
		"services/diff/browser/appServerDiffService.ts",
		"services/diff/browser/appServerDiffComputationService.ts",
		"services/textmodelResolver/browser/browserTextModelService.ts",
	]) assert.equal(statSafe(join(workbenchRoot, file)), true, file);
});

test("Editor synchronous layers do not import Electron or generated DTOs", () => {
	const protectedDirectories = [
		"common/config",
		"common/core",
		"common/model",
		"common/cursor",
		"common/commands",
		"common/viewLayout",
		"common/viewModel",
	];
	for (const directory of protectedDirectories) {
		for (const file of collectFiles(join(editorRoot, directory))) {
			if (!file.endsWith(".ts")) continue;
			const source = readFileSync(file, "utf8");
			assert.doesNotMatch(source, /from\s+["'][^"']*(?:electron|generated)[^"']*["']/u, relative(editorRoot, file));
		}
	}
});

test("Flat editor layout keeps one TextModel owner and both mode bundles", () => {
	const requiredFiles = [
		"browser/controller/dragScrolling.ts",
		"browser/view/dynamicViewOverlay.ts",
		"browser/view/viewOverlays.ts",
		"browser/gpu/atlas/textureAtlas.ts",
		"browser/gpu/atlas/textureAtlasPage.ts",
		"browser/gpu/atlas/textureAtlasShelfAllocator.ts",
		"browser/gpu/atlas/textureAtlasSlabAllocator.ts",
		"browser/gpu/raster/glyphRasterizer.ts",
		"browser/gpu/rectangleRenderer.ts",
		"browser/gpu/renderStrategy/baseRenderStrategy.ts",
		"browser/gpu/renderStrategy/fullFileRenderStrategy.ts",
		"browser/gpu/renderStrategy/viewportRenderStrategy.ts",
		"browser/gpu/viewGpuContext.ts",
		"browser/viewParts/gpuMark/gpuMark.ts",
		"browser/viewParts/rulersGpu/rulersGpu.ts",
		"browser/viewParts/viewLinesGpu/viewLinesGpu.ts",
		"contrib/message/browser/messageController.ts",
		"contrib/indentation/browser/indentation.ts",
		"common/model/tokens/tokenizationTextModelPart.ts",
		"common/model/tokens/semanticTokensTextModelPart.ts",
		"browser/editorBrowser.ts",
		"browser/dataTransfer.ts",
		"browser/editorDom.ts",
		"browser/editorExtensions.ts",
		"browser/triggerInlineEditCommandsRegistry.ts",
		"browser/coreCommands.ts",
		"browser/widget/codeEditor/codeEditorContributions.ts",
		"browser/widget/codeEditor/codeEditorWidget.ts",
		"browser/widget/codeEditor/editor.css",
		"browser/widget/richTextEditor/richTextEditorWidget.ts",
		"browser/widget/richTextEditor/richTextEditorWidget.css",
		"browser/view/viewLayer.ts",
		"browser/view/renderingContext.ts",
		"browser/view/domLineBreaksComputer.ts",
		"browser/view/viewUserInputEvents.ts",
		"browser/view.ts",
		"browser/view/viewController.ts",
		"browser/controller/editContext/clipboardUtils.ts",
		"browser/controller/editContext/editContext.ts",
		"browser/controller/editContext/screenReaderUtils.ts",
		"browser/controller/editContext/textArea/textAreaEditContext.ts",
		"browser/controller/editContext/textArea/textAreaEditContext.css",
		"browser/controller/editContext/textArea/textAreaEditContextInput.ts",
		"browser/controller/editContext/textArea/textAreaEditContextRegistry.ts",
		"browser/controller/editContext/textArea/textAreaEditContextState.ts",
		"browser/controller/editContext/native/nativeEditContext.ts",
		"browser/controller/editContext/native/nativeEditContextUtils.ts",
		"browser/controller/editContext/native/nativeEditContextRegistry.ts",
		"browser/controller/editContext/native/editContextFactory.ts",
		"browser/controller/editContext/native/nativeEditContext.css",
		"browser/controller/editContext/native/screenReaderSupport.ts",
		"browser/controller/editContext/native/screenReaderContentSimple.ts",
		"browser/controller/editContext/native/screenReaderContentRich.ts",
		"browser/controller/editContext/native/screenReaderUtils.ts",
		"browser/services/abstractCodeEditorService.ts",
		"browser/services/codeEditorService.ts",
		"browser/services/contribution.ts",
		"browser/services/editorWorkerService.ts",
		"browser/services/inlineCompletionsService.ts",
		"browser/services/markerDecorations.ts",
		"browser/services/syntaxWorkerMain.ts",
		"browser/services/languageCompletionWorkerMain.ts",
		"common/core/position.ts",
		"common/config/diffEditor.ts",
		"common/config/editorConfigurationSchema.ts",
		"common/config/editorOptions.ts",
		"common/config/editorZoom.ts",
		"common/config/fontInfo.ts",
		"common/config/fontInfoFromSettings.ts",
		"common/model/decorationCollection.ts",
		"common/model/textModel.ts",
		"common/cursor/cursor.ts",
		"common/services/editorBaseApi.ts",
		"common/services/completionsEnablement.ts",
		"common/services/languageFeatures.ts",
		"common/services/languageFeaturesService.ts",
		"common/services/languageService.ts",
		"contrib/gotoError/browser/gotoError.ts",
		"browser/view/viewPart.ts",
		"browser/viewParts/viewLines/viewLines.ts",
		"browser/viewParts/viewLines/viewLine.ts",
		"browser/viewParts/currentLineHighlight/currentLineHighlight.ts",
		"browser/viewParts/contentWidgets/contentWidgets.ts",
		"browser/viewParts/gpuMark/gpuMark.css",
		"browser/viewParts/overlayWidgets/overlayWidgets.ts",
		"browser/viewParts/overlayWidgets/overlayWidgets.css",
		"browser/viewParts/whitespace/whitespace.ts",
		"browser/viewParts/whitespace/whitespace.css",
		"contrib/folding/browser/foldingDecorations.ts",
		"contrib/folding/browser/folding.css",
		"contrib/smartSelect/common/selectionRanges.ts",
		"contrib/symbolIcons/browser/symbolIcons.ts",
		"contrib/symbolIcons/browser/symbolIcons.css",
		"browser/viewParts/margin/margin.ts",
		"browser/viewParts/glyphMargin/glyphMargin.ts",
		"browser/viewParts/marginDecorations/marginDecorations.ts",
		"browser/viewParts/linesDecorations/linesDecorations.ts",
		"browser/viewParts/blockDecorations/blockDecorations.ts",
		"browser/viewParts/rulers/rulers.ts",
		"browser/viewParts/editorScrollbar/editorScrollbar.ts",
		"browser/viewParts/lineNumbers/lineNumbers.ts",
		"browser/viewParts/overviewRuler/decorationsOverviewRuler.ts",
		"browser/viewParts/overviewRuler/overviewRuler.ts",
		"browser/viewParts/scrollDecoration/scrollDecoration.ts",
		"browser/viewParts/minimap/minimap.ts",
		"browser/viewParts/minimap/minimapCharRenderer.ts",
		"browser/viewParts/minimap/minimapCharRendererFactory.ts",
		"browser/viewParts/minimap/minimapCharSheet.ts",
		"browser/viewParts/minimap/minimapPreBaked.ts",
		"browser/viewParts/decorations/decorations.ts",
		"browser/viewParts/indentGuides/indentGuides.ts",
		"browser/viewParts/selections/selections.ts",
		"browser/viewParts/viewCursors/viewCursors.ts",
		"browser/viewParts/viewCursors/viewCursor.ts",
		"browser/viewParts/viewZones/viewZones.ts",
		"browser/config/fontMeasurements.ts",
		"browser/config/migrateOptions.ts",
		"browser/config/charWidthReader.ts",
		"browser/config/editorConfiguration.ts",
		"browser/config/domFontInfo.ts",
		"browser/config/elementSizeObserver.ts",
		"browser/config/tabFocus.ts",
		"common/viewModel/textMeasurer.ts",
		"common/viewModel/overviewZoneManager.ts",
		"common/viewModel/viewModelLines.ts",
		"common/viewModel/rangeGeometry.ts",
		"common/viewModel/visualRangeGeometry.ts",
		"common/viewModel/visualSelectionGeometry.ts",
		"common/viewModel/visualCursorNavigation.ts",
		"common/viewModel/pointerHitTest.ts",
		"browser/viewParts/viewLines/domReadingContext.ts",
		"browser/viewParts/viewLines/rangeUtil.ts",
		"browser/viewParts/viewLines/viewLineOptions.ts",
		"common/model/textBufferFactory.ts",
		"common/model/pieceTreeTextBuffer/rbTreeBase.ts",
		"common/model/pieceTreeTextBuffer/pieceTreeBase.ts",
		"common/model/pieceTreeTextBuffer/pieceTreeTextBuffer.ts",
		"common/model/pieceTreeTextBuffer/pieceTreeTextBufferBuilder.ts",
		"common/model/lineDocument.ts",
		"common/model/textModelBlockState.ts",
		"common/model/lineDocumentProjection.ts",
		"common/viewModel.ts",
		"common/viewModel/inlineDecorations.ts",
		"common/viewLayout/lineDecorations.ts",
		"common/viewLayout/lineHeights.ts",
		"common/viewLayout/linePart.ts",
		"common/viewLayout/linesLayout.ts",
		"common/viewLayout/viewLayout.ts",
		"common/viewLayout/viewLineRenderer.ts",
		"common/viewLayout/viewLinesViewportData.ts",
		"common/services/resolverService.ts",
		"common/services/model.ts",
		"common/services/modelService.ts",
		"common/services/semanticTokensDto.ts",
		"common/services/semanticTokensProviderStyling.ts",
		"common/services/semanticTokensStyling.ts",
		"common/services/semanticTokensStylingService.ts",
		"common/services/textModelSync/textModelSync.impl.ts",
		"common/services/textModelSync/textModelSync.protocol.ts",
		"common/model/documentTransaction.ts",
		"contrib/academic/common/schema.ts",
		"editor.code.all.ts",
		"editor.academic.all.ts",
		"editor.all.ts",
		"editor.api.ts",
		"editor.main.ts",
		"standalone/browser/standaloneServices.ts",
		"standalone/browser/standaloneEditor.ts",
		"standalone/browser/standaloneCodeEditor.ts",
		"standalone/browser/standaloneLanguages.ts",
		"README.md",
		"text-engine.md",
		"document-engine.md",
	];
	assert.deepEqual(requiredFiles.filter(file => !statSafe(join(editorRoot, file))), []);

	const removedLegacyNames = [
		"browser/configuredCodeEditor.ts",
		"browser/editorInput.ts",
		"browser/editorView.ts",
		"browser/view/editorOverlayCoordinator.ts",
		"browser/view/editorDynamicViewOverlay.ts",
		"browser/controller/bidirectionalDragScrolling.ts",
		"common/languages/ownedLanguageConfigurationContributions.ts",
		"browser/viewParts/viewLinesGpu/styledViewLinesGpu.ts",
		"browser/viewParts/gpuMark/styledGpuMark.ts",
		"browser/viewParts/rulersGpu/styledRulersGpu.ts",
		"contrib/tokenization/common/languageTokenLineIndexPart.ts",
		"contrib/semanticTokens/common/semanticTokens.ts",
		"common/viewLayout/editorViewportLinesLayout.ts",

		"contrib/colorPicker/browser/colorPickerWidget.ts",
		"contrib/peekView/browser/peekView.ts",
		"browser/controller/inputController.ts",
		"browser/controller/inputCommandController.ts",
		"browser/controller/inputCompletionController.ts",
		"browser/controller/viewController.ts",
		"browser/controller/inputContracts.ts",
		"browser/input/textInputController.ts",
		"browser/input/textInputCommandController.ts",
		"browser/input/textInputCompletionController.ts",
		"browser/input/textInputContracts.ts",
		"browser/controller/textInputController.ts",
		"browser/controller/textInputCommandController.ts",
		"browser/controller/textInputCompletionController.ts",
		"browser/controller/textInputContracts.ts",
		"browser/controller/editContext/editContextController.ts",
		"browser/controller/editContext/editContextCommandController.ts",
		"browser/controller/editContext/editContextCompletionController.ts",
		"browser/controller/editContext/editContextContracts.ts",
		"browser/controller/editContext/editContextFactory.ts",
		"browser/controller/editContext/factory.ts",
		"browser/controller/compositionController.ts",
		"browser/controller/keyboardNavigationController.ts",
		"browser/controller/languageEditingAdapter.ts",
		"browser/controller/editContext/textArea/textAreaAccessibilityController.ts",
		"browser/measurement/lineWidthIndex.ts",
		"browser/media/editorViewport.css",
		"browser/view/viewPartRows.ts",
		"browser/view/viewInputController.ts",
		"browser/controller/editContext/compositionController.ts",
		"browser/controller/textAreaInput.ts",
		"browser/controller/textAreaAccessibilityController.ts",
		"browser/editorSession.ts",
		"browser/browserEditorSession.ts",
		"common/model/decoration.ts",
		"contrib/gotoError/browser/gotoErrorController.ts",
		"browser/view/renderedLine.ts",
		"browser/viewParts/viewLines/renderedLine.ts",
		"browser/viewParts/viewLines/viewLinesPart.ts",
		"contrib/symbolIcons/browser/symbolIconsController.ts",
		"contrib/symbolIcons/browser/media/symbolIcons.css",
		"browser/viewParts/viewLinesGpu/viewLinesGpu.css",
		"contrib/folding/browser/media/folding.css",
		"browser/view/editorViewport.ts",
		"browser/viewModel/visualLineProjection.ts",
		"browser/viewModel/visibleLineProjection.ts",
		"browser/view/decorationLineIndex.ts",
		"browser/view/indentationGuides.ts",
		"browser/view/lineGutterDecoration.ts",
		"browser/viewParts/margin/lineGutterDecoration.ts",
		"browser/view/diagnosticOverviewMarkers.ts",
		"browser/view/diffOverviewMarkers.ts",
		"browser/view/decorationPresentation.ts",
		"browser/view/domTextGeometry.ts",
		"browser/viewParts/viewportOverlay/domTextGeometry.ts",
		"browser/view/fontMetrics.ts",
		"browser/view/lineWidthIndex.ts",
		"browser/view/pointerHitTest.ts",
		"browser/view/rangeGeometry.ts",
		"browser/view/selectionGeometry.ts",
		"browser/view/semanticTokenPresentation.ts",
		"browser/view/viewportOverlayPresentation.ts",
		"browser/viewParts/viewportOverlay/viewportOverlayPresentation.ts",
		"browser/view/visibleLineProjection.ts",
		"browser/view/visualCursorNavigation.ts",
		"browser/view/visualLineProjection.ts",
		"browser/view/visualRangeGeometry.ts",
		"browser/view/visualSelectionGeometry.ts",
		"browser/view/minimapProjection.ts",
		"browser/view/minimapPresentation.ts",
		"browser/view/minimapNavigationController.ts",
		"browser/viewParts/minimap/minimapPart.ts",
		"browser/viewParts/minimap/minimapProjection.ts",
		"browser/viewParts/minimap/minimapPresentation.ts",
		"browser/viewParts/minimap/minimapNavigationController.ts",
		"browser/viewParts/blockDecorations/blockDecorationsPart.ts",
		"browser/viewParts/blockDecorations/blockDecorationsProjection.ts",
		"browser/viewParts/composition/compositionPart.ts",
		"browser/viewParts/composition/compositionProjection.ts",
		"browser/viewParts/composition/composition.css",
		"browser/viewParts/decorations/decorationsPart.ts",
		"browser/viewParts/decorations/decorationProjection.ts",
		"browser/viewParts/editorScrollbar/editorScrollbarPart.ts",
		"browser/viewParts/glyphMargin/glyphMarginPart.ts",
		"browser/viewParts/indentGuides/indentGuidesPart.ts",
		"browser/viewParts/indentGuides/indentationGuides.ts",
		"browser/viewParts/lineNumbers/lineNumbersPart.ts",
		"browser/viewParts/linesDecorations/linesDecorationsPart.ts",
		"browser/viewParts/linesDecorations/linesDecorationsProjection.ts",
		"browser/viewParts/margin/marginPart.ts",
		"browser/viewParts/marginDecorations/marginDecorationsPart.ts",
		"browser/viewParts/marginDecorations/marginDecorationsProjection.ts",
		"browser/viewParts/overviewRuler/overviewRulerPart.ts",
		"browser/viewParts/rulers/rulersPart.ts",
		"browser/viewParts/scrollDecoration/scrollDecorationPart.ts",
		"browser/viewParts/selections/selectionsPart.ts",
		"browser/viewParts/selections/selectionProjection.ts",
		"browser/viewParts/semanticTokens/semanticTokenPresentation.ts",
		"browser/viewParts/viewCursors/viewCursorsPart.ts",
		"browser/viewParts/viewCursors/cursorProjection.ts",
		"browser/viewParts/decorations/decorationPresentation.ts",
		"browser/viewParts/decorations/decorationLineIndex.ts",
		"browser/viewParts/minimap/minimapLayout.ts",
		"browser/viewParts/overviewRuler/diagnosticOverviewMarkers.ts",
		"browser/viewParts/overviewRuler/diffOverviewMarkers.ts",
		"browser/viewParts/viewLines/semanticTokenPresentation.ts",
		"text-engine-architecture.md",
		"text-engine-implementation-ledger.md",
		"document-engine-architecture.md",
		"browser/widget/embeddedTextEditor.ts",
		"browser/widget/codeBlockEditorWidget.ts",
		"common/model/documentModel.ts",
		"common/services/documentModelService.ts",
		"common/services/structuredTextModelService.ts",
		"common/model/textModelStructure.ts",
		"common/model/textModelStructureIndex.ts",
		"common/model/textModelBlockTree.ts",
		"common/model/textModelBlockSnapshot.ts",
		"common/viewLayout/editorViewportModel.ts",
		"contrib/academic/browser/academicCodeBlockEditor.ts",
		"browser/services/browserTextModelService.ts",
		"browser/services/rustDiffComputationService.ts",
		"browser/services/rustSyntaxFactsService.ts",
		"browser/services/rustSyntaxFoldingService.ts",
	];
	for (const file of removedLegacyNames) assert.equal(statSafe(join(editorRoot, file)), false, file);
	assert.equal(existsSync(join(editorRoot, "browser/input")), false, "legacy browser input directory");
});

test('Required editor view parts are connected to their production owners', () => {
	const editorBrowser = readFileSync(join(editorRoot, 'browser/editorBrowser.ts'), 'utf8');
	const codeEditorWidget = readFileSync(join(editorRoot, 'browser/widget/codeEditor/codeEditorWidget.ts'), 'utf8');
	const view = readFileSync(join(editorRoot, 'browser/view.ts'), 'utf8');
	const viewOverlays = readFileSync(join(editorRoot, 'browser/view/viewOverlays.ts'), 'utf8');
	const whitespace = readFileSync(join(editorRoot, 'browser/viewParts/whitespace/whitespace.ts'), 'utf8');
	const overviewRuler = readFileSync(join(editorRoot, 'browser/viewParts/overviewRuler/overviewRuler.ts'), 'utf8');
	const textureAtlas = readFileSync(join(editorRoot, 'browser/gpu/atlas/textureAtlas.ts'), 'utf8');
	const placeholder = readFileSync(join(editorRoot, 'contrib/placeholderText/browser/placeholderTextContribution.ts'), 'utf8');
	const textModel = readFileSync(join(editorRoot, 'common/model/textModel.ts'), 'utf8');
	const textModelSearch = readFileSync(join(editorRoot, 'common/model/textModelSearch.ts'), 'utf8');

	assert.match(editorBrowser, /interface IOverlayWidget[\s\S]*getId\(\)[\s\S]*getDomNode\(\)[\s\S]*getPosition\(\)/u);
	assert.match(editorBrowser, /interface IViewZoneChangeAccessor[\s\S]*addZone[\s\S]*removeZone[\s\S]*layoutZone/u);
	for (const operation of ['addOverlayWidget', 'layoutOverlayWidget', 'removeOverlayWidget']) {
		assert.match(codeEditorWidget, new RegExp(`view(?:\\?\\.)?\\.?${operation}\\(`, 'u'));
	}
	assert.match(codeEditorWidget, /view\.changeViewZones/u);
	assert.match(view, /new ViewOverlayWidgets/u);
	assert.match(view, /new RulersGpu/u);
	assert.match(view, /new ViewGpuContext/u);
	assert.match(view, /new ContentViewOverlays/u);
	assert.match(view, /new MarginViewOverlays/u);
	assert.match(viewOverlays, /addDynamicOverlay/u);
	assert.match(whitespace, /viewModel\.getCursorStates\(/u);
	assert.match(overviewRuler, /new OverviewZoneManager/u);
	assert.match(textureAtlas, /from ['"]\.\.\/taskQueue\.js['"]/u);
	assert.match(codeEditorWidget, /observableCodeEditor\(this\)/u);
	assert.match(placeholder, /observableCodeEditor\(editor\)/u);
	assert.match(textModel, /countEOL\(edit\.text\)/u);
	assert.match(textModelSearch, /getMapForWordSeparators/u);
});

test('Editor production files are entrypoints or have a production caller', () => {
	const sourceRoot = resolve(desktopRoot, 'src');
	const sourceFiles = collectFiles(sourceRoot).filter(file => file.endsWith('.ts'));
	const editorProductionFiles = sourceFiles.filter(file => file.startsWith(editorRoot) && !isTestFile(file));
	const productionIncoming = new Map(editorProductionFiles.map(file => [architecturePathKey(file), 0]));
	const testIncoming = new Map(editorProductionFiles.map(file => [architecturePathKey(file), 0]));
	const importPattern = /(?:from\s+|import\s*(?:\(\s*)?)["']([^"']+)["']/gu;

	for (const sourceFile of sourceFiles) {
		const source = readFileSync(sourceFile, 'utf8');
		for (const match of source.matchAll(importPattern)) {
			const specifier = match[1]!;
			if (!specifier.startsWith('.')) continue;
			const target = architecturePathKey(resolve(dirname(sourceFile), specifier.replace(/\.js$/u, '.ts')));
			const incoming = isTestFile(sourceFile) ? testIncoming : productionIncoming;
			if (incoming.has(target)) incoming.set(target, incoming.get(target)! + 1);
		}
	}

	const explicitEntrypoints = new Set([
		resolve(editorRoot, 'editor.main.ts'),
		resolve(editorRoot, 'common/services/editorWebWorkerMain.ts'),
		resolve(editorRoot, 'browser/services/languageCompletionWorkerMain.ts'),
		resolve(editorRoot, 'browser/services/syntaxWorkerMain.ts'),
	].map(architecturePathKey));
	const unreferenced = editorProductionFiles.filter(file => {
		const key = architecturePathKey(file);
		return productionIncoming.get(key) === 0 && testIncoming.get(key) === 0 && !explicitEntrypoints.has(key);
	}).map(file => relative(editorRoot, file));
	assert.deepEqual(unreferenced, [], 'Editor files without a production caller or direct test');
});

function architecturePathKey(path: string): string {
	return process.platform === 'win32' ? path.toLowerCase() : path;
}

test("Editor contracts and Widget composition stay separate from Workbench panes", () => {
	const editorBrowser = readFileSync(join(editorRoot, "browser/editorBrowser.ts"), "utf8");
	const codeEditorWidget = readFileSync(join(editorRoot, "browser/widget/codeEditor/codeEditorWidget.ts"), "utf8");
	assert.equal(statSafe(join(editorRoot, "browser/editorPart.ts")), false, "editor-layer EditorPart");
	assert.equal(statSafe(join(workbenchRoot, "browser/parts/editor/editorPart.ts")), true, "Workbench EditorPart");
	assert.match(editorBrowser, /export interface IContentWidget/u);
	assert.match(editorBrowser, /export interface IOverlayWidget/u);
	assert.doesNotMatch(editorBrowser, /export class ConfiguredCodeEditor/u);
	assert.match(codeEditorWidget, /export class CodeEditorWidget/u);
	assert.equal(statSafe(join(editorRoot, "browser/configuredCodeEditor.ts")), false);
	assert.doesNotMatch(editorBrowser, /export class EditorPart/u);
});

test("ViewLine owns text rows while overlays own their row DOM", () => {
	const viewLine = readFileSync(join(editorRoot, "browser/viewParts/viewLines/viewLine.ts"), "utf8");
	for (const foreignRow of ["line-number", "diagnostic-marker", "indent-guides", "decorations", "selections", "cursors", "composition"]) {
		assert.doesNotMatch(viewLine, new RegExp(`stanza-editor-${foreignRow}`, "u"), foreignRow);
	}
	assert.match(viewLine, /stanza-editor-line-text/u);
	const viewOverlays = readFileSync(join(editorRoot, "browser/view/viewOverlays.ts"), "utf8");
	assert.match(viewOverlays, /new ViewPartRows/u);
	const currentLineHighlight = readFileSync(join(editorRoot, "browser/viewParts/currentLineHighlight/currentLineHighlight.ts"), "utf8");
	assert.doesNotMatch(currentLineHighlight, /new ViewPartRows/u);
	for (const part of ["decorations/decorations", "indentGuides/indentGuides", "linesDecorations/linesDecorations", "marginDecorations/marginDecorations", "selections/selections", "lineNumbers/lineNumbers"]) {
		const source = readFileSync(join(editorRoot, `browser/viewParts/${part}.ts`), "utf8");
		assert.match(source, /extends (?:DynamicViewOverlay|DedupOverlay)/u, part);
		assert.match(source, /render\(startLineNumber: number, lineNumber: number\): string/u, part);
		assert.doesNotMatch(source, /new ViewPartRows/u, part);
	}
	const viewCursors = readFileSync(join(editorRoot, "browser/viewParts/viewCursors/viewCursors.ts"), "utf8");
	assert.match(viewCursors, /extends ViewPart/u);
	assert.match(viewCursors, /new ViewCursor\(/u);
	assert.doesNotMatch(viewCursors, /new ViewPartRows/u);
	const glyphMargin = readFileSync(join(editorRoot, 'browser/viewParts/glyphMargin/glyphMargin.ts'), 'utf8');
	assert.match(glyphMargin, /class DedupOverlay extends DynamicViewOverlay/u);
	const symbolIcons = readFileSync(join(editorRoot, "contrib/symbolIcons/browser/symbolIcons.ts"), "utf8");
	assert.match(symbolIcons, /linesDecorationsClassName/u);
	assert.doesNotMatch(symbolIcons, /DecorationPresentation|DecorationSource/u);
	assert.doesNotMatch(symbolIcons, /querySelector|\bh\(/u);
});

test("Stanza owns its public protocol and DOM vocabulary without renaming the editor domain", () => {
	const api = readFileSync(join(editorRoot, "editor.api.ts"), "utf8");
	const codeInput = readFileSync(join(workbenchRoot, "contrib/codeEditor/browser/codeEditorInput.ts"), "utf8");
	const documentInput = readFileSync(join(workbenchRoot, "contrib/documentEditor/browser/documentEditorInput.ts"), "utf8");
	const diffInput = readFileSync(join(workbenchRoot, "contrib/codeEditor/browser/diffEditorInput.ts"), "utf8");
	const viewport = readFileSync(join(editorRoot, "browser/view.ts"), "utf8");
	const structuredSurface = [
		readFileSync(join(editorRoot, "browser/widget/richTextEditor/richTextEditorWidget.ts"), "utf8"),
		readFileSync(join(editorRoot, "browser/widget/richTextEditor/richTextEditorWidget.css"), "utf8"),
		readFileSync(join(editorRoot, "contrib/formatting/browser/formattingContribution.ts"), "utf8"),
		readFileSync(join(workbenchRoot, "contrib/documentEditor/browser/documentEditorPane.ts"), "utf8"),
	].join("\n");
	assert.match(api, /Stable Stanza API for standalone editors/u);
	assert.match(codeInput, /stanza\.editor\.code/u);
	assert.match(documentInput, /stanza\.editor\.document/u);
	assert.match(diffInput, /stanza\.editor\.diff/u);
	assert.match(diffInput, /application\/vnd\.stanza\.editor-diff/u);
	assert.match(viewport, /stanza-editor/u);
	assert.match(structuredSurface, /stanza-document-/u);
	assert.match(structuredSurface, /stanza-structured-/u);
	assert.doesNotMatch(structuredSurface, /ash-(?:document|structured)-/u);
	assert.equal(existsSync(resolve(editorRoot, "../stanza")), false, "parallel stanza directory");
});

test("Stanza owns editor DOM and CSS brand classes", () => {
	for (const file of collectFiles(editorRoot)) {
		if (!file.endsWith(".ts") && !file.endsWith(".css")) continue;
		const source = readFileSync(file, "utf8");
		assert.doesNotMatch(source, /\bmonaco-editor\b/u, relative(editorRoot, file));
	}
});

test("Text engine PieceTree tests follow VS Code's common model layout", () => {
	assert.equal(statSafe(join(editorRoot, "test/common/model/pieceTreeTextBuffer/pieceTreeTextBuffer.test.ts")), true);
	assert.equal(statSafe(join(editorRoot, "common/model/pieceTreeTextBuffer/rbTreeBase.ts")), true);
	assert.equal(statSafe(join(editorRoot, "common/model/pieceTreeTextBuffer/pieceTreeTextBufferBuilder.ts")), true);
	assert.equal(statSafe(join(editorRoot, "test/common/pieceTreeTextBuffer.test.ts")), false);
});

test("Tree-sitter runtime stays behind App Server syntax facts", () => {
	const packageManifest = readFileSync(resolve(desktopRoot, "package.json"), "utf8");
	const syntaxCrate = readFileSync(resolve(desktopRoot, "../ash-rs/syntax/src/lib.rs"), "utf8");
	const syntaxOperations = readFileSync(resolve(desktopRoot, "../ash-rs/app-server/src/server/syntax_operations.rs"), "utf8");
	const syntaxAdapter = readFileSync(join(workbenchRoot, "services/language/browser/appServerSyntaxProviders.ts"), "utf8");
	const sharedWorkbench = readFileSync(join(workbenchRoot, "browser/workbench.ts"), "utf8");
	const codeContribution = readFileSync(resolve(editorRoot, "../code/browser/workbench/modes/code.contribution.ts"), "utf8");
	const academicContribution = readFileSync(resolve(editorRoot, "../code/browser/workbench/modes/academic.contribution.ts"), "utf8");
	const styling = readFileSync(join(editorRoot, "common/services/semanticTokensStylingService.ts"), "utf8");
	assert.doesNotMatch(packageManifest, /tree-sitter/u);
	assert.equal(existsSync(join(editorRoot, "common/services/treeSitter")), false);
	assert.match(syntaxCrate, /SyntaxDocument/u);
	assert.match(syntaxOperations, /SyntaxDocument::open/u);
	assert.match(syntaxAdapter, /ISyntaxApi/u);
	assert.match(syntaxAdapter, /LanguageTokenResult/u);
	assert.doesNotMatch(sharedWorkbench, /new AppServerSyntaxProviders/u);
	assert.match(codeContribution, /new AppServerSyntaxProviders/u);
	assert.doesNotMatch(academicContribution, /AppServerSyntaxProviders/u);
	assert.match(styling, /LanguageToken/u);
	for (const file of collectFiles(editorRoot)) {
		if (!file.endsWith(".ts")) continue;
		assert.doesNotMatch(readFileSync(file, "utf8"), /@vscode\/tree-sitter-wasm/u, relative(editorRoot, file));
	}
});

test("Window modes select independent Stanza feature implementations behind the shared Workbench entry", () => {
	const codeBundle = readFileSync(join(editorRoot, "editor.code.all.ts"), "utf8");
	const academicBundle = readFileSync(join(editorRoot, "editor.academic.all.ts"), "utf8");
	const standardBundle = readFileSync(join(editorRoot, "editor.all.ts"), "utf8");
	assert.match(codeBundle, /editor\.all/u);
	assert.doesNotMatch(codeBundle, /contrib\//u);
	assert.doesNotMatch(codeBundle, /contrib\/academic/u);
	assert.doesNotMatch(academicBundle, /editor\.all/u);
	assert.match(academicBundle, /contrib\/documentEditor\.contribution/u);
	assert.doesNotMatch(academicBundle, /workbench|academicEditor\.contribution/u);
	assert.match(standardBundle, /browser\/coreCommands/u);
	assert.doesNotMatch(standardBundle, /codeEditorPart\.contribution/u);
	assert.doesNotMatch(standardBundle, /editor\.(?:code|academic)\.all/u);

	const browserEntry = readFileSync(resolve(editorRoot, "../code/browser/workbench/workbench.ts"), "utf8");
	const electronEntry = readFileSync(resolve(editorRoot, "../code/electron-browser/workbench/workbench.ts"), "utf8");
	const codeContribution = readFileSync(resolve(editorRoot, "../code/browser/workbench/modes/code.contribution.ts"), "utf8");
	const academicContribution = readFileSync(resolve(editorRoot, "../code/browser/workbench/modes/academic.contribution.ts"), "utf8");
	const electronCodeMode = readFileSync(resolve(editorRoot, "../code/electron-browser/workbench/modes/code.ts"), "utf8");
	const electronAcademicMode = readFileSync(resolve(editorRoot, "../code/electron-browser/workbench/modes/academic.ts"), "utf8");
	for (const entry of [browserEntry, electronEntry]) {
		assert.match(entry, /__ASH_WORKBENCH_MODE__/u);
		assert.match(entry, /resolveWorkbenchModeIdFromUrl/u);
		assert.match(entry, /satisfies Record<WorkbenchModeId/u);
		assert.match(entry, /modes\/code/u);
		assert.match(entry, /modes\/academic/u);
		assert.doesNotMatch(entry, /if\s*\([^)]*(?:code|academic)/u);
		assert.doesNotMatch(entry, /editor\/editor\.(?:code|academic)\.all/u);
	}
	assert.match(codeContribution, /editor\/editor\.code\.all/u);
	assert.match(codeContribution, /workbench\/contrib\/codeEditor\/browser\/codeEditor\.contribution/u);
	assert.match(codeContribution, /workbench\/contrib\/tasks\/browser\/tasks\.contribution/u);
	assert.match(codeContribution, /workbench\/contrib\/testing\/browser\/testing\.contribution/u);
	assert.match(codeContribution, /workbench\/contrib\/debug\/browser\/debug\.contribution/u);
	assert.match(codeContribution, /codeWorkbenchServices/u);
	assert.doesNotMatch(codeContribution, /editor\/editor\.academic\.all/u);
	assert.match(academicContribution, /editor\/editor\.academic\.all/u);
	assert.match(academicContribution, /workbench\/contrib\/academic\/browser\/academicEditor\.contribution/u);
	assert.doesNotMatch(academicContribution, /workbench\/contrib\/(?:tasks|testing|debug)/u);
	assert.doesNotMatch(academicContribution, /workbench\/contrib\/extensionHost/u);
	assert.doesNotMatch(academicContribution, /editor\/editor\.code\.all/u);
	assert.match(electronCodeMode, /browser\/workbench\/modes\/code\.contribution/u);
	assert.match(electronAcademicMode, /browser\/workbench\/modes\/academic\.contribution/u);
});

test("Code services are installed by mode-selected service registrations rather than UI contributions", () => {
	const workbench = readFileSync(join(workbenchRoot, "browser/workbench.ts"), "utf8");
	const productServices = readFileSync(resolve(workbenchRoot, "../code/browser/workbench/codeWorkbenchServices.ts"), "utf8");
	const tasks = readFileSync(join(workbenchRoot, "services/tasks/browser/taskServiceRegistration.ts"), "utf8");
	const testing = readFileSync(join(workbenchRoot, "services/testing/browser/testingServiceRegistration.ts"), "utf8");
	const debug = readFileSync(join(workbenchRoot, "services/debug/browser/debugServiceRegistration.ts"), "utf8");
	assert.doesNotMatch(workbench, /services\/(?:tasks|testing|debug)\/(?:browser|common)/u);
	assert.doesNotMatch(workbench, /product\.id\s*===\s*["']code["']/u);
	assert.match(workbench, /installWorkbenchServiceContributions/u);
	assert.match(productServices, /taskServiceRegistration/u);
	assert.match(productServices, /testingServiceRegistration/u);
	assert.match(productServices, /debugServiceRegistration/u);
	assert.match(productServices, /extensionHostServiceRegistration/u);
	assert.match(productServices, /codebaseSymbolsServiceRegistration/u);
	for (const registration of [tasks, testing, debug]) assert.match(registration, /registerWorkbenchServiceContribution/u);
	for (const contribution of ["tasks", "testing", "debug"]) assert.doesNotMatch(readFileSync(join(workbenchRoot, `contrib/${contribution}/browser/${contribution}.contribution.ts`), "utf8"), /registerWorkbenchServiceContribution/u);
});

test("Code renderers select App Server debug transport without Electron debug IPC", () => {
	const browserCode = readFileSync(resolve(editorRoot, "../code/browser/workbench/modes/code.ts"), "utf8");
	const browserAcademic = readFileSync(resolve(editorRoot, "../code/browser/workbench/modes/academic.ts"), "utf8");
	const electronCode = readFileSync(resolve(editorRoot, "../code/electron-browser/workbench/modes/code.ts"), "utf8");
	const electronAcademic = readFileSync(resolve(editorRoot, "../code/electron-browser/workbench/modes/academic.ts"), "utf8");
	const main = readFileSync(resolve(editorRoot, "../code/electron-main/main.ts"), "utf8");
	const sharedElectronRenderer = readFileSync(resolve(editorRoot, "../platform/native/electron-browser/rendererApi.ts"), "utf8");
	const sharedDisconnectedRenderer = readFileSync(resolve(editorRoot, "../platform/app-server/browser/rendererApi.ts"), "utf8");
	const sharedConnectedRenderer = readFileSync(resolve(editorRoot, "../platform/app-server/browser/webRendererApi.ts"), "utf8");
	const sharedElectronMain = readFileSync(resolve(editorRoot, "../code/electron-main/app.ts"), "utf8");
	assert.match(browserCode, /createAppServerDebugAdapterCapability/u);
	assert.doesNotMatch(browserAcademic, /DebugAdapter|debugAdapter/u);
	assert.match(electronCode, /createAppServerDebugAdapterCapability/u);
	assert.doesNotMatch(electronAcademic, /DebugAdapter|debugAdapter/u);
	assert.doesNotMatch(main, /debugAdapterIpcRoutes/u);
	const debugAdapter = readFileSync(resolve(editorRoot, "../platform/debug/browser/appServerDebugAdapterProcessService.ts"), "utf8");
	assert.match(debugAdapter, /implements IDebugAdapterProcessService/u);
	assert.match(debugAdapter, /appServerRequest/u);
	for (const sharedHost of [sharedElectronRenderer, sharedDisconnectedRenderer, sharedConnectedRenderer, sharedElectronMain]) assert.doesNotMatch(sharedHost, /new (?:Electron|Disconnected|ViteDev)DebugAdapterProcessService|debugAdapterIpcRoutes/u);
});

test("Editor engines delegate optional feature composition to mode bundles", () => {
	const textHost = readFileSync(join(editorRoot, "browser/widget/codeEditor/codeEditorWidget.ts"), "utf8");
	const coreCommands = readFileSync(join(editorRoot, "browser/coreCommands.ts"), "utf8");
	const findContribution = readFileSync(join(editorRoot, "contrib/find/browser/findController.ts"), "utf8");
	const quickAccessContribution = readFileSync(join(editorRoot, "contrib/quickAccess/browser/quickAccessController.ts"), "utf8");
	const documentHost = readFileSync(join(editorRoot, "browser/widget/richTextEditor/richTextEditorWidget.ts"), "utf8");
	const documentContribution = readFileSync(join(editorRoot, "contrib/documentEditor.contribution.ts"), "utf8");
	const codePaneContribution = readFileSync(join(workbenchRoot, "contrib/codeEditor/browser/codeEditor.contribution.ts"), "utf8");
	const academicPaneContribution = readFileSync(join(workbenchRoot, "contrib/academic/browser/academicEditor.contribution.ts"), "utf8");
	const textModel = readFileSync(join(editorRoot, "common/model/textModel.ts"), "utf8");
	const codeBundle = readFileSync(join(editorRoot, "editor.code.all.ts"), "utf8");
	const academicBundle = readFileSync(join(editorRoot, "editor.academic.all.ts"), "utf8");
	const standardBundle = readFileSync(join(editorRoot, "editor.all.ts"), "utf8");
	const editorExtensionRegistry = readFileSync(join(editorRoot, "browser/editorExtensions.ts"), "utf8");
	const codeEditorContributions = readFileSync(join(editorRoot, "browser/widget/codeEditor/codeEditorContributions.ts"), "utf8");
	const optionalControllerPattern = /(?:AnchorSelect|BlockComment|BracketEditing|BracketMatch|BracketNavigation|CodeAction|CodeLens|ColorPicker|ContextMenu|CursorUndo|DiagnosticHover|DiagnosticNavigation|EditorState|Folding|FontZoom|Format|GotoLine|GotoSymbol|Hover|InPlaceReplace|InlayHints|InlineCompletions|InlineProgress|LineComment|LineJoin|LineOperations|LinkedEditing|Links|Message|MiddleScroll|MultiCursor|OccurrenceHighlight|OccurrenceSelection|ParameterHints|ReadOnlyMessage|Rename|SectionHeaders|SmartSelect|StickyScroll|SymbolIcons|TextDrop|ToggleTabFocusMode|Tokenization|Transpose|UnicodeHighlighter|UnusualLineTerminators|WordWrap)Controller/u;
	assert.doesNotMatch(textHost, /from\s+["'][^"']*\/contrib\/(?:find|folding|hover|format|rename|codeAction|collaboration|formatting)\//u);
	assert.doesNotMatch(textHost, /EditorBrowserRuntime|IEditorBrowserRuntime/u);
	assert.doesNotMatch(textHost, /registerEditorBrowserFactory|EditorBrowserFactory/u);
	assert.match(textHost, /getEditorContributions/u);
	assert.match(textHost, /this\.contributions\.initialize/u);
	assert.match(codeEditorContributions, /runWhenWindowIdle/u);
	assert.doesNotMatch(textHost, optionalControllerPattern);
	assert.doesNotMatch(textHost, /EditingCommandController/u);
	assert.match(coreCommands, /editor\.action\.selectAll/u);
	assert.match(coreCommands, /registerEditorContribution/u);
	assert.doesNotMatch(textHost, /SuggestModel|RustSyntaxFactsService|LanguageDiagnosticDecorationBridge|TokenizationTextModelPart|TextDecorationCollection|LanguageBracketMatcher/u);
	const viewController = readFileSync(join(editorRoot, "browser/view/viewController.ts"), "utf8");
	const codeEditorWidget = readFileSync(join(editorRoot, "browser/widget/codeEditor/codeEditorWidget.ts"), "utf8");
	assert.doesNotMatch(viewController, /from\s+["'][^"']*\/contrib\//u);
	assert.match(viewController, /this\._register\(addDisposableListener/u);
	assert.doesNotMatch(codeEditorWidget, /from\s+["'][^"']*\/contrib\//u);
	assert.doesNotMatch(editorExtensionRegistry, /from\s+["'][^"']*\/contrib\//u);
	assert.match(findContribution, /registerEditorContribution/u);
	assert.match(quickAccessContribution, /registerEditorContribution/u);
	assert.match(standardBundle, /find\/browser\/findController/u);
	assert.match(standardBundle, /quickAccess\/browser\/quickAccessController/u);
	for (const contribution of ["bracketMatching", "gotoSymbol", "languageAnalysis", "placeholderText", "tokenization", "unicodeHighlighter", "wordHighlighter"]) {
		assert.match(standardBundle, new RegExp(`contrib/${contribution}/browser/[^"']+\\.contribution`, "u"), contribution);
	}
	assert.match(standardBundle, /contrib\/comment\/browser\/comment\.js/u);
	assert.match(standardBundle, /contrib\/suggest\/browser\/suggestController\.js/u);
	assert.match(standardBundle, /contrib\/gotoError\/browser\/gotoError\.js/u);
	assert.match(standardBundle, /contrib\/multicursor\/browser\/multicursor\.js/u);
	assert.match(standardBundle, /contrib\/codeAction\/browser\/codeActionContributions\.js/u);
	assert.match(standardBundle, /contrib\/hover\/browser\/hoverContribution\.js/u);
	assert.match(standardBundle, /contrib\/stickyScroll\/browser\/stickyScrollContribution\.js/u);
	assert.match(standardBundle, /contrib\/format\/browser\/formatActions\.js/u);
	for (const contribution of ["quickAccess", "rename"]) assert.match(standardBundle, new RegExp(`contrib/${contribution}/browser/[^"']+Controller`, "u"), contribution);
	assert.match(standardBundle, /contrib\/dropOrPasteInto\/browser\/dropIntoEditorContribution/u);
	assert.match(standardBundle, /contrib\/clipboard\/browser\/clipboard\.js/u);
	assert.match(standardBundle, /contrib\/folding\/browser\/folding\.js/u);
	assert.doesNotMatch(codeBundle, /contrib\//u);
	assert.match(academicBundle, /documentEditor\.contribution/u);
	assert.doesNotMatch(codePaneContribution, /codeEditorPart\.contribution/u);
	assert.doesNotMatch(documentHost, /from\s+["'][^"']*\/contrib\/(?:formatting|collaboration)\/browser\//u);
	assert.match(documentHost, /getEditorContributions/u);
	assert.doesNotMatch(documentHost, /registerDocumentEditorContributionFactory/u);
	assert.match(documentContribution, /registerEditorContribution/u);
	assert.match(documentContribution, /FormattingContribution/u);
	assert.match(documentContribution, /CollaborationContribution/u);
	assert.doesNotMatch(academicPaneContribution, /codeEditorPart\.contribution/u);
	assert.doesNotMatch(academicPaneContribution, /contrib\/codeEditor|CodeEditorPane|EmbeddedTextEditorFactory|AcademicCodeBlockEditorFactory|CodeEditorWidget/u);
	assert.doesNotMatch(academicPaneContribution, /documentEditor\.contribution/u);
	assert.match(textModel, /static create\(/u);
	assert.match(textModel, /get lineDocument/u);
	assert.match(textModel, /getLineId/u);
	assert.doesNotMatch(textModel, /TextModelStructure|structureIndex|TextModelBlockTree/u);
	assert.match(documentHost, /case "codeBlock":[\s\S]*appendEditableText/u);
	assert.doesNotMatch(documentHost, /new TextModel|TextModel\.createStructured/u);
	assert.doesNotMatch(standardBundle, /codeEditorPart\.contribution/u);
	assert.match(academicBundle, /documentEditor\.contribution/u);
});

test("Multi-diff keeps generic projection in Editor and product integration in Workbench", () => {
	const widget = readFileSync(join(editorRoot, "browser/widget/multiDiffEditor/multiDiffEditorWidget.ts"), "utf8");
	const pane = readFileSync(join(workbenchRoot, "contrib/multiDiffEditor/browser/multiDiffEditorPane.ts"), "utf8");
	const input = readFileSync(join(workbenchRoot, "contrib/multiDiffEditor/browser/multiDiffEditorInput.ts"), "utf8");
	const contribution = readFileSync(join(workbenchRoot, "contrib/multiDiffEditor/browser/multiDiffEditor.contribution.ts"), "utf8");
	const sharedWorkbench = readFileSync(join(workbenchRoot, "browser/workbench.contribution.ts"), "utf8");
	assert.doesNotMatch(widget, /workbench/u);
	assert.match(pane, /MultiDiffEditorWidget/u);
	assert.match(input, /EditorInput/u);
	assert.match(contribution, /registerEditorPane/u);
	assert.match(contribution, /registerAction2/u);
	assert.match(sharedWorkbench, /contrib\/multiDiffEditor/u);
});

test("Contribution entrypoints own registration rather than forwarding modules", () => {
	for (const file of collectFiles(join(editorRoot, 'contrib')).filter(file => file.endsWith('.contribution.ts'))) {
		const source = readFileSync(file, 'utf8');
		assert.match(source, /register(?:EditorContribution|EditorAction|Action2)\(/u, relative(editorRoot, file));
	}
});

function collectFiles(directory: string): string[] {
	const result: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const file = join(directory, entry.name);
		if (entry.isDirectory()) result.push(...collectFiles(file));
		else result.push(file);
	}
	return result;
}

function statSafe(file: string): boolean {
	try {
		return statSync(file).isFile();
	} catch {
		return false;
	}
}

function isTestFile(file: string): boolean {
	return /[\\/]test[\\/]|\.test\.ts$/u.test(file);
}
