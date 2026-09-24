import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { TextModel } from "../../../../common/model/textModel.js";
import { URI } from "../../../../../base/common/uri.js";
import { DisposableStore, toDisposable } from "../../../../../base/common/lifecycle.js";

const browserEnvironment = new JSDOM("<!doctype html><body></body>");
browserEnvironment.window.HTMLCanvasElement.prototype.getContext = () => null;
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

const { EditorOption } = await import("../../../../common/config/editorOptions.js");
const { WordWrapController } = await import("../../browser/wordWrapController.js");
const { createTestCodeEditor } = await import("../../../../test/browser/testCodeEditor.js");
const { StandaloneCodeEditorService } = await import("../../../../standalone/browser/standaloneCodeEditorService.js");
const { ICodeEditorService } = await import("../../../../browser/services/codeEditorService.js");
const { ServiceContainer } = await import("../../../../../platform/instantiation/common/instantiation.js");

test("word-wrap choice follows the model and leaves the editor setting unchanged", () => {
	const dom = new JSDOM("<!doctype html><body><main></main><aside></aside></body>");
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = dom.window.document.querySelector<HTMLElement>("main")!;
	using resources = new DisposableStore();
	resources.add(toDisposable(() => dom.window.close()));
	using first = new TextModel("abcdef", { resource: URI.parse("inmemory://word-wrap/first") });
	using second = new TextModel("ghijkl", { resource: URI.parse("inmemory://word-wrap/second") });
	const services = resources.add(new ServiceContainer());
	const codeEditorService = resources.add(new StandaloneCodeEditorService());
	services.registerInstance(ICodeEditorService, codeEditorService);
	using editor = createTestCodeEditor({
		container,
		model: first,
		input: { resource: first.uri },
		languageId: first.getLanguageId(),
		instantiationService: services,
		wordWrap: "off",
		minimap: { enabled: false },
	});
	editor.layout({ width: 70, height: 40 });
	const input = editor.getDomNode()?.querySelector<HTMLElement>(".stanza-editor-input");
	assert.ok(input);
	const controller = editor.getContribution<InstanceType<typeof WordWrapController>>("editor.contrib.wordWrap");
	assert.ok(controller);

	const enable = keydown(dom.window, "z", { altKey: true });
	input.dispatchEvent(enable);
	assert.equal(enable.defaultPrevented, true);
	assert.equal(editor.getOption(EditorOption.wordWrap), "off");
	assert.equal(editor.getOption(EditorOption.wordWrapOverride2), "on");
	assert.ok(editor.getOption(EditorOption.wrappingInfo).wrappingColumn > 0);
	assert.equal(editor.getDomNode().classList.contains("word-wrapped"), true);
	assert.equal(editor.getDomNode()?.querySelector(".stanza-editor-accessibility-status")?.textContent, "Word wrap on");
	using peer = createTestCodeEditor({
		container: dom.window.document.querySelector<HTMLElement>("aside")!,
		model: first,
		input: { resource: first.uri },
		languageId: first.getLanguageId(),
		instantiationService: services,
		wordWrap: "off",
		minimap: { enabled: false },
	});
	peer.layout({ width: 70, height: 40 });
	assert.equal(peer.getOption(EditorOption.wordWrapOverride2), "on");
	assert.equal(peer.getDomNode().classList.contains("word-wrapped"), true);

	editor.setModel(second);
	assert.equal(editor.getOption(EditorOption.wordWrapOverride2), "inherit");
	assert.equal(editor.getOption(EditorOption.wrappingInfo).wrappingColumn, -1);
	editor.setModel(first);
	assert.equal(editor.getOption(EditorOption.wordWrapOverride2), "on");
	assert.ok(editor.getOption(EditorOption.wrappingInfo).wrappingColumn > 0);

	const restoredController = editor.getContribution<InstanceType<typeof WordWrapController>>("editor.contrib.wordWrap");
	assert.ok(restoredController);
	assert.notEqual(restoredController, controller);
	restoredController.toggle();
	assert.equal(editor.getOption(EditorOption.wordWrapOverride2), "inherit");
	assert.equal(peer.getOption(EditorOption.wordWrapOverride2), "inherit");
	assert.equal(editor.getOption(EditorOption.wrappingInfo).wrappingColumn, -1);
	assert.equal(editor.getDomNode()?.querySelector(".stanza-editor-accessibility-status")?.textContent, "Word wrap off");
	assert.equal(first.getText(), "abcdef");

	editor.updateOptions({ wordWrap: "on" });
	restoredController.toggle();
	assert.equal(editor.getOption(EditorOption.wordWrap), "on");
	assert.equal(editor.getOption(EditorOption.wordWrapOverride2), "off");
	restoredController.toggle();
	assert.equal(editor.getOption(EditorOption.wordWrapOverride2), "inherit");
	assert.ok(editor.getOption(EditorOption.wrappingInfo).wrappingColumn > 0);

	const unrelated = keydown(dom.window, "z", { altKey: true, shiftKey: true });
	editor.getDomNode()?.querySelector<HTMLElement>(".stanza-editor-input")?.dispatchEvent(unrelated);
	assert.equal(unrelated.defaultPrevented, false);
});

function keydown(targetWindow: typeof browserEnvironment.window, key: string, options: { readonly altKey?: boolean; readonly shiftKey?: boolean } = {}): KeyboardEvent {
	return new targetWindow.KeyboardEvent("keydown", {
		bubbles: true,
		cancelable: true,
		key,
		altKey: options.altKey,
		shiftKey: options.shiftKey,
	}) as unknown as KeyboardEvent;
}
