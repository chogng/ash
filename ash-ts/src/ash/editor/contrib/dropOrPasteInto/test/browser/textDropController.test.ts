import assert from "node:assert/strict";
import { test, suiteTeardown } from "mocha";
import { JSDOM } from "jsdom";
import { type TextMeasurer } from "../../../../common/viewModel/textMeasurer.js";
import { Selection } from "../../../../common/core/selection.js";
import { Position } from "../../../../common/core/position.js";
import { TextModel } from "../../../../common/model/textModel.js";
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

class MemoryDragData {
	dropEffect = "none";

	constructor(readonly types: readonly string[], private readonly values: ReadonlyMap<string, string>, readonly files: readonly File[] = []) {}

	getData(type: string): string {
		return this.values.get(type) ?? "";
	}
}

class DeferredTextFile {
	private readonly result: Promise<string>;
	private resolveResult: ((text: string) => void) | undefined;

	constructor(readonly name: string, readonly type = "", readonly size = 16) {
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

const browserEnvironment = new JSDOM("<!doctype html><body></body>");
for (const [name, value] of Object.entries({
	window: browserEnvironment.window,
	document: browserEnvironment.window.document,
	Node: browserEnvironment.window.Node,
	Element: browserEnvironment.window.Element,
	HTMLElement: browserEnvironment.window.HTMLElement,
	Event: browserEnvironment.window.Event,
})) {
	Object.defineProperty(globalThis, name, { configurable: true, value });
}

const { TestView: View } = await import('../../../../test/browser/viewModel/testViewModel.js');
const { TextDropController } = await import('../../browser/textDropController.js');

const progress = {
	showWhile: <T>(_position: Position, _title: string, promise: Promise<T>): Promise<T> => promise,
};

suiteTeardown(() => browserEnvironment.window.close());

test("Plain-text drops insert at the viewport hit target", () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	const container = dom.window.document.querySelector<HTMLElement>("main")!;
	using model = new TextModel("ab\ncd");
	using selections = createTestCursorsController(model, [Selection.fromPositions(new Position((1) + 1, (0) + 1))]);
	using viewport = new View({ container, model, lineHeight: 20, textMeasurer: new FixedTextMeasurer(), selectionController: selections });
	viewport.domNode.domNode.getBoundingClientRect = () => rectangle(120, 40);
	viewport.layout({ width: 120, height: 40 });
	using controller = new TextDropController(viewport, selections, progress);
	const data = new MemoryDragData(["text/plain"], new Map([["text/plain", "X\r\nY"]]));

	const dragOver = dragEvent(dom.window, "dragover", data, 100, 5);
	viewport.domNode.domNode.dispatchEvent(dragOver);
	assert.equal(dragOver.defaultPrevented, true);
	assert.equal(data.dropEffect, "copy");

	const drop = dragEvent(dom.window, "drop", data, 100, 5);
	viewport.domNode.domNode.dispatchEvent(drop);
	assert.equal(drop.defaultPrevented, true);
	assert.equal(model.getText(), "abX\nY\ncd");
	assert.deepEqual(selections.getSelections(), [Selection.fromPositions(new Position((1) + 1, (1) + 1))]);
	dom.window.close();
});

test("Non-text drops remain available to their host", () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	const container = dom.window.document.querySelector<HTMLElement>("main")!;
	using model = new TextModel("alpha");
	using selections = createTestCursorsController(model, [Selection.fromPositions(new Position((0) + 1, (0) + 1))]);
	using viewport = new View({ container, model, lineHeight: 20, textMeasurer: new FixedTextMeasurer(), selectionController: selections });
	viewport.domNode.domNode.getBoundingClientRect = () => rectangle(120, 20);
	viewport.layout({ width: 120, height: 20 });
	using controller = new TextDropController(viewport, selections, progress);
	const data = new MemoryDragData(["Files"], new Map());

	const dragOver = dragEvent(dom.window, "dragover", data, 50, 5);
	const drop = dragEvent(dom.window, "drop", data, 50, 5);
	viewport.domNode.domNode.dispatchEvent(dragOver);
	viewport.domNode.domNode.dispatchEvent(drop);
	assert.equal(dragOver.defaultPrevented, false);
	assert.equal(drop.defaultPrevented, false);
	assert.equal(model.getText(), "alpha");
	dom.window.close();
});

test("Read-only editors leave text drops available to their host", () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	const container = dom.window.document.querySelector<HTMLElement>("main")!;
	using model = new TextModel("alpha");
	using selections = createTestCursorsController(
		model,
		[Selection.fromPositions(new Position((0) + 1, (0) + 1))],
		{ readOnly: true },
	);
	using viewport = new View({ container, model, lineHeight: 20, textMeasurer: new FixedTextMeasurer(), selectionController: selections });
	viewport.domNode.domNode.getBoundingClientRect = () => rectangle(120, 20);
	viewport.layout({ width: 120, height: 20 });
	using controller = new TextDropController(viewport, selections, progress);
	const data = new MemoryDragData(["text/plain"], new Map([["text/plain", "dropped"]]));

	const dragOver = dragEvent(dom.window, "dragover", data, 50, 5);
	const drop = dragEvent(dom.window, "drop", data, 50, 5);
	viewport.domNode.domNode.dispatchEvent(dragOver);
	viewport.domNode.domNode.dispatchEvent(drop);

	assert.equal(dragOver.defaultPrevented, false);
	assert.equal(drop.defaultPrevented, false);
	assert.equal(model.getText(), "alpha");
	dom.window.close();
});

test("Rich HTML drops reduce to inert text when plain text is unavailable", () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	const container = dom.window.document.querySelector<HTMLElement>("main")!;
	using model = new TextModel("ab");
	using selections = createTestCursorsController(model, [Selection.fromPositions(new Position((0) + 1, (0) + 1))]);
	using viewport = new View({ container, model, lineHeight: 20, textMeasurer: new FixedTextMeasurer(), selectionController: selections });
	viewport.domNode.domNode.getBoundingClientRect = () => rectangle(120, 20);
	viewport.layout({ width: 120, height: 20 });
	using controller = new TextDropController(viewport, selections, progress);
	const data = new MemoryDragData(["text/html"], new Map([["text/html", "<div>first</div><script>ignored()</script><div>second<br>third</div>"]]));

	const dragOver = dragEvent(dom.window, "dragover", data, 100, 5);
	viewport.domNode.domNode.dispatchEvent(dragOver);
	assert.equal(dragOver.defaultPrevented, true);
	const drop = dragEvent(dom.window, "drop", data, 100, 5);
	viewport.domNode.domNode.dispatchEvent(drop);
	assert.equal(drop.defaultPrevented, true);
	assert.equal(model.getText(), "abfirst\nsecond\nthird");
	dom.window.close();
});

test("One user-provided text file drop inserts at the hit target after decoding", async () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	const container = dom.window.document.querySelector<HTMLElement>("main")!;
	using model = new TextModel("ab\ncd");
	using selections = createTestCursorsController(model, [Selection.fromPositions(new Position((0) + 1, (0) + 1))]);
	using viewport = new View({ container, model, lineHeight: 20, textMeasurer: new FixedTextMeasurer(), selectionController: selections });
	viewport.domNode.domNode.getBoundingClientRect = () => rectangle(120, 40);
	viewport.layout({ width: 120, height: 40 });
	using controller = new TextDropController(viewport, selections, progress);
	const file = new DeferredTextFile("snippet.rs");
	const data = new MemoryDragData(["Files"], new Map(), [file as unknown as File]);

	const dragOver = dragEvent(dom.window, "dragover", data, 100, 5);
	viewport.domNode.domNode.dispatchEvent(dragOver);
	assert.equal(dragOver.defaultPrevented, true);
	assert.equal(data.dropEffect, "copy");

	const drop = dragEvent(dom.window, "drop", data, 100, 5);
	viewport.domNode.domNode.dispatchEvent(drop);
	assert.equal(drop.defaultPrevented, true);
	file.resolve("X\r\nY");
	await flushPromises();
	assert.equal(model.getText(), "abX\nY\ncd");

	dom.window.close();
});

function dragEvent(targetWindow: typeof browserEnvironment.window, type: string, dataTransfer: MemoryDragData, clientX: number, clientY: number): DragEvent {
	const event = new targetWindow.Event(type, { bubbles: true, cancelable: true });
	Object.defineProperties(event, {
		clientX: { value: clientX },
		clientY: { value: clientY },
		dataTransfer: { value: dataTransfer },
	});
	return event as unknown as DragEvent;
}

function rectangle(width: number, height: number): DOMRect {
	return {
		x: 0,
		y: 0,
		width,
		height,
		top: 0,
		right: width,
		bottom: height,
		left: 0,
		toJSON: () => ({}),
	};
}

async function flushPromises(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}
