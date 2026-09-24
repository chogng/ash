import assert from "node:assert/strict";
import { test, suiteTeardown } from "mocha";
import { JSDOM } from "jsdom";
import { EditorOption, type IEditorFindOptions } from "../../../../common/config/editorOptions.js";
import { Selection } from "../../../../common/core/selection.js";
import { Position } from "../../../../common/core/position.js";
import { Range } from "../../../../common/core/range.js";
import { TextModel } from "../../../../common/model/textModel.js";
import { installEditorTestDom } from '../../../../test/browser/editorTestGlobals.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { IHoverService } from '../../../../../platform/hover/browser/hoverService.js';

const browserEnvironment = new JSDOM("<!doctype html><body></body>");
const installedGlobals = installEditorTestDom(browserEnvironment, [
	'Node', 'Element', 'HTMLElement', 'Event', 'InputEvent', 'MouseEvent', 'KeyboardEvent',
]);

const { CodeEditorWidget } = await import("../../../../browser/widget/codeEditor/codeEditorWidget.js");
const { createTestCodeEditor } = await import('../../../../test/browser/testCodeEditor.js');
const { FindController, FindStartFocusAction, getSelectionSearchString } = await import("../../browser/findController.js");

suiteTeardown(() => {
	installedGlobals.dispose();
	browserEnvironment.window.close();
});

test("find opens, highlights matches, navigates, and restores focus", () => {
	const fixture = createFixture("alpha beta alpha", new Position((0) + 1, (0) + 1), new Position((0) + 1, (5) + 1));
	using resources = fixture;

	startFind(fixture);
	assert.equal(fixture.find.getState().isRevealed, true);
	assert.equal(fixture.searchInput.value, "alpha");
	assert.equal(fixture.findElement.querySelector(".stanza-editor-find-result")?.textContent, "1 of 2");
	assert.deepEqual(fixture.model.getAllDecorations().filter(decoration => decoration.options.className === 'findMatch' || decoration.options.className === 'currentFindMatch').map(decoration => decoration.range).sort(Range.compareRangesUsingStarts), [
		new Range(1, 1, 1, 6),
		new Range(1, 12, 1, 17),
	]);
	assert.deepEqual(fixture.model.getAllDecorations().filter(decoration => decoration.options.className === 'currentFindMatch').map(decoration => decoration.range), [new Range(1, 1, 1, 6)]);
	assert.equal(fixture.dom.window.document.activeElement, fixture.searchInput);

	fixture.searchInput.dispatchEvent(keyboardEvent(fixture.dom.window, "Enter"));
	assert.deepEqual(fixture.editor.getSelections()![0]!.getStartPosition(), new Position((0) + 1, (11) + 1));
	assert.deepEqual(fixture.editor.getSelections()![0]!.getEndPosition(), new Position((0) + 1, (16) + 1));
	assert.equal(fixture.findElement.querySelector(".stanza-editor-find-result")?.textContent, "2 of 2");
	assert.deepEqual(fixture.model.getAllDecorations().filter(decoration => decoration.options.className === 'currentFindMatch').map(decoration => decoration.range), [new Range(1, 12, 1, 17)]);

	fixture.searchInput.dispatchEvent(keyboardEvent(fixture.dom.window, "Escape"));
	assert.equal(fixture.find.getState().isRevealed, false);
	assert.equal(matchDecorationCount(fixture), 0);
	assert.equal(fixture.dom.window.document.activeElement, fixture.editorInput);
});

test('find seeds the word at the cursor through the public selection API', () => {
	using fixture = createFixture('alpha beta', new Position(1, 8));

	assert.equal(getSelectionSearchString(fixture.editor), 'beta');
	startFind(fixture);
	assert.equal(fixture.searchInput.value, 'beta');
	assert.equal(fixture.findElement.querySelector('.stanza-editor-find-result')?.textContent, '1 of 1');
});

test('find escapes selected punctuation when regular expressions are enabled', () => {
	using fixture = createFixture('a.b axb', new Position(1, 1), new Position(1, 4));
	fixture.find.getState().change({ isRegex: true }, false);
	startFind(fixture);
	assert.equal(fixture.searchInput.value, 'a\\.b');
	assert.equal(fixture.find.getState().matchesCount, 1);
});

test('selection search string respects single-line, multiline, and non-empty-selection options', () => {
	using fixture = createFixture('alpha\nbeta');
	fixture.editor.setSelection(new Range(1, 1, 2, 5));

	assert.deepEqual([
		getSelectionSearchString(fixture.editor),
		getSelectionSearchString(fixture.editor, 'multiple'),
		getSelectionSearchString(fixture.editor, 'multiple', true),
	], [null, 'alpha\nbeta', 'alpha\nbeta']);
	fixture.editor.setSelection(new Range(1, 2, 1, 2));
	assert.equal(getSelectionSearchString(fixture.editor, 'single', true), null);
});

test('find state drives the input, options, and match count through the controller', () => {
	using fixture = createFixture('Alpha beta alpha');
	const state = fixture.find.getState();
	startFind(fixture);
	state.change({ searchString: 'alpha', matchCase: true }, true);

	assert.deepEqual({
		query: fixture.searchInput.value,
		matchCase: state.matchCase,
		count: state.matchesCount,
		position: state.matchesPosition,
		decorations: matchDecorationCount(fixture),
	}, { query: 'alpha', matchCase: true, count: 1, position: 1, decorations: 1 });
});

test('find rebinds matches and scope when the editor changes models', () => {
	using fixture = createFixture('alpha beta alpha', new Position(1, 1), new Position(1, 6));
	using nextModel = new TextModel('beta alpha');
	startFind(fixture);
	setInputValue(fixture.searchInput, 'alpha');
	requiredElement<HTMLButtonElement>(fixture.findElement, '[aria-label="Find in selection"]').click();
	assert.equal(fixture.find.getState().matchesCount, 1);

	fixture.editor.setModel(nextModel);
	assert.equal(fixture.find.getState().searchScope, null);
	assert.equal(fixture.find.getState().matchesCount, 1);
	assert.equal(fixture.searchInput.value, 'alpha');
	assert.equal(matchDecorationCount(fixture), 0);
	assert.equal(nextModel.getAllDecorations().filter(decoration => decoration.options.className === 'currentFindMatch').length, 1);

	fixture.editor.setModel(null);
	assert.equal(fixture.find.getState().matchesCount, 0);
	assert.equal(nextModel.getAllDecorations().filter(decoration => decoration.options.className === 'currentFindMatch').length, 0);
});

test('next and previous find from the current editor caret', () => {
	using fixture = createFixture('alpha beta alpha beta alpha');
	startFind(fixture);
	setInputValue(fixture.searchInput, 'alpha');

	fixture.editor.setSelection(new Range(1, 19, 1, 19));
	fixture.find.moveToNextMatch();
	assert.deepEqual(fixture.editor.getSelection(), new Selection(1, 23, 1, 28));

	fixture.editor.setSelection(new Range(1, 19, 1, 19));
	fixture.find.moveToPrevMatch();
	assert.deepEqual(fixture.editor.getSelection(), new Selection(1, 12, 1, 17));
});

test('read-only changes close replace controls and reject replacement', () => {
	using fixture = createFixture('alpha alpha');
	startFind(fixture, true);
	setInputValue(fixture.searchInput, 'alpha');
	setInputValue(fixture.replaceInput, 'beta');
	assert.equal(fixture.replaceInput.closest('.stanza-editor-replace-row')?.hasAttribute('hidden'), false);

	fixture.replaceInput.focus();
	fixture.editor.updateOptions({ readOnly: true });
	assert.equal(fixture.replaceInput.closest('.stanza-editor-replace-row')?.hasAttribute('hidden'), true);
	assert.equal(fixture.dom.window.document.activeElement, fixture.searchInput);
	assert.equal(requiredElement<HTMLButtonElement>(fixture.findElement, '[aria-label="Toggle replace"]').disabled, true);
	assert.equal(requiredElement<HTMLButtonElement>(fixture.findElement, '[aria-label="Replace all matches"]').disabled, true);
	assert.equal(fixture.find.replaceAll(), false);
	assert.equal(fixture.model.getText(), 'alpha alpha');
});

test('find view state restores scroll while its top spacing is visible', () => {
	using fixture = createFixture(Array(30).fill('alpha').join('\n'));
	startFind(fixture);
	fixture.editor.setScrollTop(20);
	const state = fixture.find.saveViewState();
	fixture.editor.setScrollTop(180);
	fixture.find.restoreViewState(state);
	assert.equal(fixture.editor.getScrollTop(), 20);
});

test('find sash resizes by keyboard and keeps the chosen width across editor layouts', () => {
	using fixture = createFixture('alpha alpha');
	fixture.editor.layout({ width: 900, height: 120 });
	startFind(fixture);
	const sash = requiredElement<HTMLElement>(fixture.findElement, '.ash-sash-vertical');
	assert.equal(fixture.findElement.style.width, '480px');
	assert.equal(sash.getAttribute('aria-valuenow'), '480');

	sash.dispatchEvent(keyboardEvent(fixture.dom.window, 'ArrowLeft'));
	assert.equal(fixture.findElement.style.width, '490px');
	assert.equal(sash.getAttribute('aria-valuenow'), '490');
	fixture.editor.layout({ width: 400, height: 120 });
	assert.ok(parseInt(fixture.findElement.style.width, 10) < 480);
	assert.equal(sash.getAttribute('aria-disabled'), 'true');
	fixture.editor.layout({ width: 900, height: 120 });
	assert.equal(fixture.findElement.style.width, '490px');

	sash.dispatchEvent(new fixture.dom.window.MouseEvent('dblclick', { bubbles: true }));
	assert.equal(fixture.findElement.style.width, '480px');
	sash.dispatchEvent(new fixture.dom.window.MouseEvent('dblclick', { bubbles: true }));
	assert.ok(parseInt(fixture.findElement.style.width, 10) > 490);
});

test("find options project checked classes and report invalid regular expressions", () => {
	const fixture = createFixture("Stanza alpha alphabet");
	using resources = fixture;
	startFind(fixture);
	setInputValue(fixture.searchInput, "alpha");

	const matchCase = requiredElement<HTMLButtonElement>(fixture.findElement, '[aria-label="Match case"]');
	const wholeWord = requiredElement<HTMLButtonElement>(fixture.findElement, '[aria-label="Match whole word"]');
	matchCase.click();
	wholeWord.click();
	assert.equal(matchCase.classList.contains("checked"), true);
	assert.equal(matchCase.getAttribute("aria-pressed"), "true");
	assert.equal(wholeWord.classList.contains("checked"), true);
	assert.equal(matchDecorationCount(fixture), 1);

	const regularExpression = requiredElement<HTMLButtonElement>(fixture.findElement, '[aria-label="Use regular expression"]');
	regularExpression.click();
	setInputValue(fixture.searchInput, "(");
	assert.equal(regularExpression.classList.contains("checked"), true);
	assert.equal(fixture.find.getState().isRegex, true);
	assert.equal(fixture.find.getState().searchString, '(');
	assert.equal(fixture.searchInput.getAttribute("aria-invalid"), "true");
	assert.equal(fixture.findElement.querySelector(".stanza-editor-find-result")?.textContent, "Invalid expression");
	assert.equal(matchDecorationCount(fixture), 0);
});

test("find in selection keeps the opening scope through match navigation and supports Alt+L", () => {
	const fixture = createFixture("alpha beta alpha beta alpha", new Position((0) + 1, (6) + 1), new Position((0) + 1, (16) + 1));
	using resources = fixture;
	startFind(fixture);
	setInputValue(fixture.searchInput, "alpha");

	const findInSelection = requiredElement<HTMLButtonElement>(fixture.findElement, '[aria-label="Find in selection"]');
	assert.equal(findInSelection.disabled, false);
	assert.equal(matchDecorationCount(fixture), 3);
	findInSelection.click();

	assert.equal(findInSelection.classList.contains("checked"), true);
	assert.equal(findInSelection.getAttribute("aria-pressed"), "true");
	assert.equal(matchDecorationCount(fixture), 1);
	assert.deepEqual(fixture.editor.getSelections()![0]!.getStartPosition(), new Position((0) + 1, (11) + 1));
	assert.deepEqual(fixture.editor.getSelections()![0]!.getEndPosition(), new Position((0) + 1, (16) + 1));

	const toggle = keyboardEvent(fixture.dom.window, "l", { altKey: true });
	fixture.searchInput.dispatchEvent(toggle);
	assert.equal(toggle.defaultPrevented, true);
	assert.equal(findInSelection.classList.contains("checked"), false);
	assert.equal(matchDecorationCount(fixture), 3);
});

test("find in selection restricts replace all to its tracked opening scope", () => {
	const fixture = createFixture("alpha beta alpha beta alpha", new Position((0) + 1, (6) + 1), new Position((0) + 1, (16) + 1));
	using resources = fixture;
	startFind(fixture, true);
	setInputValue(fixture.searchInput, "alpha");
	requiredElement<HTMLButtonElement>(fixture.findElement, '[aria-label="Find in selection"]').click();
	setInputValue(fixture.replaceInput, 'x');
	requiredElement<HTMLButtonElement>(fixture.findElement, '[aria-label="Replace all matches"]').click();

	assert.equal(fixture.model.getText(), "alpha beta x beta alpha");
	fixture.model.undo();
	assert.equal(fixture.model.getText(), "alpha beta alpha beta alpha");
});

test("configured find defaults seed toggles, selection scope, and non-looping navigation", () => {
	const fixture = createFixture("Alpha beta Alpha", new Position((0) + 1, (0) + 1), new Position((0) + 1, (5) + 1), {
		seedSearchStringFromSelection: 'never',
		autoFindInSelection: 'always',
		loop: false,
	});
	using resources = fixture;
	startFind(fixture);
	requiredElement<HTMLButtonElement>(fixture.findElement, '[aria-label="Match case"]').click();
	requiredElement<HTMLButtonElement>(fixture.findElement, '[aria-label="Match whole word"]').click();

	assert.equal(fixture.searchInput.value, "");
	assert.equal(requiredElement<HTMLButtonElement>(fixture.findElement, '[aria-label="Match case"]').classList.contains("checked"), true);
	assert.equal(requiredElement<HTMLButtonElement>(fixture.findElement, '[aria-label="Match whole word"]').classList.contains("checked"), true);
	assert.equal(requiredElement<HTMLButtonElement>(fixture.findElement, '[aria-label="Find in selection"]').classList.contains("checked"), true);
	setInputValue(fixture.searchInput, "Alpha");
	fixture.searchInput.dispatchEvent(keyboardEvent(fixture.dom.window, "Enter"));
	fixture.searchInput.dispatchEvent(keyboardEvent(fixture.dom.window, "Enter"));
	assert.deepEqual(fixture.editor.getSelections()![0]!.getStartPosition(), new Position((0) + 1, (0) + 1));
	assert.deepEqual(fixture.editor.getSelections()![0]!.getEndPosition(), new Position((0) + 1, (5) + 1));
});

test("replace current and replace all use isolated undo transactions", () => {
	const fixture = createFixture("a a a");
	using resources = fixture;
	startFind(fixture, true);
	setInputValue(fixture.searchInput, "a");
	setInputValue(fixture.replaceInput, 'long');

	assert.equal(fixture.replaceInput.closest(".stanza-editor-replace-row")?.hasAttribute("hidden"), false);
	const replaceOne = requiredElement<HTMLButtonElement>(fixture.findElement, '[aria-label="Replace current match"]');
	replaceOne.click();
	assert.equal(fixture.model.getText(), 'a a a');
	replaceOne.click();
	assert.equal(fixture.model.getText(), "long a a");

	setInputValue(fixture.replaceInput, 'x');
	requiredElement<HTMLButtonElement>(fixture.findElement, '[aria-label="Replace all matches"]').click();
	assert.equal(fixture.model.getText(), "long x x");

	fixture.model.undo();
	assert.equal(fixture.model.getText(), "long a a");
	fixture.model.undo();
	assert.equal(fixture.model.getText(), "a a a");
});

interface Fixture extends Disposable {
	readonly dom: JSDOM;
	readonly model: TextModel;
	readonly editor: InstanceType<typeof CodeEditorWidget>;
	readonly findElement: HTMLDivElement;
	readonly searchInput: HTMLInputElement;
	readonly replaceInput: HTMLInputElement;
	readonly editorInput: HTMLTextAreaElement;
	readonly find: InstanceType<typeof FindController>;
}

function createFixture(text: string, anchor = new Position((0) + 1, (0) + 1), active = anchor, options?: IEditorFindOptions): Fixture {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	const container = requiredElement<HTMLElement>(dom.window.document, "main");
	const model = new TextModel(text);
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const editor = createTestCodeEditor({
		container,
		model,
		contributions: [],
		lineHeight: 20,
		find: options,
	});
	editor.layout({ width: 600, height: 120 });
	editor.setSelection(Selection.fromPositions(anchor, active));
	const editorInput = requiredElement<HTMLTextAreaElement>(container, ".stanza-editor-input");
	const keybindings = editor.invokeWithinContext(accessor => accessor.get(IKeybindingService));
	const hoverService = editor.invokeWithinContext(accessor => accessor.get(IHoverService));
	const find = new FindController(editor, undefined, keybindings, hoverService);
	const findElement = requiredElement<HTMLDivElement>(container, ".stanza-editor-find-widget");
	const searchInput = requiredElement<HTMLInputElement>(findElement, "input[aria-label=\"Find\"]");
	const replaceInput = requiredElement<HTMLInputElement>(findElement, "input[aria-label=\"Replace\"]");
	return {
		dom,
		model,
		editor,
		findElement,
		searchInput,
		replaceInput,
		editorInput,
		find,
		[Symbol.dispose](): void {
			find.dispose();
			editor.dispose();
			model.dispose();
			dom.window.close();
		},
	};
}

function startFind(fixture: Fixture, showReplace = false): void {
	void fixture.find.start({
		forceRevealReplace: showReplace,
		seedSearchStringFromSelection: fixture.editor.getOption(EditorOption.find).seedSearchStringFromSelection === 'never' ? 'none' : 'single',
		seedSearchStringFromNonEmptySelection: false,
		seedSearchStringFromGlobalClipboard: false,
		shouldFocus: FindStartFocusAction.FocusFindInput,
		shouldAnimate: false,
		updateSearchScope: true,
		loop: fixture.editor.getOption(EditorOption.find).loop,
	});
}

function matchDecorationCount(fixture: Fixture): number {
	return fixture.model.getAllDecorations().filter(decoration => decoration.options.className === 'findMatch' || decoration.options.className === 'currentFindMatch').length;
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
