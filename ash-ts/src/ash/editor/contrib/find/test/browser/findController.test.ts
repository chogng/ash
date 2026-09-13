import assert from "node:assert/strict";
import { test, suiteTeardown } from "mocha";
import { JSDOM } from "jsdom";
import { type TextMeasurer } from "../../../../common/viewModel/textMeasurer.js";
import { type ICodeEditor } from '../../../../browser/editorBrowser.js';
import { TextDecorationCollection } from "../../../../common/model/decorationCollection.js";
import { CursorsController } from "../../../../common/cursor/cursor.js";
import { Selection, type ISelection } from "../../../../common/core/selection.js";
import { Position } from "../../../../common/core/position.js";
import { Range } from "../../../../common/core/range.js";
import { type ICommand } from '../../../../common/editorCommon.js';
import { TextModel } from "../../../../common/model/textModel.js";
import { h } from "../../../../../base/browser/dom.js";
import { createTestCursorsController } from '../../../../test/common/testCursorConfiguration.js';

const browserEnvironment = new JSDOM("<!doctype html><body></body>");
for (const [name, value] of Object.entries({
	window: browserEnvironment.window,
	document: browserEnvironment.window.document,
	Node: browserEnvironment.window.Node,
	Element: browserEnvironment.window.Element,
	HTMLElement: browserEnvironment.window.HTMLElement,
	Event: browserEnvironment.window.Event,
	InputEvent: browserEnvironment.window.InputEvent,
	MouseEvent: browserEnvironment.window.MouseEvent,
	KeyboardEvent: browserEnvironment.window.KeyboardEvent,
})) {
	Object.defineProperty(globalThis, name, { configurable: true, value });
}

const { TestView: View } = await import("../../../../test/browser/viewModel/testViewModel.js");
const { FindController } = await import("../../browser/findController.js");

suiteTeardown(() => browserEnvironment.window.close());

test("find opens from the editor shortcut, highlights matches, navigates, and restores focus", () => {
	const fixture = createFixture("alpha beta alpha", new Position((0) + 1, (0) + 1), new Position((0) + 1, (5) + 1));
	using resources = fixture;

	const open = keyboardEvent(fixture.dom.window, "f", { ctrlKey: true });
	fixture.editorInput.dispatchEvent(open);

	assert.equal(open.defaultPrevented, true);
	assert.equal(fixture.find.visible, true);
	assert.equal(fixture.find.searchInput.value, "alpha");
	assert.equal(fixture.find.element.querySelector(".stanza-editor-find-result")?.textContent, "1 of 2");
	assert.deepEqual(fixture.model.getAllDecorations().filter(decoration => decoration.options.className === 'search-match').map(decoration => decoration.range), [
		new Range(1, 1, 1, 6),
		new Range(1, 12, 1, 17),
	]);
	assert.equal(fixture.dom.window.document.activeElement, fixture.find.searchInput);

	fixture.find.searchInput.dispatchEvent(keyboardEvent(fixture.dom.window, "Enter"));
	assert.deepEqual(fixture.selections.getSelections()[0]!.getStartPosition(), new Position((0) + 1, (11) + 1));
	assert.deepEqual(fixture.selections.getSelections()[0]!.getEndPosition(), new Position((0) + 1, (16) + 1));
	assert.equal(fixture.find.element.querySelector(".stanza-editor-find-result")?.textContent, "2 of 2");

	fixture.find.searchInput.dispatchEvent(keyboardEvent(fixture.dom.window, "Escape"));
	assert.equal(fixture.find.visible, false);
	assert.equal(fixture.decorations.size, 0);
	assert.equal(fixture.dom.window.document.activeElement, fixture.editorInput);
});

test("find options project checked classes and report invalid regular expressions", () => {
	const fixture = createFixture("Stanza alpha alphabet");
	using resources = fixture;
	fixture.find.open();
	setInputValue(fixture.find.searchInput, "alpha");

	const matchCase = requiredElement<HTMLButtonElement>(fixture.find.element, '[aria-label="Match case"]');
	const wholeWord = requiredElement<HTMLButtonElement>(fixture.find.element, '[aria-label="Match whole word"]');
	matchCase.click();
	wholeWord.click();
	assert.equal(matchCase.classList.contains("checked"), true);
	assert.equal(matchCase.getAttribute("aria-pressed"), "true");
	assert.equal(wholeWord.classList.contains("checked"), true);
	assert.equal(fixture.decorations.size, 1);

	const regularExpression = requiredElement<HTMLButtonElement>(fixture.find.element, '[aria-label="Use regular expression"]');
	regularExpression.click();
	setInputValue(fixture.find.searchInput, "(");
	assert.equal(regularExpression.classList.contains("checked"), true);
	assert.equal(fixture.find.searchInput.getAttribute("aria-invalid"), "true");
	assert.equal(fixture.find.element.querySelector(".stanza-editor-find-result")?.textContent, "Invalid expression");
	assert.equal(fixture.decorations.size, 0);
});

test("find in selection keeps the opening scope through match navigation and supports Alt+L", () => {
	const fixture = createFixture("alpha beta alpha beta alpha", new Position((0) + 1, (6) + 1), new Position((0) + 1, (16) + 1));
	using resources = fixture;
	fixture.find.open();
	setInputValue(fixture.find.searchInput, "alpha");

	const findInSelection = requiredElement<HTMLButtonElement>(fixture.find.element, '[aria-label="Find in selection"]');
	assert.equal(findInSelection.disabled, false);
	assert.equal(fixture.decorations.size, 3);
	findInSelection.click();

	assert.equal(findInSelection.classList.contains("checked"), true);
	assert.equal(findInSelection.getAttribute("aria-pressed"), "true");
	assert.equal(fixture.decorations.size, 1);
	assert.deepEqual(fixture.selections.getSelections()[0]!.getStartPosition(), new Position((0) + 1, (11) + 1));
	assert.deepEqual(fixture.selections.getSelections()[0]!.getEndPosition(), new Position((0) + 1, (16) + 1));

	const toggle = keyboardEvent(fixture.dom.window, "l", { altKey: true });
	fixture.find.searchInput.dispatchEvent(toggle);
	assert.equal(toggle.defaultPrevented, true);
	assert.equal(findInSelection.classList.contains("checked"), false);
	assert.equal(fixture.decorations.size, 3);
});

test("find in selection restricts replace all to its tracked opening scope", () => {
	const fixture = createFixture("alpha beta alpha beta alpha", new Position((0) + 1, (6) + 1), new Position((0) + 1, (16) + 1));
	using resources = fixture;
	fixture.find.open({ showReplace: true });
	setInputValue(fixture.find.searchInput, "alpha");
	requiredElement<HTMLButtonElement>(fixture.find.element, '[aria-label="Find in selection"]').click();
	fixture.find.replaceInput.value = "x";
	requiredElement<HTMLButtonElement>(fixture.find.element, '[aria-label="Replace all matches"]').click();

	assert.equal(fixture.model.getText(), "alpha beta x beta alpha");
	fixture.selections.context.model.undo();
	assert.equal(fixture.model.getText(), "alpha beta alpha beta alpha");
});

test("configured find defaults seed toggles, selection scope, and non-looping navigation", () => {
	const fixture = createFixture("Alpha beta Alpha", new Position((0) + 1, (0) + 1), new Position((0) + 1, (5) + 1), {
		seedSearchStringFromSelection: 'never',
		autoFindInSelection: 'always',
		loop: false,
	});
	using resources = fixture;
	fixture.find.open();
	requiredElement<HTMLButtonElement>(fixture.find.element, '[aria-label="Match case"]').click();
	requiredElement<HTMLButtonElement>(fixture.find.element, '[aria-label="Match whole word"]').click();

	assert.equal(fixture.find.searchInput.value, "");
	assert.equal(requiredElement<HTMLButtonElement>(fixture.find.element, '[aria-label="Match case"]').classList.contains("checked"), true);
	assert.equal(requiredElement<HTMLButtonElement>(fixture.find.element, '[aria-label="Match whole word"]').classList.contains("checked"), true);
	assert.equal(requiredElement<HTMLButtonElement>(fixture.find.element, '[aria-label="Find in selection"]').classList.contains("checked"), true);
	setInputValue(fixture.find.searchInput, "Alpha");
	fixture.find.searchInput.dispatchEvent(keyboardEvent(fixture.dom.window, "Enter"));
	fixture.find.searchInput.dispatchEvent(keyboardEvent(fixture.dom.window, "Enter"));
	assert.deepEqual(fixture.selections.getSelections()[0]!.getStartPosition(), new Position((0) + 1, (0) + 1));
	assert.deepEqual(fixture.selections.getSelections()[0]!.getEndPosition(), new Position((0) + 1, (5) + 1));
});

test("replace current and replace all use isolated undo transactions", () => {
	const fixture = createFixture("a a a");
	using resources = fixture;
	const openReplace = keyboardEvent(fixture.dom.window, "h", { ctrlKey: true });
	fixture.editorInput.dispatchEvent(openReplace);
	setInputValue(fixture.find.searchInput, "a");
	fixture.find.replaceInput.value = "long";

	assert.equal(openReplace.defaultPrevented, true);
	assert.equal(fixture.find.replaceInput.closest(".stanza-editor-replace-row")?.hasAttribute("hidden"), false);
	requiredElement<HTMLButtonElement>(fixture.find.element, '[aria-label="Replace current match"]').click();
	assert.equal(fixture.model.getText(), "long a a");

	fixture.find.replaceInput.value = "x";
	requiredElement<HTMLButtonElement>(fixture.find.element, '[aria-label="Replace all matches"]').click();
	assert.equal(fixture.model.getText(), "long x x");

	fixture.selections.context.model.undo();
	assert.equal(fixture.model.getText(), "long a a");
	fixture.selections.context.model.undo();
	assert.equal(fixture.model.getText(), "a a a");
});

interface Fixture extends Disposable {
	readonly dom: JSDOM;
	readonly model: TextModel;
	readonly selections: CursorsController;
	readonly decorations: TextDecorationCollection<void>;
	readonly viewport: InstanceType<typeof View>;
	readonly editorInput: HTMLTextAreaElement;
	readonly find: InstanceType<typeof FindController>;
}

function createFixture(text: string, anchor = new Position((0) + 1, (0) + 1), active = anchor, options?: ConstructorParameters<typeof FindController>[4]): Fixture {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	const container = requiredElement<HTMLElement>(dom.window.document, "main");
	const model = new TextModel(text);
	const selections = createTestCursorsController(model, [Selection.fromPositions(anchor, active)]);
	const decorations = new TextDecorationCollection<void>(model);
	const viewport = new View({
		container,
		model,
		lineHeight: 20,
		textMeasurer: new FixedTextMeasurer(),
		selectionController: selections,
	});
	viewport.layout({ width: 600, height: 120 });
	const editorInput = h(dom.window.document, "textarea") as unknown as HTMLTextAreaElement;
	viewport.domNode.domNode.append(editorInput);
	const find = new FindController(editorInput, createEditor(model, selections), viewport, decorations, options);
	return {
		dom,
		model,
		selections,
		decorations,
		viewport,
		editorInput,
		find,
		[Symbol.dispose](): void {
			find.dispose();
			editorInput.remove();
			viewport.dispose();
			decorations.dispose();
			selections.dispose();
			model.dispose();
			dom.window.close();
		},
	};
}

function createEditor(model: TextModel, selections: CursorsController): ICodeEditor {
	return {
		getModel: () => model,
		getSelection: () => selections.getSelections()[0] ?? null,
		setSelection: (selection: ISelection) => selections.setSelections([Selection.liftSelection(selection)]),
		pushUndoStop: () => selections.pushUndoStop(),
		executeCommand: (source: string | null | undefined, command: ICommand) => selections.executeCommand(command, source),
	} as unknown as ICodeEditor;
}

function setInputValue(input: HTMLInputElement, value: string): void {
	input.value = value;
	input.dispatchEvent(new input.ownerDocument.defaultView!.Event("input", { bubbles: true }));
}

function keyboardEvent(targetWindow: typeof browserEnvironment.window, key: string, options: KeyboardEventInit = {}): KeyboardEvent {
	return new targetWindow.KeyboardEvent("keydown", {
		bubbles: true,
		cancelable: true,
		key,
		...options,
	}) as unknown as KeyboardEvent;
}

function requiredElement<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
	const element = root.querySelector<T>(selector);
	assert.ok(element);
	return element;
}

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
