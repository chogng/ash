import { BrowserTextMateService } from '../../../src/ash/workbench/services/textMate/browser/browserTextMateService.js';
import { createLanguageExtensions } from './languageExtensions.js';
import { ContextKeyService, IContextKeyService } from '../../../src/ash/platform/contextkey/browser/contextKeyService.js';
import { IMarkerService, MarkerService } from '../../../src/ash/platform/markers/common/markers.js';
import { IMarkerDecorationsService } from '../../../src/ash/editor/common/services/markerDecorations.js';
import { MarkerDecorationsService } from '../../../src/ash/editor/common/services/markerDecorationsService.js';
import { ICodeEditorService } from '../../../src/ash/editor/browser/services/codeEditorService.js';
import { StandaloneCodeEditorService } from '../../../src/ash/editor/standalone/browser/standaloneCodeEditorService.js';
import { IInlineCompletionsService, InlineCompletionsService } from '../../../src/ash/editor/browser/services/inlineCompletionsService.js';
import { bindColorTheme } from '../../../src/ash/platform/theme/browser/themeStyles.js';
import { EditorOption, type IEditorScrollbarOptions, type IEditorOptions } from '../../../src/ash/editor/common/config/editorOptions.js';
import { ICommandService } from '../../../src/ash/platform/commands/common/commands.js';
import '../../../src/ash/workbench/contrib/codeEditor/browser/quickaccess/gotoLineQuickAccess.js';
import '../../../src/ash/workbench/contrib/codeEditor/browser/toggleMinimap.js';
import '../../../src/ash/workbench/contrib/codeEditor/browser/toggleRenderWhitespace.js';
import '../../../src/ash/workbench/contrib/codeEditor/browser/toggleRenderControlCharacter.js';
import '../../../src/ash/workbench/contrib/codeEditor/browser/toggleWordWrap.js';
import { h } from '../../../src/ash/base/browser/dom.js';
import { IThemeService } from '../../../src/ash/platform/theme/common/themeService.js';
import { TestThemeService } from '../../../src/ash/platform/theme/test/common/testThemeService.js';
import { darkColorTheme, lightColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme } from '../../../src/ash/platform/theme/common/colorTheme.js';
import { URI } from "../../../src/ash/base/common/uri.js";
import { DisposableStore, toDisposable } from "../../../src/ash/base/common/lifecycle.js";
import { Event } from "../../../src/ash/base/common/event.js";
import { createBrowserEditorPart } from "../../../src/ash/workbench/contrib/codeEditor/browser/browserEditorPart.js";
import { CodeEditorPane, type EditorPaneOptions } from "../../../src/ash/workbench/contrib/codeEditor/browser/codeEditorPane.js";
import { ILanguageConfigurationService, LanguageConfigurationService } from "../../../src/ash/editor/common/languages/languageConfigurationRegistry.js";
import { ILanguageFeaturesService } from '../../../src/ash/editor/common/services/languageFeatures.js';
import { ITextModelResourceService } from '../../../src/ash/workbench/services/textmodelResolver/common/textModelResourceService.js';
import { ServiceContainer } from '../../../src/ash/platform/instantiation/common/instantiation.js';
import { ILogService, NullLoggerService } from '../../../src/ash/platform/log/common/log.js';
import { LanguageFeaturesService } from "../../../src/ash/editor/common/services/languageFeaturesService.js";
import { LanguageService } from "../../../src/ash/editor/common/services/languageService.js";
import { Position } from "../../../src/ash/editor/common/core/position.js";
import { Range } from "../../../src/ash/editor/common/core/range.js";
import { Selection } from "../../../src/ash/editor/common/core/selection.js";
import { GlyphMarginLane } from "../../../src/ash/editor/common/model.js";
import { ContentWidgetPositionPreference, type IContentWidget, type IGlyphMarginWidget } from "../../../src/ash/editor/browser/editorBrowser.js";
import { type IEditorDecorationsCollection } from "../../../src/ash/editor/common/editorCommon.js";
import { InMemoryConfigurationService } from "../../../src/ash/platform/configuration/common/inMemoryConfigurationService.js";
import { BrowserTextResourceStore } from "../../../src/ash/workbench/contrib/codeEditor/browser/browserTextResourceStore.js";
import { AppServerSyntaxProviders } from "../../../src/ash/workbench/services/language/browser/appServerSyntaxProviders.js";
import { WorkbenchLanguageFeatures } from "../../../src/ash/workbench/services/language/browser/workbenchLanguageFeatures.js";
import { BrowserTextModelService } from "../../../src/ash/workbench/services/textmodelResolver/browser/browserTextModelService.js";
import { TextModel } from "../../../src/ash/editor/editor.api.js";
import "../../../src/ash/editor/editor.code.all.js";
import '../../../src/ash/editor/standalone/browser/quickAccess/standaloneGotoSymbolQuickAccess.js';
import { MemoryTextFiles } from "./memoryTextFiles.js";
import { AccessibilitySupport, IAccessibilityService } from '../../../src/ash/platform/accessibility/common/accessibility.js';
import { EditorExtensionsRegistry } from '../../../src/ash/editor/browser/editorExtensions.js';
import { registerCodeEditorServices } from '../../../src/ash/editor/test/browser/testCodeEditor.js';
import { IKeybindingService } from '../../../src/ash/platform/keybinding/common/keybinding.js';
import { IQuickInputService } from '../../../src/ash/platform/quickinput/common/quickInput.js';
import { WorkbenchQuickInputService } from '../../../src/ash/workbench/services/quickinput/browser/quickInputService.js';

interface WorkbenchSwitchResult {
	readonly paneOwnsEditor: boolean;
	readonly oldEditorDisposed: boolean;
	readonly oldModelDisposed: boolean;
	readonly oldDomConnected: boolean;
	readonly editorCount: number;
	readonly value: string;
}

interface IntegrationHarness {
	readonly apiText: string;
	getValue(): string;
	setValue(value: string): void;
	save(): Promise<void>;
	getSavedText(): string;
	getSyntaxAnalysisCount(): number;
	getBundleIds(): readonly string[];
	hasClipboardContribution(): boolean;
	hasPlaceholderContribution(): boolean;
	switchToOther(): Promise<WorkbenchSwitchResult>;
	getSelection(): { readonly startLineIndex: number; readonly startColumnIndex: number; readonly endLineIndex: number; readonly endColumnIndex: number };
	setCursors(positions: readonly { readonly lineIndex: number; readonly columnIndex: number }[], primaryIndex?: number): void;
	revealPosition(lineIndex: number, columnIndex: number): void;
	setScrollLeft(scrollLeft: number): void;
	setScrollbar(options: IEditorScrollbarOptions): void;
	updateOptions(options: IEditorOptions): void;
	runWorkbenchCommand(id: string): Promise<void>;
	getViewSettings(): { readonly minimap: boolean; readonly renderWhitespace: string; readonly renderControlCharacters: boolean; readonly wordWrap: string; readonly wordWrapOverride: string; readonly wrappingColumn: number };
	setTheme(theme: 'dark' | 'light' | 'contrast' | 'contrastLight'): void;
	setRenderRichScreenReaderContent(enabled: boolean): void;
	showViewZone(): void;
	removeViewZone(): void;
	showWidgets(): void;
	moveGlyphWidget(lineIndex: number): void;
	removeWidgets(): void;
	showModelDecorations(): void;
	removeModelDecorations(): void;
	dispose(): void;
}

declare global {
	interface Window {
		ashTextModelIntegration: IntegrationHarness;
	}
}

const root = requiredElement("#editor-root");
const disposables = new DisposableStore();
const resource = URI.parse("inmemory://editor/main.rs");
const files = new MemoryTextFiles(resource, "fn main() {\n  answer();\n}\n");
disposables.add(toDisposable(() => files.dispose()));
const resourceStore = new BrowserTextResourceStore(files);
const languageService = disposables.add(new LanguageService());
const configurationService = disposables.add(new InMemoryConfigurationService());
const languageConfigurationService = disposables.add(new LanguageConfigurationService(configurationService, languageService));
const languageFeaturesService = disposables.add(new LanguageFeaturesService());
const textMateService = disposables.add(new BrowserTextMateService());
const extensions = disposables.add(await createLanguageExtensions({ textMateService, languageService, languageConfigurationService, languageFeaturesService }));
await extensions.start();
const models = disposables.add(new BrowserTextModelService(resourceStore, {
	languageService, languageConfigurationService, languageFeaturesService,
	syntaxService: { workerFactory: textMateService.syntaxWorkerFactory },
	onDidChangeLanguageSupport: textMateService.onDidChange,
}));
let syntaxAnalysisCount = 0;
disposables.add(new AppServerSyntaxProviders(languageFeaturesService, {
	generation: 1,
	open: async () => {},
	update: async () => {},
	analyze: async params => {
		syntaxAnalysisCount += 1;
		return {
			revision: params.revision,
			hasErrors: true,
			tokens: [
				{ kind: "keyword", range: { start: { lineIndex: 0, columnIndex: 0 }, end: { lineIndex: 0, columnIndex: 2 } } },
				{ kind: "function", range: { start: { lineIndex: 0, columnIndex: 3 }, end: { lineIndex: 0, columnIndex: 7 } } },
			],
			foldingRanges: [{ range: { start: { lineIndex: 0, columnIndex: 0 }, end: { lineIndex: 2, columnIndex: 1 } } }],
			symbols: [{
				name: "main",
				kind: "function",
				range: { start: { lineIndex: 0, columnIndex: 0 }, end: { lineIndex: 2, columnIndex: 1 } },
				selectionRange: { start: { lineIndex: 0, columnIndex: 3 }, end: { lineIndex: 0, columnIndex: 7 } },
			}],
			diagnostics: [{ kind: "missing", range: { start: { lineIndex: 1, columnIndex: 2 }, end: { lineIndex: 1, columnIndex: 8 } } }],
		};
	},
	selectionRanges: async params => ({ revision: params.revision, ranges: [] }),
	close: async () => {},
}));
let editorPart: ReturnType<typeof createBrowserEditorPart> | undefined;
let viewZoneId: string | undefined;
let contentWidget: IContentWidget | undefined;
let glyphWidget: IGlyphMarginWidget | undefined;
let glyphWidgetLineNumber = 1;
let glyphDecorations: IEditorDecorationsCollection | undefined;
let modelDecorations: IEditorDecorationsCollection | undefined;
const services = disposables.add(new ServiceContainer());
services.registerSingleton(IContextKeyService, () => new ContextKeyService());
services.registerSingleton(IMarkerService, () => services.createInstance(MarkerService));
services.registerSingleton(IMarkerDecorationsService, () => services.createInstance(MarkerDecorationsService));
services.registerSingleton(ICodeEditorService, () => services.createInstance(StandaloneCodeEditorService));
services.registerSingleton(IInlineCompletionsService, () => services.createInstance(InlineCompletionsService));
services.registerInstance(ITextModelResourceService, models);
const themeService = disposables.add(new TestThemeService(darkColorTheme));
services.registerInstance(IThemeService, themeService);
disposables.add(bindColorTheme(themeService, root));
services.registerInstance(ILanguageFeaturesService, languageFeaturesService);
disposables.add(services.createInstance(WorkbenchLanguageFeatures));
services.registerInstance(ILanguageConfigurationService, languageConfigurationService);
services.registerInstance(ILogService, new NullLoggerService());
registerCodeEditorServices(services);
services.registerInstance(IQuickInputService, disposables.add(new WorkbenchQuickInputService({
	container: root,
	contextKeyService: services.get(IContextKeyService),
})));
services.get(IAccessibilityService).setAccessibilitySupport(AccessibilitySupport.Enabled);
services.get(IKeybindingService);
const pane = disposables.add(services.createInstance(CodeEditorPane, resourceStore, {
	createPart: options => {
		editorPart = createBrowserEditorPart(services, options);
		return editorPart;
	},
	cursorSmoothCaretAnimation: "explicit",
} satisfies EditorPaneOptions));
const apiModel = disposables.add(new TextModel("editor-api"));

pane.create(root);
pane.layout({ width: 900, height: 420 });
await pane.setInput({ resource, label: "main.rs" }, new AbortController().signal);

window.ashTextModelIntegration = {
	apiText: apiModel.getText(),
	getValue: () => pane.getValue(),
	setValue: value => requiredEditorPart().setValue(value),
	save: () => pane.save(),
	getSavedText: () => files.read(resource),
	getSyntaxAnalysisCount: () => syntaxAnalysisCount,
	getBundleIds: () => [
		...EditorExtensionsRegistry.getEditorContributions().map(contribution => contribution.id),
	],
	hasClipboardContribution: () => requiredEditorPart().getContribution('editor.contrib.clipboard') !== null,
	hasPlaceholderContribution: () => requiredEditorPart().getContribution('editor.contrib.placeholderText') !== null,
	switchToOther: async () => {
		const oldEditor = requiredEditorPart();
		const oldModel = oldEditor.getModel();
		if (!oldModel) throw new Error('Workbench integration editor has no model');
		const oldDom = oldEditor.getDomNode();
		await pane.setInput({ resource: URI.parse('inmemory://editor/other.ts'), label: 'other.ts', initialText: 'fn other() {\n  answer();\n}\n' }, new AbortController().signal);
		return {
			paneOwnsEditor: pane.getControl() === requiredEditorPart(),
			oldEditorDisposed: oldEditor.isDisposed,
			oldModelDisposed: oldModel.isDisposed(),
			oldDomConnected: oldDom.isConnected,
			editorCount: services.get(ICodeEditorService).listCodeEditors().length,
			value: pane.getValue(),
		};
	},
	getSelection: () => {
		const selection = requiredEditorPart().getSelection();
		if (!selection) throw new Error('Text model integration editor has no selection');
		return {
			startLineIndex: selection.startLineNumber - 1,
			startColumnIndex: selection.startColumn - 1,
			endLineIndex: selection.endLineNumber - 1,
			endColumnIndex: selection.endColumn - 1,
		};
	},
	setCursors: (positions, primaryIndex = 0) => requiredEditorPart().setSelections(primaryFirst(
		positions.map(position => Selection.fromPositions(new Position(position.lineIndex + 1, position.columnIndex + 1))),
		primaryIndex,
	)),
	revealPosition: (lineIndex, columnIndex) => requiredEditorPart().view.revealPosition(new Position(lineIndex + 1, columnIndex + 1)),
	setScrollLeft: scrollLeft => requiredEditorPart().setScrollLeft(scrollLeft),
	setScrollbar: scrollbar => requiredEditorPart().updateOptions({ scrollbar }),
	updateOptions: options => requiredEditorPart().updateOptions(options),
	runWorkbenchCommand: id => services.get(ICommandService).executeCommand(id),
	getViewSettings: () => ({
		minimap: requiredEditorPart().getOption(EditorOption.minimap).enabled,
		renderWhitespace: requiredEditorPart().getOption(EditorOption.renderWhitespace),
		renderControlCharacters: requiredEditorPart().getOption(EditorOption.renderControlCharacters),
		wordWrap: requiredEditorPart().getOption(EditorOption.wordWrap),
		wordWrapOverride: requiredEditorPart().getOption(EditorOption.wordWrapOverride2),
		wrappingColumn: requiredEditorPart().getOption(EditorOption.wrappingInfo).wrappingColumn,
	}),
	setTheme: theme => themeService.setColorTheme({ dark: darkColorTheme, light: lightColorTheme, contrast: highContrastDarkColorTheme, contrastLight: highContrastLightColorTheme }[theme]),
	setRenderRichScreenReaderContent: enabled => requiredEditorPart().updateOptions({ renderRichScreenReaderContent: enabled }),
	showViewZone: () => {
		removeViewZone();
		const domNode = h(document, 'div');
		domNode.className = 'ash-view-zone-probe';
		domNode.textContent = 'View zone';
		requiredEditorPart().changeViewZones(accessor => {
			viewZoneId = accessor.addZone({ afterLineNumber: 1, heightInPx: 500, minWidthInPx: 1_200, suppressMouseDown: true, domNode });
		});
	},
	removeViewZone,
	showWidgets: () => {
		removeWidgets();
		const contentDomNode = h(document, 'button');
		contentDomNode.className = 'ash-content-widget-probe';
		contentDomNode.textContent = 'Content widget';
		contentWidget = {
			suppressMouseDown: true,
			getId: () => 'ash.integration.contentWidget',
			getDomNode: () => contentDomNode,
			getPosition: () => ({ position: new Position(2, 3), preference: [ContentWidgetPositionPreference.EXACT] }),
		};
		const glyphDomNode = h(document, 'button');
		glyphDomNode.className = 'ash-glyph-widget-probe';
		glyphDomNode.textContent = 'G';
		glyphWidgetLineNumber = 1;
		glyphWidget = {
			getId: () => 'ash.integration.glyphWidget',
			getDomNode: () => glyphDomNode,
			getPosition: () => ({ lane: GlyphMarginLane.Center, zIndex: 10, range: new Range(glyphWidgetLineNumber, 1, glyphWidgetLineNumber, 1) }),
		};
		const editor = requiredEditorPart();
		editor.addContentWidget(contentWidget);
		editor.addGlyphMarginWidget(glyphWidget);
		glyphDecorations = editor.createDecorationsCollection([{
			range: new Range(2, 1, 2, 1),
			options: { description: 'lower integration glyph', glyphMarginClassName: 'ash-model-glyph-lower', glyphMargin: { position: GlyphMarginLane.Center }, zIndex: 1 },
		}, {
			range: new Range(2, 1, 2, 1),
			options: { description: 'higher integration glyph', glyphMarginClassName: 'ash-model-glyph-higher', glyphMargin: { position: GlyphMarginLane.Center }, zIndex: 2 },
		}]);
	},
	moveGlyphWidget: lineIndex => {
		if (!glyphWidget) throw new Error('Glyph widget probe is not installed');
		glyphWidgetLineNumber = lineIndex + 1;
		requiredEditorPart().layoutGlyphMarginWidget(glyphWidget);
	},
	removeWidgets,
	showModelDecorations: () => {
		removeModelDecorations();
		modelDecorations = requiredEditorPart().createDecorationsCollection([{
			range: new Range(1, 1, 1, 3),
			options: { description: 'integration inline decoration', className: 'ash-model-decoration-inline' },
		}, {
			range: new Range(2, 1, 2, 1),
			options: { description: 'integration whole-line decoration', className: 'ash-model-decoration-whole', isWholeLine: true },
		}, {
			range: new Range(3, 1, 3, 1),
			options: { description: 'integration collapsed decoration', className: 'ash-model-decoration-collapsed', showIfCollapsed: true },
		}, {
			range: new Range(1, 1, 2, 1),
			options: {
				description: 'integration line decoration',
				linesDecorationsClassName: 'ash-model-line-decoration',
				firstLineDecorationClassName: 'ash-model-first-line-decoration',
				linesDecorationsTooltip: 'Model line decoration',
			},
		}, {
			range: new Range(2, 1, 3, 1),
			options: { description: 'integration block decoration', blockClassName: 'ash-model-block-decoration', blockPadding: [1, 2, 3, 4] },
		}]);
	},
	removeModelDecorations,
	dispose: () => {
		removeViewZone();
		removeWidgets();
		removeModelDecorations();
		disposables.dispose();
	},
};

function requiredEditorPart(): ReturnType<typeof createBrowserEditorPart> {
	if (!editorPart) throw new Error("Text model integration editor is missing");
	return editorPart;
}

function removeViewZone(): void {
	if (viewZoneId === undefined || !editorPart) return;
	const id = viewZoneId;
	viewZoneId = undefined;
	editorPart.changeViewZones(accessor => accessor.removeZone(id));
}

function removeWidgets(): void {
	if (editorPart && contentWidget) editorPart.removeContentWidget(contentWidget);
	if (editorPart && glyphWidget) editorPart.removeGlyphMarginWidget(glyphWidget);
	contentWidget = undefined;
	glyphWidget = undefined;
	glyphDecorations?.clear();
	glyphDecorations = undefined;
}

function removeModelDecorations(): void {
	modelDecorations?.clear();
	modelDecorations = undefined;
}

function primaryFirst<T>(items: readonly T[], primaryIndex: number): readonly T[] {
	if (primaryIndex === 0) return Object.freeze([...items]);
	return Object.freeze([items[primaryIndex]!, ...items.slice(0, primaryIndex), ...items.slice(primaryIndex + 1)]);
}

function requiredElement(selector: string): HTMLElement {
	const element = document.querySelector<HTMLElement>(selector);
	if (!element) throw new Error(`Missing editor integration root '${selector}'`);
	return element;
}
