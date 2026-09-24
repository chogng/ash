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
const { createTestCodeEditor } = await import('./testCodeEditor.js');

suiteTeardown(() => browserEnvironment.window.close());

test("minimal text editor assembly creates only the engine surface", () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	using domCleanup = { [Symbol.dispose]: () => dom.window.close() };
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = dom.window.document.querySelector<HTMLElement>("main")!;
	using model = new TextModel("const value = (1);");
	const resource = URI.file("C:\\project\\minimal.ts");
	using editor = createTestCodeEditor({
		container,
		ariaLabel: "minimal.ts",
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

test("typing, pair deletion and Enter share cursor history without contributions", () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	using domCleanup = { [Symbol.dispose]: () => dom.window.close() };
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel("", { languageId: "typescript" });
	using editor = createTestCodeEditor({
		container: dom.window.document.querySelector<HTMLElement>("main")!,
		model,
		contributions: [],
	});
	editor.layout({ width: 480, height: 120 });
	editor.focus();
	const input = (inputType: string, data: string | null = null) => {
		const event = new dom.window.InputEvent("beforeinput", {
			bubbles: true, cancelable: true, inputType, data,
		});
		editor.controller.element.dispatchEvent(event);
		assert.equal(event.defaultPrevented, true);
	};

	input("insertText", "(");
	assert.equal(model.getText(), "()");
	assert.equal(editor.getPosition()?.column, 2);
	editor.pushUndoStop();
	input("deleteContentBackward");
	assert.equal(model.getText(), "");
	editor.controller.undo();
	assert.equal(model.getText(), "()");
	editor.controller.undo();
	assert.equal(model.getText(), "");

	input("insertText", "value");
	editor.pushUndoStop();
	input("insertParagraph");
	assert.equal(model.getText(), "value\n");
	assert.equal(editor.getPosition()?.lineNumber, 2);
	editor.controller.undo();
	assert.equal(model.getText(), "value");
});
