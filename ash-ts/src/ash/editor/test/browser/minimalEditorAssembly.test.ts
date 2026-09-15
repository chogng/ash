import assert from "node:assert/strict";
import { test, suiteTeardown } from "mocha";
import { JSDOM } from "jsdom";
import { URI } from "../../../base/common/uri.js";
import { TextModel } from "../../common/model/textModel.js";

const browserEnvironment = new JSDOM("<!doctype html><body></body>");
for (const [name, value] of Object.entries({
	window: browserEnvironment.window,
	document: browserEnvironment.window.document,
	Node: browserEnvironment.window.Node,
	Element: browserEnvironment.window.Element,
	HTMLElement: browserEnvironment.window.HTMLElement,
	Event: browserEnvironment.window.Event,
	InputEvent: browserEnvironment.window.InputEvent,
	ResizeObserver: class {
		observe(): void {}
		unobserve(): void {}
		disconnect(): void {}
	},
})) Object.defineProperty(globalThis, name, { configurable: true, value });

const { CodeEditorWidget } = await import('../../browser/widget/codeEditor/codeEditorWidget.js');

suiteTeardown(() => browserEnvironment.window.close());

test("minimal text editor assembly creates only the engine surface", () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	using domCleanup = { [Symbol.dispose]: () => dom.window.close() };
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = dom.window.document.querySelector<HTMLElement>("main")!;
	using model = new TextModel("const value = (1);");
	const resource = URI.file("C:\\project\\minimal.ts");
	using editor = new CodeEditorWidget({
		container,
		input: { resource, label: "minimal.ts" },
		languageId: "typescript",
		model,
		placeholder: "Not installed",
	});
	editor.layout({ width: 480, height: 120 });

	assert.ok(container.querySelector(".stanza-editor"));
	assert.ok(container.querySelector(".stanza-editor-input"));
	assert.equal(container.querySelector(".stanza-editor-token"), null);
	assert.equal(container.querySelector(".view-overlays .cdr"), null);
	assert.equal(container.querySelector(".stanza-editor-fold-toggle"), null);
	assert.equal(container.querySelector(".stanza-editor-completion"), null);
	assert.equal(container.querySelector(".stanza-editor-placeholder-text"), null);

	const copy = new dom.window.Event("copy", { bubbles: true, cancelable: true });
	editor.controller.element.dispatchEvent(copy);
	assert.equal(copy.defaultPrevented, true);
});
