import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { type TextMeasurer } from "../../common/viewModel/textMeasurer.js";
import { TextDecorationCollection } from "../../common/model/decorationCollection.js";
import { LanguageDiagnosticDecorationBridge } from "../../contrib/gotoError/common/diagnosticDecorations.js";
import { LanguageResultAcceptance } from "../../common/languages/languageResultStore.js";
import { LanguageDiagnosticSeverity, createLanguageDiagnosticStore } from "../../common/languages/languageResults.js";
import { Position } from "../../common/core/position.js";
import { Range } from "../../common/core/range.js";
import { TextModel } from "../../common/model/textModel.js";
import { GlyphMarginLane, MinimapPosition, OverviewRulerLane, TrackedRangeStickiness } from '../../common/model.js';
import { themeColorFromId } from '../../../base/common/themables.js';
import { ColorId, darkColorTheme } from '../../../platform/theme/common/colorTheme.js';


const browserEnvironment = new JSDOM("<!doctype html><body></body>");
for (const [name, value] of Object.entries({
	window: browserEnvironment.window,
	document: browserEnvironment.window.document,
	Node: browserEnvironment.window.Node,
	Element: browserEnvironment.window.Element,
	HTMLElement: browserEnvironment.window.HTMLElement,
	Event: browserEnvironment.window.Event,
})) {
	Object.defineProperty(globalThis, name, {
		configurable: true,
		value,
	});
}

const { EditorTextDirection } = await import(
	"../../browser/view.js"
);
const { TestView: View } = await import("./viewModel/testViewModel.js");
const { EditorLineWrapping } = await import(
	"../../common/config/editorOptions.js"
);

test("Model decorations project, update, and follow tracked ranges", async () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	recordCanvasPaint(dom);
	const container = requiredElement(dom.window.document, "main");
	using model = new TextModel("abcd\nefgh\nij");
	using matches = new TextDecorationCollection<string>(model);
	using diagnostics = new TextDecorationCollection<"error" | "warning">(model);
	matches.add({
		range: Range.fromPositions(new Position((0) + 1, (1) + 1), new Position((1) + 1, (2) + 1)),
		stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
		options: { description: 'find match', className: 'findMatch' },
		metadata: "match",
	});
	const diagnosticId = diagnostics.add({
		range: Range.fromPositions(new Position((2) + 1, (0) + 1), new Position((2) + 1, (2) + 1)),
		stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
		options: {
			description: 'marker decoration',
			className: 'squiggly-error',
			overviewRuler: { color: themeColorFromId(ColorId.errorForeground), position: OverviewRulerLane.Right },
			minimap: { color: themeColorFromId(ColorId.errorForeground), position: MinimapPosition.Inline },
		},
		metadata: "error",
	});
	const viewport = new View({
		container,
		model,
		glyphMargin: false,
		lineHeight: 20,
		textMeasurer: new FixedTextMeasurer(),
	});
	viewport.layout({ width: 300, height: 60 });
	viewport.scrollTo({ left: 0, top: 0 });

	assert.deepEqual(decorationElements(viewport.domNode.domNode).map(element => ({
		className: decorationClassName(element),
		lineIndex: element.parentElement?.dataset.lineIndex,
	})), [{
		className: 'findMatch',
		lineIndex: "0",
	}, {
		className: 'findMatch',
		lineIndex: "1",
	}, {
		className: 'squiggly-error',
		lineIndex: "2",
	}]);

	diagnostics.update(diagnosticId, {
		range: Range.fromPositions(new Position((1) + 1, (1) + 1), new Position((1) + 1, (3) + 1)),
		stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
		options: {
			description: 'marker decoration',
			className: 'squiggly-warning',
			overviewRuler: { color: themeColorFromId(ColorId.warningForeground), position: OverviewRulerLane.Right },
			minimap: { color: themeColorFromId(ColorId.warningForeground), position: MinimapPosition.Inline },
		},
		metadata: "warning",
	});
	await Promise.resolve();
	const warning = requiredElement<HTMLElement>(viewport.domNode.domNode, '.cdr.squiggly-warning');
	assert.equal(warning.parentElement?.dataset.lineIndex, "1");

	model.applyEdits([{
		range: Range.fromPositions(new Position((0) + 1, (0) + 1)),
		text: "X\n",
	}]);
	await Promise.resolve();

	const trackedMatch = decorationElements(viewport.domNode.domNode).filter(element => element.classList.contains('findMatch'));
	assert.deepEqual(
		trackedMatch.map(
			element => element.parentElement?.dataset.lineIndex,
		),
		["1", "2"],
	);
	assert.deepEqual(matches.decorations.map(decoration => [decoration.range.startLineNumber, decoration.range.endLineNumber]), [[2, 3]]);
	viewport.dispose();
	assert.equal(matches.size, 1);
	assert.equal(diagnostics.size, 1);

	dom.window.close();
});

test('Model glyph margin decorations use standard lanes and z-index ownership', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	const container = requiredElement(dom.window.document, 'main');
	using model = new TextModel('first\nsecond');
	using viewport = new View({ container, model, glyphMargin: true, lineHeight: 20, textMeasurer: new FixedTextMeasurer() });
	viewport.layout({ width: 240, height: 40 });
	const [lower, higher] = model.deltaDecorations([], [{
		range: new Range(1, 1, 1, 1),
		options: { description: 'lower glyph', glyphMarginClassName: 'test-glyph-lower', glyphMargin: { position: GlyphMarginLane.Center }, zIndex: 1 },
	}, {
		range: new Range(1, 1, 1, 1),
		options: { description: 'higher glyph', glyphMarginClassName: 'test-glyph-higher', glyphMargin: { position: GlyphMarginLane.Center }, zIndex: 2 },
	}]);
	viewport.render(true, true);

	assert.equal(viewport.domNode.domNode.querySelector('.test-glyph-lower'), null);
	const rendered = requiredElement<HTMLElement>(viewport.domNode.domNode, '.test-glyph-higher');
	assert.equal(rendered.getAttribute('aria-hidden'), 'true');
	assert.equal(rendered.style.top, '0px');
	model.deltaDecorations([lower, higher], []);
	viewport.render(true, true);
	assert.equal(viewport.domNode.domNode.querySelector('.test-glyph-higher'), null);
	dom.window.close();
});

test("Line and block decoration parts project standard model options", () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	const container = requiredElement(dom.window.document, "main");
	using model = new TextModel("first\nsecond\nthird");
	using decorations = new TextDecorationCollection<"lines" | "block">(model);
	decorations.add({
		range: Range.fromPositions(new Position((0) + 1, (0) + 1), new Position((2) + 1, (0) + 1)),
		stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
		options: {
			description: 'test line decoration',
			linesDecorationsClassName: 'stanza-test-line-marker',
			firstLineDecorationClassName: 'stanza-test-first-line-marker',
			linesDecorationsTooltip: 'line marker',
		},
		metadata: "lines",
	});
	decorations.add({
		range: Range.fromPositions(new Position((0) + 1, (0) + 1), new Position((2) + 1, (1) + 1)),
		stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
		options: {
			description: 'test block decoration',
			blockClassName: 'stanza-test-block',
			blockPadding: [1, 2, 3, 4],
		},
		metadata: "block",
	});
	using viewport = new View({
		container,
		model,
		glyphMargin: false,
		lineHeight: 20,
		textMeasurer: new FixedTextMeasurer(),
	});
	viewport.layout({ width: 200, height: 60 });

	const firstLine = requiredElement<HTMLElement>(viewport.domNode.domNode, '.margin-view-overlays .view-overlay-line[data-line-index="0"]');
	const secondLine = requiredElement<HTMLElement>(viewport.domNode.domNode, '.margin-view-overlays .view-overlay-line[data-line-index="1"]');
	const thirdLine = requiredElement<HTMLElement>(viewport.domNode.domNode, '.margin-view-overlays .view-overlay-line[data-line-index="2"]');
	const lineMarker = requiredElement<HTMLElement>(firstLine, ".stanza-test-line-marker");
	const firstLineMarker = requiredElement<HTMLElement>(firstLine, ".stanza-test-first-line-marker");
	const secondMarker = requiredElement<HTMLElement>(secondLine, ".stanza-editor-line-decoration");
	assert.equal(lineMarker.title, "line marker");
	assert.equal(firstLineMarker.title, "line marker");
	assert.equal(lineMarker.style.width.length > 0, true);
	assert.equal(secondMarker.classList.contains("stanza-test-line-marker"), true);
	assert.equal(secondMarker.classList.contains("stanza-test-first-line-marker"), false);
	assert.equal(requiredElement<HTMLElement>(thirdLine, '.stanza-test-line-marker').title, 'line marker');

	const block = requiredElement<HTMLElement>(viewport.domNode.domNode, ".stanza-editor-block-decoration");
	const blockContainer = requiredElement<HTMLElement>(viewport.domNode.domNode, ".stanza-editor-block-decorations");
	assert.equal(blockContainer.getAttribute("role"), "presentation");
	assert.equal(blockContainer.getAttribute("aria-hidden"), "true");
	assert.equal(block.classList.contains("stanza-test-block"), true);
	const layoutInfo = viewport.getLayoutInfo();
	assert.equal(block.style.left, `${layoutInfo.contentLeft - 4}px`);
	assert.equal(block.style.width, `${layoutInfo.contentWidth - layoutInfo.verticalScrollbarWidth + 6}px`);
	assert.equal(block.style.top, "-1px");
	assert.equal(block.style.height, "64px");

	viewport.layout({ width: 240, height: 60 });
	const resizedBlock = requiredElement<HTMLElement>(viewport.domNode.domNode, ".stanza-editor-block-decoration");
	assert.strictEqual(resizedBlock, block);
	const resizedLayoutInfo = viewport.getLayoutInfo();
	assert.equal(resizedBlock.style.width, `${resizedLayoutInfo.contentWidth - resizedLayoutInfo.verticalScrollbarWidth + 6}px`);
	dom.window.close();
});

test("Quick Diff decorations project into the overview ruler and minimap gutter", () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	const minimapPaint = recordCanvasPaint(dom);
	const container = requiredElement(dom.window.document, "main");
	using model = new TextModel("same\nadded\nmodified\nafter delete");
	using decorations = new TextDecorationCollection<'added' | 'modified' | 'deleted'>(model);
	decorations.replaceAll([
		{
			range: Range.fromPositions(new Position((1) + 1, (0) + 1)),
			stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
			options: { description: 'added diff', minimap: { color: themeColorFromId(ColorId.diffEditorInsertedLineMarker), position: MinimapPosition.Gutter } },
			metadata: 'added',
		},
		{
			range: Range.fromPositions(new Position((2) + 1, (0) + 1)),
			stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
			options: { description: 'modified diff', overviewRuler: { color: themeColorFromId(ColorId.warningForeground), position: OverviewRulerLane.Left } },
			metadata: 'modified',
		},
		{
			range: Range.fromPositions(new Position((3) + 1, (0) + 1)),
			stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
			options: {
				description: 'deleted diff',
				overviewRuler: { color: themeColorFromId(ColorId.errorForeground), position: OverviewRulerLane.Left },
				minimap: { color: themeColorFromId(ColorId.errorForeground), position: MinimapPosition.Gutter },
			},
			metadata: 'deleted',
		},
	]);
	using viewport = new View({
		container,
		model,
		lineHeight: 20,
		textMeasurer: new FixedTextMeasurer(),
	});
	viewport.layout({ width: 300, height: 80 });

	assert.deepEqual(overviewMarkerColors(minimapPaint), ['#cca700', '#f48771']);
	assert.deepEqual(overviewCursorColors(minimapPaint), [darkColorTheme.getColor(ColorId.editorCursorForeground)!.transparent(0.7).toString()]);
	assert.equal(requiredElement(viewport.domNode.domNode, '.decorationsOverviewRuler').getAttribute('aria-hidden'), 'true');
	assert.deepEqual(minimapMarkers(minimapPaint), [
		{ fill: '#89d185', top: 20 },
		{ fill: '#f48771', top: 60 },
	]);
	dom.window.close();
});

test('Overview ruler omits cursor markers when hideCursorInOverviewRuler is enabled', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	const paint = recordCanvasPaint(dom);
	const container = requiredElement(dom.window.document, 'main');
	using model = new TextModel('first\nsecond');
	using viewport = new View({
		container,
		model,
		lineHeight: 20,
		textMeasurer: new FixedTextMeasurer(),
		cursorOptions: { hideCursorInOverviewRuler: true },
	});
	viewport.layout({ width: 240, height: 40 });

	assert.deepEqual(overviewCursorColors(paint), []);
	dom.window.close();
});

test("Decoration overlays use browser range rectangles for RTL text", async () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	const container = requiredElement(dom.window.document, "main");
	const createRange = dom.window.document.createRange.bind(dom.window.document);
	Object.defineProperty(dom.window.document, "createRange", {
		configurable: true,
		value: () => {
			const range = createRange();
			Object.defineProperty(range, "getClientRects", {
				configurable: true,
				value: () => [testRectangle(150, 0, 20), testRectangle(120, 0, 15)],
			});
			return range;
		},
	});
	using model = new TextModel("abc אבג");
	using decorations = new TextDecorationCollection<void>(model);
	const id = decorations.add({
		range: Range.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (3) + 1)),
		stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
		options: { description: 'rtl match', className: 'findMatch' },
		metadata: undefined,
	});
	const viewport = new View({
		container,
		model,
		lineHeight: 20,
		textMeasurer: new FixedTextMeasurer(),
		textDirection: EditorTextDirection.RightToLeft,
	});
	viewport.layout({ width: 200, height: 40 });
	const line = requiredElement<HTMLElement>(viewport.domNode.domNode, ".view-line");
	Object.defineProperty(line, "getBoundingClientRect", {
		configurable: true,
		value: () => testRectangle(100, 0, 200),
	});
	decorations.update(id, {
		range: Range.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (3) + 1)),
		stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
		options: { description: 'rtl match', className: 'findMatch' },
		metadata: undefined,
	});
	await Promise.resolve();

	assert.deepEqual(decorationElements(viewport.domNode.domNode).map(element => ({ left: element.style.left, width: element.style.width })), [
		{ left: "20px", width: "15px" },
		{ left: "50px", width: "20px" },
	]);
	viewport.dispose();
	dom.window.close();
});

test("Decoration overlays split at soft-wrapped visual line boundaries", () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	const container = requiredElement(dom.window.document, "main");
	using model = new TextModel("abcdef");
	using decorations = new TextDecorationCollection<void>(model);
	decorations.add({
		range: Range.fromPositions(new Position((0) + 1, (1) + 1), new Position((0) + 1, (5) + 1)),
		stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
		options: { description: 'wrapped match', className: 'findMatch' },
		metadata: undefined,
	});
	using viewport = new View({
		container,
		model,
		glyphMargin: false,
		lineHeight: 20,
		textMeasurer: new FixedTextMeasurer(),
		lineWrapping: EditorLineWrapping.On,
		minimap: { enabled: false },
	});
	viewport.layout({ width: 70, height: 60 });
	assert.deepEqual(decorationElements(viewport.domNode.domNode).map(element => ({
		lineIndex: element.parentElement?.dataset.lineIndex,
		left: element.style.left,
		width: element.style.width,
	})), [{
		lineIndex: "0",
		left: "8px",
		width: "8px",
	}, {
		lineIndex: "1",
		left: "0px",
		width: "16px",
	}, {
		lineIndex: "2",
		left: "0px",
		width: "8px",
	}]);

	dom.window.close();
});

test("Versioned diagnostics project named severity underlines and invalidate", async () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	const container = requiredElement(dom.window.document, "main");
	using model = new TextModel("abcd\nefgh\nijkl\nmnop");
	using store = createLanguageDiagnosticStore(model);
	using bridge = new LanguageDiagnosticDecorationBridge(store);
	const viewport = new View({
		container,
		model,
		lineHeight: 20,
		textMeasurer: new FixedTextMeasurer(),
	});
	viewport.layout({ width: 200, height: 80 });
	assert.equal(store.accept({
		requestId: 1,
		textModel: model,
		modelVersion: 1,
		value: {
			diagnostics: [
				{
					range: Range.fromPositions(new Position((0) + 1, (1) + 1), new Position((0) + 1, (3) + 1)),
					severity: LanguageDiagnosticSeverity.Error,
					message: "error",
					source: "language.lexical",
					code: "E100",
				},
				{
					range: Range.fromPositions(new Position((1) + 1, (0) + 1), new Position((1) + 1, (2) + 1)),
					severity: LanguageDiagnosticSeverity.Warning,
					message: "warning",
				},
				{
					range: Range.fromPositions(new Position((2) + 1, (0) + 1), new Position((2) + 1, (2) + 1)),
					severity: LanguageDiagnosticSeverity.Information,
					message: "information",
				},
				{
					range: Range.fromPositions(new Position((3) + 1, (1) + 1)),
					severity: LanguageDiagnosticSeverity.Hint,
					message: "hint",
				},
			],
		},
		}), LanguageResultAcceptance.Applied);
	await Promise.resolve();

	assert.deepEqual(decorationElements(viewport.domNode.domNode).map(element => ({
		className: decorationClassName(element),
		lineIndex: element.parentElement?.dataset.lineIndex,
	})), [{
		className: 'squiggly-error',
		lineIndex: "0",
	}, {
		className: 'squiggly-warning',
		lineIndex: "1",
	}, {
		className: 'squiggly-info',
		lineIndex: "2",
	}, {
		className: 'squiggly-hint',
		lineIndex: "3",
	}]);
	assert.deepEqual(model.getAllDecorations().map(decoration => hoverMessageValue(decoration.options.hoverMessage)), [
		'language.lexical E100: error',
		'warning',
		'information',
		'hint',
	]);

	model.applyEdits([{
		range: Range.fromPositions(new Position((0) + 1, (0) + 1)),
		text: "X",
	}]);
	await Promise.resolve();
	assert.deepEqual(decorationElements(viewport.domNode.domNode), []);
	assert.equal(store.result, undefined);

	viewport.dispose();
	assert.equal(store.accept({
		requestId: 2,
		textModel: model,
		modelVersion: 2,
		value: {
			diagnostics: [{
				range: Range.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (1) + 1)),
				severity: LanguageDiagnosticSeverity.Error,
				message: "after viewport",
			}],
		},
	}), LanguageResultAcceptance.Applied);
	assert.equal(bridge.decorations.size, 1);
	dom.window.close();
});

function requiredElement<T extends Element = HTMLElement>(
	container: ParentNode,
	selector: string,
): T {
	const element = container.querySelector<T>(selector);
	assert.ok(element, `Expected ${selector}`);
	return element;
}

function decorationElements(container: ParentNode): HTMLElement[] {
	return [...container.querySelectorAll<HTMLElement>(
		".view-overlays .cdr",
	)];
}

function decorationClassName(element: HTMLElement): string | undefined {
	return [...element.classList].find(className => className !== 'cdr');
}

function hoverMessageValue(message: { readonly value: string } | readonly { readonly value: string }[] | null | undefined): string | undefined {
	if (!message) return undefined;
	return 'value' in message ? message.value : message[0]?.value;
}

function testRectangle(left: number, top: number, width: number): DOMRect {
	return { left, top, width, height: 20, right: left + width, bottom: top + 20, x: left, y: top, toJSON: () => ({}) } as DOMRect;
}

interface CanvasPaint {
	readonly frame: number;
	readonly kind: 'minimap' | 'overview';
	readonly canvasHeight: number;
	readonly fill: string;
	readonly left: number;
	readonly top: number;
	readonly width: number;
	readonly height: number;
}

function recordCanvasPaint(dom: JSDOM): CanvasPaint[] {
	const paint: CanvasPaint[] = [];
	let frame = 0;
	const getContext = function (this: HTMLCanvasElement) {
		const canvas = this;
		const kind = this.classList.contains('decorationsOverviewRuler') ? 'overview' : 'minimap';
		const context = {
			fillStyle: '',
			globalAlpha: 1,
			lineWidth: 1,
			strokeStyle: '',
			clearRect(): void { frame += 1; },
			fillRect(left: number, top: number, width: number, height: number): void {
					paint.push({ frame, kind, canvasHeight: canvas.height, fill: String(this.fillStyle), left, top, width, height });
			},
			beginPath(): void {},
			moveTo(): void {},
			lineTo(): void {},
			stroke(): void {},
		};
		return context as unknown as CanvasRenderingContext2D;
	} as unknown as typeof dom.window.HTMLCanvasElement.prototype.getContext;
	dom.window.HTMLCanvasElement.prototype.getContext = getContext;
	browserEnvironment.window.HTMLCanvasElement.prototype.getContext = getContext;
	return paint;
}

function minimapMarkers(paint: readonly CanvasPaint[]): readonly { readonly fill: string; readonly top: number }[] {
	const frame = paint.filter(entry => entry.kind === 'minimap').at(-1)?.frame;
	return paint.filter(entry => entry.kind === 'minimap' && entry.frame === frame && entry.width === 3).map(entry => ({ fill: entry.fill, top: entry.top }));
}

function overviewMarkerColors(paint: readonly CanvasPaint[]): readonly string[] {
	const frame = paint.filter(entry => entry.kind === 'overview').at(-1)?.frame;
	return paint.filter(entry => entry.kind === 'overview' && entry.frame === frame && entry.height > 2 && entry.height < entry.canvasHeight).map(entry => entry.fill);
}

function overviewCursorColors(paint: readonly CanvasPaint[]): readonly string[] {
	const frame = paint.filter(entry => entry.kind === 'overview').at(-1)?.frame;
	return paint.filter(entry => entry.kind === 'overview' && entry.frame === frame && entry.height === 2).map(entry => entry.fill);
}

class FixedTextMeasurer implements TextMeasurer {
	readonly horizontalPadding = 24;
	readonly contentLeftPadding = 12;

	refresh(): boolean {
		return false;
	}

	measureLineWidth(text: string): number {
		return [...text].length * 10;
	}
}
