import { URI } from "../../../src/ash/base/common/uri.js";
import { DisposableStore, toDisposable } from "../../../src/ash/base/common/lifecycle.js";
import { Event } from "../../../src/ash/base/common/event.js";
import { createBrowserEditorPart } from "../../../src/ash/workbench/contrib/codeEditor/browser/browserEditorPart.js";
import { CodeEditorPane } from "../../../src/ash/workbench/contrib/codeEditor/browser/codeEditorPane.js";
import { LanguageConfigurationService } from "../../../src/ash/editor/common/languages/languageConfigurationRegistry.js";
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
import { MemoryTextFiles } from "./memoryTextFiles.js";
import { AccessibilitySupport, type IAccessibilityService } from '../../../src/ash/platform/accessibility/common/accessibility.js';

interface IntegrationHarness {
	readonly apiText: string;
	getValue(): string;
	setValue(value: string): void;
	save(): Promise<void>;
	getSavedText(): string;
	getSyntaxAnalysisCount(): number;
	getSelection(): { readonly startLineIndex: number; readonly startColumnIndex: number; readonly endLineIndex: number; readonly endColumnIndex: number };
	setCursors(positions: readonly { readonly lineIndex: number; readonly columnIndex: number }[], primaryIndex?: number): void;
	revealPosition(lineIndex: number, columnIndex: number): void;
	setScrollLeft(scrollLeft: number): void;
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
const accessibilityService: IAccessibilityService = {
	onDidChangeScreenReaderOptimized: Event.None,
	onDidChangeReducedMotion: Event.None,
	onDidChangeReducedTransparency: Event.None,
	onDidChangeLinkUnderlines: Event.None,
	alwaysUnderlineAccessKeys: async () => false,
	isScreenReaderOptimized: () => true,
	isMotionReduced: () => false,
	isTransparencyReduced: () => false,
	getAccessibilitySupport: () => AccessibilitySupport.Enabled,
	setAccessibilitySupport: () => {},
	alert: () => {},
	status: () => {},
};
const languageConfigurationService = disposables.add(new LanguageConfigurationService(configurationService, languageService));
const languageFeaturesService = disposables.add(new LanguageFeaturesService(languageConfigurationService));
const models = disposables.add(new BrowserTextModelService(resourceStore, { languageService, languageFeaturesService }));
disposables.add(new WorkbenchLanguageFeatures(languageService, languageConfigurationService, languageFeaturesService));
let syntaxAnalysisCount = 0;
disposables.add(new AppServerSyntaxProviders(languageFeaturesService, {
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
}));
let editorPart: ReturnType<typeof createBrowserEditorPart> | undefined;
let viewZoneId: string | undefined;
let contentWidget: IContentWidget | undefined;
let glyphWidget: IGlyphMarginWidget | undefined;
let glyphWidgetLineNumber = 1;
let glyphDecorations: IEditorDecorationsCollection | undefined;
let modelDecorations: IEditorDecorationsCollection | undefined;
const pane = disposables.add(new CodeEditorPane(resourceStore, {
	modelService: models,
	createPart: options => {
		editorPart = createBrowserEditorPart(options);
		return editorPart;
	},
	languageConfigurationService,
	languageFeaturesService,
	accessibilityService,
	cursorSmoothCaretAnimation: "explicit",
}));
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
	setCursors: (positions, primaryIndex = 0) => requiredEditorPart().selections.setCursorSelections(primaryFirst(
		positions.map(position => Selection.fromPositions(new Position(position.lineIndex + 1, position.columnIndex + 1))),
		primaryIndex,
	)),
	revealPosition: (lineIndex, columnIndex) => requiredEditorPart().view.revealPosition(new Position(lineIndex + 1, columnIndex + 1)),
	setScrollLeft: scrollLeft => requiredEditorPart().setScrollLeft(scrollLeft),
	setRenderRichScreenReaderContent: enabled => requiredEditorPart().updateOptions({ renderRichScreenReaderContent: enabled }),
	showViewZone: () => {
		removeViewZone();
		const domNode = document.createElement('div');
		domNode.className = 'ash-view-zone-probe';
		domNode.textContent = 'View zone';
		requiredEditorPart().changeViewZones(accessor => {
			viewZoneId = accessor.addZone({ afterLineNumber: 1, heightInPx: 500, minWidthInPx: 1_200, suppressMouseDown: true, domNode });
		});
	},
	removeViewZone,
	showWidgets: () => {
		removeWidgets();
		const contentDomNode = document.createElement('button');
		contentDomNode.className = 'ash-content-widget-probe';
		contentDomNode.textContent = 'Content widget';
		contentWidget = {
			suppressMouseDown: true,
			getId: () => 'ash.integration.contentWidget',
			getDomNode: () => contentDomNode,
			getPosition: () => ({ position: new Position(2, 3), preference: [ContentWidgetPositionPreference.EXACT] }),
		};
		const glyphDomNode = document.createElement('button');
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
