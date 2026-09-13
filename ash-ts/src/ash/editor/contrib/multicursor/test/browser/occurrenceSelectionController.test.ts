import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { type TextMeasurer } from "../../../../common/viewModel/textMeasurer.js";
import { Selection } from "../../../../common/core/selection.js";
import { Position } from "../../../../common/core/position.js";
import { TextModel } from "../../../../common/model/textModel.js";
import { h } from "../../../../../base/browser/dom.js";

const browserEnvironment = new JSDOM("<!doctype html><body></body>");
class TestResizeObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}

for (const [name, value] of Object.entries({
	window: browserEnvironment.window,
	document: browserEnvironment.window.document,
	Node: browserEnvironment.window.Node,
	Element: browserEnvironment.window.Element,
	HTMLElement: browserEnvironment.window.HTMLElement,
	Event: browserEnvironment.window.Event,
	KeyboardEvent: browserEnvironment.window.KeyboardEvent,
	ResizeObserver: TestResizeObserver,
})) {
	Object.defineProperty(globalThis, name, { configurable: true, value });
}

const { TestView: View } = await import("../../../../test/browser/viewModel/testViewModel.js");
const { OccurrenceSelectionController } = await import("../../browser/occurrenceSelectionController.js");

test("Occurrence shortcuts select a word, add its next match, and select every match", () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	const container = dom.window.document.querySelector<HTMLElement>("main")!;
	using model = new TextModel("echo echo\necho");
	using viewport = new View({ container, model, lineHeight: 20, textMeasurer: new FixedTextMeasurer() });
	viewport.testViewModel.setSelections('test', [Selection.fromPositions(new Position((0) + 1, (1) + 1))]);
	viewport.layout({ width: 200, height: 60 });
	const input = h(dom.window.document, "textarea");
	container.append(input);
	using controller = new OccurrenceSelectionController(input, viewport, viewport.testViewModel);

	const selectWord = keydown(dom.window, "d", { ctrlKey: true });
	input.dispatchEvent(selectWord);
	assert.equal(selectWord.defaultPrevented, true);
	assert.deepEqual(viewport.testViewModel.getSelections()[0]!, Selection.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (4) + 1)));
	input.dispatchEvent(keydown(dom.window, "d", { ctrlKey: true }));
	assert.equal(viewport.testViewModel.getSelections().length, 2);
	input.dispatchEvent(keydown(dom.window, "l", { ctrlKey: true, shiftKey: true }));
	assert.equal(viewport.testViewModel.getSelections().length, 3);

	dom.window.close();
});

test("Occurrence controller rejects cross-model wiring and leaves unrelated chords alone", () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	const container = dom.window.document.querySelector<HTMLElement>("main")!;
	using model = new TextModel("echo");
	using other = new TextModel("echo");
	using viewport = new View({ container, model, lineHeight: 20, textMeasurer: new FixedTextMeasurer() });
	using otherViewport = new View({ container, model: other, lineHeight: 20, textMeasurer: new FixedTextMeasurer() });
	const input = h(dom.window.document, "textarea");
	container.append(input);
	using controller = new OccurrenceSelectionController(input, viewport, viewport.testViewModel);
	const unrelated = keydown(dom.window, "d", { ctrlKey: true, altKey: true });
	input.dispatchEvent(unrelated);
	assert.equal(unrelated.defaultPrevented, false);
	assert.throws(() => new OccurrenceSelectionController(input, viewport, otherViewport.testViewModel), /must share one text model/);

	dom.window.close();
});

class FixedTextMeasurer implements TextMeasurer {
	readonly horizontalPadding = 24;
	readonly contentLeftPadding = 12;

	refresh(): boolean {
		return false;
	}

	measureLineWidth(text: string): number {
		return text.length * 10;
	}
}

function keydown(targetWindow: typeof browserEnvironment.window, key: string, options: KeyboardEventInit = {}): KeyboardEvent {
	return new targetWindow.KeyboardEvent("keydown", {
		bubbles: true,
		cancelable: true,
		key,
		...options,
	}) as unknown as KeyboardEvent;
}
