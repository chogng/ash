import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { type TextMeasurer } from "../../../../common/viewModel/textMeasurer.js";
import { CursorsController } from "../../../../common/cursor/cursor.js";
import { Selection } from "../../../../common/core/selection.js";
import { Position } from "../../../../common/core/position.js";
import { TextModel } from "../../../../common/model/textModel.js";
import { type ClipboardControllerOptions } from "../../browser/clipboardController.js";
import { type IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { createTestCursorsController } from '../../../../test/common/testCursorConfiguration.js';

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

class MemoryClipboardData {
	private readonly values = new Map<string, string>();

	constructor(readonly files: readonly File[] = []) {}

	get types(): readonly string[] {
		return [...this.values.keys()];
	}

	getData(type: string): string {
		return this.values.get(type) ?? "";
	}

	setData(type: string, value: string): void {
		this.values.set(type, value);
	}
}

class DeferredClipboardService implements IClipboardService {
	private readonly readRequests: Array<(text: string) => void> = [];
	private readonly writeRequests: Array<{ readonly text: string; readonly resolve: () => void }> = [];

	get readRequestCount(): number {
		return this.readRequests.length;
	}

	get writeRequestCount(): number {
		return this.writeRequests.length;
	}

	get writtenText(): string | undefined {
		return this.writeRequests[0]?.text;
	}

	readText(): Promise<string> {
		return new Promise(resolve => this.readRequests.push(resolve));
	}

	writeText(text: string): Promise<void> {
		return new Promise(resolve => this.writeRequests.push({ text, resolve }));
	}

	resolveRead(requestIndex: number, text: string): void {
		this.readRequests[requestIndex]?.(text);
	}

	resolveWrite(requestIndex = 0): void {
		this.writeRequests[requestIndex]?.resolve();
	}
}

class DeferredTextFile {
	private readonly result: Promise<string>;
	private resolveResult: ((text: string) => void) | undefined;

	constructor(readonly name: string, readonly type = '', readonly size = 16) {
		this.result = new Promise(resolve => {
			this.resolveResult = resolve;
		});
	}

	text(): Promise<string> {
		return this.result;
	}

	resolve(text: string): void {
		this.resolveResult?.(text);
	}
}

const inertClipboardService: IClipboardService = Object.freeze({
	readText: async () => '',
	writeText: async () => {},
});

const browserEnvironment = new JSDOM("<!doctype html><body></body>");
for (const [name, value] of Object.entries({
	window: browserEnvironment.window,
	document: browserEnvironment.window.document,
	Node: browserEnvironment.window.Node,
	Element: browserEnvironment.window.Element,
	HTMLElement: browserEnvironment.window.HTMLElement,
	Event: browserEnvironment.window.Event,
	InputEvent: browserEnvironment.window.InputEvent,
	KeyboardEvent: browserEnvironment.window.KeyboardEvent,
	ResizeObserver: class {
		observe(): void {}
		unobserve(): void {}
		disconnect(): void {}
	},
})) {
	Object.defineProperty(globalThis, name, {
		configurable: true,
		value,
	});
}

const { TestView: View } = await import("../../../../test/browser/viewModel/testViewModel.js");
const { ClipboardController, ClipboardLineEnding, EDITOR_CLIPBOARD_MIME, EDITOR_HTML_CLIPBOARD_MIME, EditorClipboardPasteMode, EditorEmptySelectionClipboardPolicy } = await import("../../browser/clipboardController.js");
const { SemanticTokenPresentation } = await import("../../../../browser/viewParts/viewLines/viewLine.js");
const { ViewController: EditorView } = await import('../../../../browser/view/viewController.js');

function attachClipboard(
	input: InstanceType<typeof EditorView>,
	viewport: InstanceType<typeof View>,
	selections: CursorsController,
	options: ClipboardControllerOptions = {},
	clipboardService: IClipboardService = inertClipboardService,
): InstanceType<typeof ClipboardController> {
	return new ClipboardController(input.editContext, viewport, selections, input, clipboardService, {
		...options,
		isEditingAllowed: () => !input.compositionController.composing && (options.isEditingAllowed?.() ?? true),
	});
}

test("Clipboard copies, distributes paste, cuts, and restores isolated history", () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	const container = dom.window.document.querySelector("main");
	assert.ok(container);
	using model = new TextModel("one two\nthree four");
	const copiedSelections = primaryFirst([
		selection(0, 0, 0, 3),
		selection(1, 0, 1, 5),
	], 1);
	using seedSelections = createTestCursorsController(model, copiedSelections);
	using viewport = new View({
		container,
		model,
		lineHeight: 20,
		textMeasurer: new FixedTextMeasurer(),
		selectionController: seedSelections,
	});
	viewport.layout({ width: 80, height: 40 });
	const input = viewport.controller;
	const selections = viewport.testSelectionController;
	using clipboard = attachClipboard(input, viewport, selections, {
		lineEnding: ClipboardLineEnding.LF,
	});

	const copiedData = new MemoryClipboardData();
	const copy = clipboardEvent(dom.window, "copy", copiedData);
	input.element.dispatchEvent(copy);
	assert.equal(copy.defaultPrevented, true);
	assert.equal(copiedData.getData("text/plain"), "one\nthree");
	assert.equal(copiedData.getData(EDITOR_HTML_CLIPBOARD_MIME), "<pre><code>one\nthree</code></pre>");
	assert.deepEqual(
		JSON.parse(copiedData.getData(EDITOR_CLIPBOARD_MIME)),
		{
			version: 2,
			selectionTexts: ["one", "three"],
			pasteModes: [
				EditorClipboardPasteMode.Selection,
				EditorClipboardPasteMode.Selection,
			],
		},
	);

	const pasteTargets = primaryFirst([
		selection(0, 4, 0, 7),
		selection(1, 6, 1, 10),
	], 1);
	selections.setSelections(pasteTargets);
	const paste = clipboardEvent(dom.window, "paste", copiedData);
	input.element.dispatchEvent(paste);
	assert.equal(paste.defaultPrevented, true);
	assert.deepEqual({
		text: model.getText(),
		selections: selections.getSelections(),
	}, {
		text: "one one\nthree three",
		selections: primaryFirst([
			caret(0, 7),
			caret(1, 11),
		], 0),
	});

	selections.context.model.undo();
	assert.deepEqual({
		text: model.getText(),
		selections: selections.getSelections(),
	}, {
		text: "one two\nthree four",
		selections: pasteTargets,
	});

	const cutData = new MemoryClipboardData();
	const cut = clipboardEvent(dom.window, "cut", cutData);
	input.element.dispatchEvent(cut);
	assert.equal(cut.defaultPrevented, true);
	assert.equal(cutData.getData("text/plain"), "two\nfour");
	assert.equal(model.getText(), "one \nthree ");
	selections.context.model.undo();
	assert.equal(model.getText(), "one two\nthree four");

	dom.window.close();
});

test("Clipboard spreads matching external lines and copies an empty selection as a line", () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	const container = dom.window.document.querySelector("main");
	assert.ok(container);
	using model = new TextModel("a b");
	using seedSelections = createTestCursorsController(
		model,
		primaryFirst([caret(0, 0), caret(0, 2)], 0),
	);
	using viewport = new View({
		container,
		model,
		lineHeight: 20,
		textMeasurer: new FixedTextMeasurer(),
		selectionController: seedSelections,
	});
	viewport.layout({ width: 80, height: 20 });
	const input = viewport.controller;
	const selections = viewport.testSelectionController;
	const clipboard = attachClipboard(input, viewport, selections, {
		lineEnding: ClipboardLineEnding.LF,
	});

	const externalData = new MemoryClipboardData();
	externalData.setData("text/plain", "X\r\nY");
	externalData.setData(EDITOR_CLIPBOARD_MIME, JSON.stringify({
		version: 1,
		selectionTexts: ["wrong count"],
	}));
	const paste = clipboardEvent(dom.window, "paste", externalData);
	input.element.dispatchEvent(paste);
	assert.equal(paste.defaultPrevented, true);
	assert.deepEqual({
		text: model.getText(),
		selections: selections.getSelections(),
	}, {
		text: "Xa Yb",
		selections: primaryFirst([
			caret(0, 1),
			caret(0, 4),
		], 0),
	});

	selections.setSelections([caret(0, 0)]);
	const emptyData = new MemoryClipboardData();
	const emptyCopy = clipboardEvent(dom.window, "copy", emptyData);
	input.element.dispatchEvent(emptyCopy);
	assert.equal(emptyCopy.defaultPrevented, true);
	assert.equal(emptyData.getData("text/plain"), "Xa Yb\n");

	clipboard.dispose();
	viewport.dispose();
	const disposedData = new MemoryClipboardData();
	disposedData.setData("text/plain", "ignored");
	const disposedPaste = clipboardEvent(dom.window, "paste", disposedData);
	input.element.dispatchEvent(disposedPaste);
	assert.equal(disposedPaste.defaultPrevented, false);
	assert.equal(model.getText(), "Xa Yb");

	dom.window.close();
});

test("Clipboard round-trips complete lines and preserves target columns", () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	const container = dom.window.document.querySelector("main");
	assert.ok(container);
	using model = new TextModel("one\ntwo\nthree");
	using seedSelections = createTestCursorsController(
		model,
		primaryFirst([caret(0, 1), caret(2, 2)], 1),
	);
	using viewport = new View({
		container,
		model,
		lineHeight: 20,
		textMeasurer: new FixedTextMeasurer(),
		selectionController: seedSelections,
	});
	viewport.layout({ width: 80, height: 40 });
	const input = viewport.controller;
	const selections = viewport.testSelectionController;
	using clipboard = attachClipboard(input, viewport, selections, {
		lineEnding: ClipboardLineEnding.LF,
	});

	const lineData = new MemoryClipboardData();
	input.element.dispatchEvent(clipboardEvent(dom.window, "copy", lineData));
	assert.equal(lineData.getData("text/plain"), "one\nthree\n");
	assert.deepEqual(
		JSON.parse(lineData.getData(EDITOR_CLIPBOARD_MIME)),
		{
			version: 2,
			selectionTexts: ["one\n", "three\n"],
			pasteModes: [
				EditorClipboardPasteMode.Line,
				EditorClipboardPasteMode.Line,
			],
		},
	);

	const targets = primaryFirst([
		caret(0, 2),
		caret(1, 1),
	], 1);
	selections.setSelections(targets);
	input.element.dispatchEvent(clipboardEvent(dom.window, "paste", lineData));
	assert.deepEqual({
		text: model.getText(),
		selections: selections.getSelections(),
	}, {
		text: "one\none\nthree\ntwo\nthree",
		selections: primaryFirst([
			caret(1, 2),
			caret(3, 1),
		], 0),
	});

	selections.context.model.undo();
	assert.deepEqual({
		text: model.getText(),
		selections: selections.getSelections(),
	}, {
		text: "one\ntwo\nthree",
		selections: targets,
	});

	selections.setSelections([caret(1, 2)]);
	const cutData = new MemoryClipboardData();
	input.element.dispatchEvent(clipboardEvent(dom.window, "cut", cutData));
	assert.deepEqual({
		clipboard: cutData.getData("text/plain"),
		text: model.getText(),
		selection: selections.getSelections()[0]!,
	}, {
		clipboard: "two\n",
		text: "one\nthree",
		selection: caret(1, 0),
	});
	selections.context.model.undo();
	assert.equal(model.getText(), "one\ntwo\nthree");

	dom.window.close();
});

test("Mixed line and selection metadata falls back to selection paste", () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	const container = dom.window.document.querySelector("main");
	assert.ok(container);
	using model = new TextModel("a\nb");
	using seedSelections = createTestCursorsController(
		model,
		primaryFirst([
			caret(0, 1),
			selection(1, 0, 1, 1),
		], 1),
	);
	using viewport = new View({
		container,
		model,
		lineHeight: 20,
		textMeasurer: new FixedTextMeasurer(),
		selectionController: seedSelections,
	});
	const input = viewport.controller;
	const selections = viewport.testSelectionController;
	using clipboard = attachClipboard(input, viewport, selections, {
		lineEnding: ClipboardLineEnding.LF,
	});

	const data = new MemoryClipboardData();
	input.element.dispatchEvent(clipboardEvent(dom.window, "copy", data));
	assert.deepEqual(
		JSON.parse(data.getData(EDITOR_CLIPBOARD_MIME)).pasteModes,
		[EditorClipboardPasteMode.Line, EditorClipboardPasteMode.Selection],
	);

	selections.setSelections(primaryFirst([
		caret(0, 0),
		caret(1, 0),
	], 1));
	input.element.dispatchEvent(clipboardEvent(dom.window, "paste", data));
	assert.deepEqual({
		text: model.getText(),
		selections: selections.getSelections(),
	}, {
		text: "a\na\nbb",
		selections: primaryFirst([
			caret(1, 0),
			caret(2, 1),
		], 0),
	});

	dom.window.close();
});

test("Empty-selection clipboard policy may explicitly preserve browser behavior", () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	const container = dom.window.document.querySelector("main");
	assert.ok(container);
	using model = new TextModel("abc");
	using seedSelections = createTestCursorsController(
		model,
		[caret(0, 1)],
	);
	using viewport = new View({
		container,
		model,
		lineHeight: 20,
		textMeasurer: new FixedTextMeasurer(),
		selectionController: seedSelections,
	});
	const input = viewport.controller;
	const selections = viewport.testSelectionController;
	using clipboard = attachClipboard(input, viewport, selections, {
		lineEnding: ClipboardLineEnding.LF,
		emptySelectionPolicy: EditorEmptySelectionClipboardPolicy.Ignore,
	});

	const data = new MemoryClipboardData();
	const copy = clipboardEvent(dom.window, "copy", data);
	input.element.dispatchEvent(copy);
	assert.equal(copy.defaultPrevented, true);
	assert.equal(data.getData("text/plain"), "");
	const cut = clipboardEvent(dom.window, 'cut', data);
	input.element.dispatchEvent(cut);
	assert.equal(cut.defaultPrevented, true);
	assert.equal(model.getText(), 'abc');

	dom.window.close();
});

test("Clipboard copies escaped HTML and safely falls back to external HTML text", () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	const container = dom.window.document.querySelector("main");
	assert.ok(container);
	using model = new TextModel("if (a < b && c > d) {}");
	using seedSelections = createTestCursorsController(model, [selection(0, 0, 0, model.getLineContent((0) + 1).length)]);
	using viewport = new View({
		container,
		model,
		lineHeight: 20,
		textMeasurer: new FixedTextMeasurer(),
		selectionController: seedSelections,
	});
	const input = viewport.controller;
	const selections = viewport.testSelectionController;
	using clipboard = attachClipboard(input, viewport, selections);

	const copied = new MemoryClipboardData();
	input.element.dispatchEvent(clipboardEvent(dom.window, "copy", copied));
	assert.equal(copied.getData(EDITOR_HTML_CLIPBOARD_MIME), "<pre><code>if (a &lt; b &amp;&amp; c &gt; d) {}</code></pre>");

	selections.setSelections([caret(0, model.getLineContent((0) + 1).length)]);
	const external = new MemoryClipboardData();
	external.setData(EDITOR_HTML_CLIPBOARD_MIME, "<div>first &amp; second</div><div><strong>third</strong><br>fourth</div><script>ignored()</script>");
	const paste = clipboardEvent(dom.window, "paste", external);
	input.element.dispatchEvent(paste);
	assert.equal(paste.defaultPrevented, true);
	assert.equal(model.getText(), "if (a < b && c > d) {}first & second\nthird\nfourth");

	dom.window.close();
});

test("Clipboard preserves current semantic token markup in portable HTML", () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	const container = dom.window.document.querySelector("main");
	assert.ok(container);
	dom.window.document.documentElement.style.setProperty("--ash-editor-token-keyword-foreground", "rgb(1, 2, 3)");
	using model = new TextModel("const value\nnext");
	using seedSelections = createTestCursorsController(model, [selection(0, 0, 1, model.getLineContent((1) + 1).length)]);
	using viewport = new View({
		container,
		model,
		lineHeight: 20,
		textMeasurer: new FixedTextMeasurer(),
		selectionController: seedSelections,
	});
	const semanticTokens = {
		textModel: model,
		onDidChange: () => ({ dispose() {}, [Symbol.dispose]() {} }),
		lines: [],
		getLineTokens: (lineIndex: number) => lineIndex === 0
			? [{
				startColumn: 0,
				endColumn: 5,
				presentation: SemanticTokenPresentation.Keyword,
			}]
			: lineIndex === 1
				? [{
					startColumn: 0,
					endColumn: 4,
					presentation: SemanticTokenPresentation.Keyword,
				}]
				: [],
	};
	const input = viewport.controller;
	const selections = viewport.testSelectionController;
	using clipboard = attachClipboard(input, viewport, selections, {
		lineEnding: ClipboardLineEnding.LF,
		semanticTokens,
	});

	const copied = new MemoryClipboardData();
	input.element.dispatchEvent(clipboardEvent(dom.window, "copy", copied));
	assert.equal(copied.getData("text/plain"), "const value\nnext");
	assert.equal(
		copied.getData(EDITOR_HTML_CLIPBOARD_MIME),
		'<pre><code><span class="stanza-editor-token token-keyword" style="color: rgb(1, 2, 3)">const</span> value\n<span class="stanza-editor-token token-keyword" style="color: rgb(1, 2, 3)">next</span></code></pre>',
	);

	selections.setSelections([caret(1, 2)]);
	const lineCopied = new MemoryClipboardData();
	input.element.dispatchEvent(clipboardEvent(dom.window, "copy", lineCopied));
	assert.equal(
		lineCopied.getData(EDITOR_HTML_CLIPBOARD_MIME),
		'<pre><code><span class="stanza-editor-token token-keyword" style="color: rgb(1, 2, 3)">next</span>\n</code></pre>',
	);

	dom.window.close();
});

test('Clipboard reads system text only for an empty event transfer', async () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	const container = dom.window.document.querySelector("main");
	assert.ok(container);
	using model = new TextModel("one");
	using seedSelections = createTestCursorsController(model, [caret(0, 3)]);
	using viewport = new View({
		container,
		model,
		lineHeight: 20,
		textMeasurer: new FixedTextMeasurer(),
		selectionController: seedSelections,
	});
	const clipboardService = new DeferredClipboardService();
	const input = viewport.controller;
	const selections = viewport.testSelectionController;
	using clipboard = attachClipboard(input, viewport, selections, {}, clipboardService);

	const fallbackPaste = clipboardEvent(dom.window, "paste", new MemoryClipboardData());
	input.element.dispatchEvent(fallbackPaste);
	assert.equal(fallbackPaste.defaultPrevented, true);
	assert.equal(clipboardService.readRequestCount, 1);
	clipboardService.resolveRead(0, ' two');
	await flushPromises();
	assert.equal(model.getText(), "one two");

	selections.setSelections([caret(0, 0)]);
	input.element.dispatchEvent(clipboardEvent(dom.window, "paste", new MemoryClipboardData()));
	assert.equal(clipboardService.readRequestCount, 2);
	selections.setSelections([caret(0, 1)]);
	clipboardService.resolveRead(1, 'ignored');
	await flushPromises();
	assert.equal(model.getText(), "one two");

	const nativeText = new MemoryClipboardData();
	nativeText.setData("text/plain", "!");
	selections.setSelections([caret(0, model.getLineContent((0) + 1).length)]);
	input.element.dispatchEvent(clipboardEvent(dom.window, "paste", nativeText));
	assert.equal(clipboardService.readRequestCount, 2);
	assert.equal(model.getText(), "one two!");

	dom.window.close();
});

test('Clipboard owns URI-list and bounded text-file paste', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	const container = dom.window.document.querySelector('main');
	assert.ok(container);
	using model = new TextModel('one');
	using seedSelections = createTestCursorsController(model, [caret(0, 3)]);
	using viewport = new View({ container, model, lineHeight: 20, textMeasurer: new FixedTextMeasurer(), selectionController: seedSelections });
	const input = viewport.controller;
	const selections = viewport.testSelectionController;
	using clipboard = attachClipboard(input, viewport, selections);

	const uriData = new MemoryClipboardData();
	uriData.setData('text/uri-list', '# copied URI\nfile:///workspace/one.rs\nhttps://example.test/two');
	const uriPaste = clipboardEvent(dom.window, 'paste', uriData);
	input.element.dispatchEvent(uriPaste);
	assert.equal(uriPaste.defaultPrevented, true);
	assert.equal(model.getText(), 'onefile:///workspace/one.rs\nhttps://example.test/two');

	const file = new DeferredTextFile('snippet.rs');
	const filePaste = clipboardEvent(dom.window, 'paste', new MemoryClipboardData([file as unknown as File]));
	input.element.dispatchEvent(filePaste);
	assert.equal(filePaste.defaultPrevented, true);
	file.resolve('\nlet value = 1;');
	await flushPromises();
	assert.equal(model.getText(), 'onefile:///workspace/one.rs\nhttps://example.test/two\nlet value = 1;');
	dom.window.close();
});

test('Clipboard writes system text and delays cut until it succeeds', async () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	const container = dom.window.document.querySelector("main");
	assert.ok(container);
	using model = new TextModel("one");
	using seedSelections = createTestCursorsController(model, [selection(0, 0, 0, 3)]);
	using viewport = new View({ container, model, lineHeight: 20, textMeasurer: new FixedTextMeasurer(), selectionController: seedSelections });
	const clipboardService = new DeferredClipboardService();
	const input = viewport.controller;
	const selections = viewport.testSelectionController;
	using clipboard = attachClipboard(input, viewport, selections, {}, clipboardService);

	const copy = clipboardEvent(dom.window, "copy", null);
	input.element.dispatchEvent(copy);
	assert.equal(copy.defaultPrevented, true);
	assert.equal(clipboardService.writeRequestCount, 1);
	assert.equal(clipboardService.writtenText, "one");
	clipboardService.resolveWrite();
	await flushPromises();
	assert.equal(model.getText(), "one");

	const cut = clipboardEvent(dom.window, "cut", null);
	input.element.dispatchEvent(cut);
	assert.equal(cut.defaultPrevented, true);
	assert.equal(clipboardService.writeRequestCount, 2);
	assert.equal(model.getText(), "one");
	clipboardService.resolveWrite(1);
	await flushPromises();
	assert.equal(model.getText(), "");
	dom.window.close();
});

test("Clipboard preserves an active IME composition by rejecting mutable clipboard operations", () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	const container = dom.window.document.querySelector("main");
	assert.ok(container);
	using model = new TextModel("one");
	using seedSelections = createTestCursorsController(model, [caret(0, 3)]);
	using viewport = new View({
		container,
		model,
		lineHeight: 20,
		textMeasurer: new FixedTextMeasurer(),
		selectionController: seedSelections,
	});
	const input = viewport.controller;
	const selections = viewport.testSelectionController;
	using clipboard = attachClipboard(input, viewport, selections);
	input.element.dispatchEvent(compositionEvent(dom.window, "compositionstart", ""));
	assert.equal(input.compositionController.composing, true);

	const pasteData = new MemoryClipboardData();
	pasteData.setData("text/plain", " changed");
	const paste = clipboardEvent(dom.window, "paste", pasteData);
	input.element.dispatchEvent(paste);
	assert.equal(paste.defaultPrevented, true);
	assert.equal(model.getText(), "one");
	assert.equal(input.compositionController.composing, true);

	input.element.dispatchEvent(compositionEvent(dom.window, "compositionend", ""));
	assert.equal(input.compositionController.composing, false);
	dom.window.close();
});

function clipboardEvent(targetWindow: typeof browserEnvironment.window, type: "copy" | "cut" | "paste", clipboardData: MemoryClipboardData | null): ClipboardEvent {
	const event = new targetWindow.Event(type, {
		bubbles: true,
		cancelable: true,
	}) as unknown as ClipboardEvent;
	Object.defineProperty(event, "clipboardData", {
		configurable: true,
		value: clipboardData as unknown as DataTransfer | null,
	});
	return event;
}

function compositionEvent(targetWindow: typeof browserEnvironment.window, type: "compositionstart" | "compositionend", data: string): CompositionEvent {
	const event = new targetWindow.Event(type, {
		bubbles: true,
		cancelable: true,
	}) as unknown as CompositionEvent;
	Object.defineProperty(event, "data", {
		configurable: true,
		value: data,
	});
	return event;
}

function selection(startLine: number, startColumn: number, endLine: number, endColumn: number): Selection {
	return Selection.fromPositions(
		new Position((startLine) + 1, (startColumn) + 1),
		new Position((endLine) + 1, (endColumn) + 1),
	);
}

function caret(lineIndex: number, columnIndex: number): Selection {
	return Selection.fromPositions(new Position((lineIndex) + 1, (columnIndex) + 1));
}

async function flushPromises(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

function primaryFirst<T>(items: readonly T[], primaryIndex: number): readonly T[] {
	if (primaryIndex === 0) return Object.freeze([...items]);
	return Object.freeze([items[primaryIndex]!, ...items.slice(0, primaryIndex), ...items.slice(primaryIndex + 1)]);
}
