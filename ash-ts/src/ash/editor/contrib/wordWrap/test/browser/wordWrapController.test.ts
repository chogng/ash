import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { type TextMeasurer } from "../../../../common/viewModel/textMeasurer.js";
import { TextModel } from "../../../../common/model/textModel.js";
import { h } from "../../../../../base/browser/dom.js";

const browserEnvironment = new JSDOM("<!doctype html><body></body>");
for (const [name, value] of Object.entries({
	window: browserEnvironment.window,
	document: browserEnvironment.window.document,
	Node: browserEnvironment.window.Node,
	Element: browserEnvironment.window.Element,
	HTMLElement: browserEnvironment.window.HTMLElement,
	Event: browserEnvironment.window.Event,
	KeyboardEvent: browserEnvironment.window.KeyboardEvent,
})) {
	Object.defineProperty(globalThis, name, { configurable: true, value });
}

const { TestView: View } = await import("../../../../test/browser/viewModel/testViewModel.js");
const { EditorLineWrapping } = await import("../../../../common/config/editorOptions.js");
const { WordWrapController } = await import("../../browser/wordWrapController.js");

test("Word-wrap shortcut switches Stanza's visual projection without editing text", () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	const container = dom.window.document.querySelector<HTMLElement>("main")!;
	using model = new TextModel("abcdef");
	using viewport = new View({ container, model, glyphMargin: false, lineHeight: 20, textMeasurer: new FixedTextMeasurer(), minimap: { enabled: false } });
	viewport.layout({ width: 70, height: 40 });
	const input = h(dom.window.document, "textarea");
	container.append(input);
	using controller = new WordWrapController(input, viewport);

	const enable = keydown(dom.window, "z", { altKey: true });
	input.dispatchEvent(enable);
	assert.equal(enable.defaultPrevented, true);
	assert.equal(viewport.lineWrapping, EditorLineWrapping.On);
	assert.equal(viewport.domNode.domNode.classList.contains("word-wrapped"), true);
	assert.equal(viewport.viewportLayout.contentSize.height, 60);
	assert.equal(model.getText(), "abcdef");

	const disable = keydown(dom.window, "z", { altKey: true });
	input.dispatchEvent(disable);
	assert.equal(disable.defaultPrevented, true);
	assert.equal(viewport.lineWrapping, EditorLineWrapping.Off);
	assert.equal(viewport.domNode.domNode.classList.contains("word-wrapped"), false);
	assert.equal(viewport.viewportLayout.contentSize.height, 40);

	const unrelated = keydown(dom.window, "z", { altKey: true, shiftKey: true });
	input.dispatchEvent(unrelated);
	assert.equal(unrelated.defaultPrevented, false);
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

function keydown(targetWindow: typeof browserEnvironment.window, key: string, options: { readonly altKey?: boolean; readonly shiftKey?: boolean } = {}): KeyboardEvent {
	return new targetWindow.KeyboardEvent("keydown", {
		bubbles: true,
		cancelable: true,
		key,
		altKey: options.altKey,
		shiftKey: options.shiftKey,
	}) as unknown as KeyboardEvent;
}
