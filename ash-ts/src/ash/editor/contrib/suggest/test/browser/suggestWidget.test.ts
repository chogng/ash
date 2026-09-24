import { h } from '../../../../../base/browser/dom.js';
import assert from "node:assert/strict";
import { test, suiteTeardown } from "mocha";
import { JSDOM } from "jsdom";
import { LanguageCompletionDetailsStatus, SuggestModel, type LanguageCompletionSessionOptions } from "../../browser/suggestModel.js";
import { LanguageResultAcceptance } from '../../../../common/model/languageResultStore.js';
import { LanguageCompletionInsertTextFormat, LanguageCompletionItemKind, type LanguageCompletionItem } from '../../../../common/languages.js';
import { createLanguageCompletionStore, LanguageCompletionService } from '../../browser/suggest.js';
import { LanguageCompletionProviderRegistry } from '../../../../common/languageFeatureRegistry.js';
import { Selection } from "../../../../common/core/selection.js";
import { Position } from "../../../../common/core/position.js";
import { Range } from "../../../../common/core/range.js";
import { TextModel } from "../../../../common/model/textModel.js";
import { SuggestController } from "../../browser/suggestController.js";

const browserEnvironment = new JSDOM("<!doctype html><body></body>");
for (const [name, value] of Object.entries({
	window: browserEnvironment.window,
	document: browserEnvironment.window.document,
	Node: browserEnvironment.window.Node,
	Element: browserEnvironment.window.Element,
	HTMLElement: browserEnvironment.window.HTMLElement,
	Event: browserEnvironment.window.Event,
	MouseEvent: browserEnvironment.window.MouseEvent,
	KeyboardEvent: browserEnvironment.window.KeyboardEvent,
	ResizeObserver: class { observe(): void {} unobserve(): void {} disconnect(): void {} },
})) {
	Object.defineProperty(globalThis, name, {
		configurable: true,
		value,
	});
}

const { EditorTextDirection, View } = await import("../../../../browser/view.js");
const { createTestCodeEditor } = await import("../../../../test/browser/testCodeEditor.js");
suiteTeardown(() => browserEnvironment.window.close());
const { ViewController } = await import('../../../../browser/view/viewController.js');

test("Completion widget projects named options, focus, ARIA, and content coordinates", () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = requiredElement<HTMLElement>(dom.window.document, "main");
	using model = new TextModel("con");
	using registry = new LanguageCompletionProviderRegistry();
	using service = new LanguageCompletionService(model, registry);
	using editor = createTestCodeEditor({
		container,
		model,
		glyphMargin: false,
		textDirection: EditorTextDirection.LeftToRight,
		lineHeight: 20,
		contributions: [],
	});
	const viewport = editor.view;
	editor.setPosition(new Position((0) + 1, (3) + 1));
	using session = new SuggestModel(service.results, editor);
	viewport.layout({ width: 300, height: 40 });
	const input = viewport.controller;
	using suggest = new SuggestController(editor, input, service, session);
	viewport.focus();
	accept(service.results, model, 1, [
		completion("constant", "const", LanguageCompletionItemKind.Keyword, "declaration"),
		completion("console", "console", LanguageCompletionItemKind.Variable, "global", true),
	]);
	const widget = suggest.widget;
	const options = [...widget.element.querySelectorAll<HTMLElement>(".stanza-editor-completion-option")];

	assert.equal(widget.visible, true);
	assert.equal(widget.element.hidden, false);
	const coordinates = viewport.getPositionContentCoordinates(editor.getPosition()!);
	assert.equal(widget.element.style.left, `${coordinates.left}px`);
	assert.equal(widget.element.style.top, `${coordinates.top + coordinates.height}px`);
	assert.equal(input.element.getAttribute("aria-autocomplete"), "list");
	assert.equal(input.element.getAttribute("aria-haspopup"), "true");
	assert.equal(input.element.getAttribute("aria-controls"), null);
	assert.equal(input.element.getAttribute("aria-activedescendant"), options[1]!.id);
	assert.deepEqual(options.map(option => ({
		selected: option.getAttribute("aria-selected"),
		focused: option.classList.contains("focused"),
		text: option.textContent,
	})), [{
		selected: "false",
		focused: false,
		text: "Keywordconstdeclaration",
	}, {
		selected: "true",
		focused: true,
		text: "Variableconsoleglobal",
	}]);
	dom.window.close();
});

test("Completion keyboard navigation accepts one item before ordinary input routing", () => {
	const fixture = createFixture("con");
	using resources = fixture;
	accept(fixture.store, fixture.model, 1, [
		completion("constant", "const", LanguageCompletionItemKind.Keyword),
		completion("console", "console", LanguageCompletionItemKind.Variable),
	]);
	const down = keyboardEvent(fixture.dom.window, "ArrowDown");
	fixture.input.element.dispatchEvent(down);
	assert.equal(down.defaultPrevented, true);
	assert.equal(fixture.session.state!.selectedItem.id, "console");

	const enter = keyboardEvent(fixture.dom.window, "Enter");
	fixture.input.element.dispatchEvent(enter);
	assert.equal(enter.defaultPrevented, true);
	assert.equal(fixture.model.getText(), "console");
	assert.equal(Position.compare(fixture.editor.getPosition()!, new Position((0) + 1, (7) + 1)), 0);
	assert.equal(fixture.suggest.widget.visible, false);
	assert.equal(fixture.input.element.getAttribute("aria-autocomplete"), "both");
	assert.equal(fixture.dom.window.document.activeElement, fixture.input.element);

	fixture.model.undo();
	assert.equal(fixture.model.getText(), "con");
});

test("Typing a declared completion commit character accepts it atomically before normal input", () => {
	const fixture = createFixture("con");
	using resources = fixture;
	accept(fixture.store, fixture.model, 1, [{
		...completion("console", "console", LanguageCompletionItemKind.Variable),
		commitCharacters: ["."],
	}]);

	const commit = beforeInput(fixture.dom.window, ".");
	fixture.input.element.dispatchEvent(commit);

	assert.equal(commit.defaultPrevented, true);
	assert.equal(fixture.model.getText(), "console.");
	assert.equal(Position.compare(fixture.editor.getPosition()!, new Position((0) + 1, (8) + 1)), 0);
	assert.equal(fixture.suggest.widget.visible, false);
	fixture.model.undo();
	assert.equal(fixture.model.getText(), "con");
});

test("Completion snippets route Tab, Shift+Tab, and Escape through Stanza placeholder navigation", () => {
	const fixture = createFixture("fn");
	using resources = fixture;
	fixture.editor.setSelections([Selection.fromPositions(new Position((0) + 1, (2) + 1))]);
	assert.equal(fixture.store.accept({
		requestId: 1,
		textModel: fixture.model,
		modelVersion: fixture.model.version,
		value: {
			position: new Position((0) + 1, (2) + 1),
			items: [{
				...completion("function", "function", LanguageCompletionItemKind.Function),
				range: Range.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (2) + 1)),
				insertText: "function ${1:name}(${2:value}) { $0 }",
				insertTextFormat: LanguageCompletionInsertTextFormat.Snippet,
			}],
			isIncomplete: false,
		},
	}), LanguageResultAcceptance.Applied);
	fixture.input.element.dispatchEvent(keyboardEvent(fixture.dom.window, "Enter"));
	assert.equal(fixture.model.getText(), "function name(value) {  }");

	const next = keyboardEvent(fixture.dom.window, "Tab");
	fixture.input.element.dispatchEvent(next);
	assert.equal(next.defaultPrevented, true);
	assert.deepEqual(fixture.editor.getSelection()!, Selection.fromPositions(new Position((0) + 1, (14) + 1), new Position((0) + 1, (19) + 1)));
	const previous = keyboardEvent(fixture.dom.window, "Tab", true);
	fixture.input.element.dispatchEvent(previous);
	assert.equal(previous.defaultPrevented, true);
	assert.deepEqual(fixture.editor.getSelection()!, Selection.fromPositions(new Position((0) + 1, (9) + 1), new Position((0) + 1, (13) + 1)));
	const escape = keyboardEvent(fixture.dom.window, "Escape");
	fixture.input.element.dispatchEvent(escape);
	assert.equal(escape.defaultPrevented, true);
	const ordinaryTab = keyboardEvent(fixture.dom.window, "Tab");
	fixture.input.element.dispatchEvent(ordinaryTab);
	assert.equal(ordinaryTab.defaultPrevented, false);
	assert.equal(fixture.model.getText(), "function name(value) {  }");
});

test("Completion snippets cycle choice tabstops through Alt+Arrow", () => {
	const fixture = createFixture("con");
	using resources = fixture;
	accept(fixture.store, fixture.model, 1, [{
		...completion("choice", "choice", LanguageCompletionItemKind.Value),
		insertText: "${1|one,two|}=$1",
		insertTextFormat: LanguageCompletionInsertTextFormat.Snippet,
	}]);

	fixture.input.element.dispatchEvent(keyboardEvent(fixture.dom.window, "Enter"));
	assert.equal(fixture.model.getText(), "one=one");
	const next = keyboardEvent(fixture.dom.window, "ArrowDown", false, { altKey: true });
	fixture.input.element.dispatchEvent(next);
	assert.equal(next.defaultPrevented, true);
	assert.equal(fixture.model.getText(), "two=two");
	const previous = keyboardEvent(fixture.dom.window, "ArrowUp", false, { altKey: true });
	fixture.input.element.dispatchEvent(previous);
	assert.equal(previous.defaultPrevented, true);
	assert.equal(fixture.model.getText(), "one=one");
});

test("Escape cancels locally while clicking accepts the selected option", () => {
	const fixture = createFixture("con");
	using resources = fixture;
	accept(fixture.store, fixture.model, 1, [
		completion("constant", "const", LanguageCompletionItemKind.Keyword),
	]);
	const escape = keyboardEvent(fixture.dom.window, "Escape");
	fixture.input.element.dispatchEvent(escape);
	assert.equal(escape.defaultPrevented, true);
	assert.equal(fixture.suggest.widget.visible, false);
	assert.equal(fixture.store.result, undefined);

	accept(fixture.store, fixture.model, 2, [
		completion("constant", "const", LanguageCompletionItemKind.Keyword),
		completion("continue", "continue", LanguageCompletionItemKind.Keyword),
	]);
	const option = requiredElement<HTMLElement>(
		fixture.suggest.widget.element,
		'[data-completion-index="1"]',
	);
	option.dispatchEvent(mouseEvent(fixture.dom.window, "mousedown"));
	option.dispatchEvent(mouseEvent(fixture.dom.window, "click"));
	assert.equal(fixture.model.getText(), "continue");
	assert.equal(fixture.suggest.widget.visible, false);
});

test("Completion widget validates ownership and clears its active descendant on disposal", () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = requiredElement<HTMLElement>(dom.window.document, "main");
	using model = new TextModel("con");
	using otherModel = new TextModel("other");
	using otherEditor = editorAt(otherModel, new Position((0) + 1, (5) + 1));
	using registry = new LanguageCompletionProviderRegistry();
	using otherRegistry = new LanguageCompletionProviderRegistry();
	using service = new LanguageCompletionService(model, registry);
	using otherService = new LanguageCompletionService(otherModel, otherRegistry);
	using otherSession = new SuggestModel(otherService.results, otherEditor);
	using editor = createTestCodeEditor({
		container,
		model,
		lineHeight: 20,
		contributions: [],
	});
	const viewport = editor.view;
	editor.setPosition(new Position((0) + 1, (3) + 1));
	using session = new SuggestModel(service.results, editor);
	const input = viewport.controller;
	assert.throws(() => new SuggestController(editor, input, service, otherSession), /must share one text model/);
	using suggest = new SuggestController(editor, input, service, session);
	assert.equal(input.element.getAttribute("aria-autocomplete"), "both");
	suggest.dispose();
	assert.equal(input.element.getAttribute("aria-autocomplete"), "both");
	assert.equal(input.element.getAttribute("aria-controls"), null);

	accept(service.results, model, 1, [
		completion("constant", "const", LanguageCompletionItemKind.Keyword),
	]);
	assert.notEqual(session.state, undefined);
	dom.window.close();
});

test("Disposing the common session immediately hides a surviving widget", () => {
	const fixture = createFixture("con");
	using resources = fixture;
	accept(fixture.store, fixture.model, 1, [
		completion("constant", "const", LanguageCompletionItemKind.Keyword),
	]);
	assert.equal(fixture.suggest.widget.visible, true);

	fixture.session.dispose();

	assert.equal(fixture.suggest.widget.visible, false);
	assert.equal(fixture.input.element.getAttribute("aria-autocomplete"), "both");
	fixture.model.setValue("con\nnext");
	fixture.editor.setPosition(new Position(1, 2));
	const down = keyboardEvent(fixture.dom.window, "ArrowDown");
	fixture.input.element.dispatchEvent(down);
	assert.equal(down.defaultPrevented, true);
	assert.deepEqual(fixture.editor.getPosition(), new Position(2, 2));
});

test("Completion widget projects resolved details only for the focused option", async () => {
	const requests: string[] = [];
	const fixture = createFixture("con", {
		resolver: {
			resolveCompletionItem: async request => {
				requests.push(request.itemId);
				return {
					detail: "resolved detail",
					documentation: "Resolved documentation",
				};
			},
		},
	});
	using resources = fixture;
	accept(fixture.store, fixture.model, 1, [
		{ ...completion("console", "console", LanguageCompletionItemKind.Variable), hasDeferredDetails: true },
		{ ...completion("constant", "const", LanguageCompletionItemKind.Keyword), hasDeferredDetails: true },
	]);
	await new Promise<void>(resolve => setImmediate(resolve));
	await new Promise<void>(resolve => setImmediate(resolve));
	const selected = requiredElement<HTMLElement>(
		fixture.suggest.widget.element,
		'[data-completion-index="0"]',
	);

	assert.deepEqual(requests, ["console"]);
	assert.equal(fixture.session.state!.detailsStatus, LanguageCompletionDetailsStatus.Complete);
	assert.equal(selected.querySelector(".stanza-editor-completion-detail")!.textContent, "resolved detail");
	assert.equal(selected.querySelector(".stanza-editor-completion-documentation")!.textContent, "Resolved documentation");
	assert.equal(selected.classList.contains("resolving"), false);
	assert.equal(selected.getAttribute("aria-busy"), null);
});

interface CompletionFixture extends Disposable {
	readonly dom: JSDOM;
	readonly model: TextModel;
	readonly editor: ReturnType<typeof createTestCodeEditor>;
	readonly store: ReturnType<typeof createLanguageCompletionStore>;
	readonly session: SuggestModel;
	readonly viewport: InstanceType<typeof View>;
	readonly input: InstanceType<typeof ViewController>;
	readonly suggest: SuggestController;
}

function createFixture(text: string, sessionOptions: LanguageCompletionSessionOptions = {}): CompletionFixture {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const model = new TextModel(text);
	const registry = new LanguageCompletionProviderRegistry();
	const service = new LanguageCompletionService(model, registry);
	const editor = createTestCodeEditor({
		container: requiredElement<HTMLElement>(dom.window.document, "main"),
		model,
		lineHeight: 20,
		contributions: [],
	});
	const viewport = editor.view;
	editor.setPosition(new Position((0) + 1, (text.length) + 1));
	const session = new SuggestModel(service.results, editor, sessionOptions);
	viewport.layout({ width: 300, height: 40 });
	const input = viewport.controller;
	const suggest = new SuggestController(editor, input, service, session);
	viewport.focus();
	return {
		dom,
		model,
		editor,
		store: service.results,
		session,
		viewport,
		input,
		suggest,
		[Symbol.dispose](): void {
			suggest.dispose();
			editor.dispose();
			session.dispose();
			service.dispose();
			model.dispose();
			registry.dispose();
			dom.window.close();
		},
	};
}

function accept(
	store: ReturnType<typeof createLanguageCompletionStore>,
	model: TextModel,
	requestId: number,
	items: readonly LanguageCompletionItem[],
): void {
	assert.equal(store.accept({
		requestId,
		textModel: model,
		modelVersion: model.version,
		value: {
			position: new Position((0) + 1, (3) + 1),
			items,
			isIncomplete: false,
		},
	}), LanguageResultAcceptance.Applied);
}

function completion(id: string, label: string, kind: LanguageCompletionItemKind, detail?: string, preselect = false): LanguageCompletionItem {
	return {
		providerId: "test",
		id,
		label,
		kind,
		range: Range.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (3) + 1)),
		insertText: label,
		...(detail === undefined ? {} : { detail }),
		...(preselect ? { preselect } : {}),
	};
}

function editorAt(model: TextModel, position: Position): ReturnType<typeof createTestCodeEditor> {
	const editor = createTestCodeEditor({ container: h(document, 'div'), model, contributions: [] });
	editor.setPosition(position);
	return editor;
}

function keyboardEvent(targetWindow: typeof browserEnvironment.window, key: string, shiftKey = false, options: KeyboardEventInit = {}): KeyboardEvent {
	return new targetWindow.KeyboardEvent("keydown", {
		bubbles: true,
		cancelable: true,
		...options,
		key,
		shiftKey,
	}) as unknown as KeyboardEvent;
}

function mouseEvent(targetWindow: typeof browserEnvironment.window, type: string): MouseEvent {
	return new targetWindow.MouseEvent(type, {
		bubbles: true,
		cancelable: true,
		button: 0,
	}) as unknown as MouseEvent;
}

function beforeInput(targetWindow: typeof browserEnvironment.window, data: string): InputEvent {
	return new targetWindow.InputEvent("beforeinput", {
		bubbles: true,
		cancelable: true,
		data,
		inputType: "insertText",
	}) as unknown as InputEvent;
}

function requiredElement<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
	const element = root.querySelector<T>(selector);
	assert.ok(element);
	return element;
}
