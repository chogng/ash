import assert from "node:assert/strict";
import { test, suiteTeardown } from "mocha";
import { JSDOM } from "jsdom";
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Event } from '../../../../../base/common/event.js';
import { EditorOption, type IEditorFindOptions } from "../../../../common/config/editorOptions.js";
import { Selection } from "../../../../common/core/selection.js";
import { Position } from "../../../../common/core/position.js";
import { Range } from "../../../../common/core/range.js";
import { TextModel } from "../../../../common/model/textModel.js";
import { installEditorTestDom } from '../../../../test/browser/editorTestGlobals.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { BrowserClipboardService } from '../../../../../platform/clipboard/browser/clipboardService.js';
import { FindWidgetSearchHistory } from '../../browser/findWidgetSearchHistory.js';
import { ReplaceWidgetHistory } from '../../browser/replaceWidgetHistory.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { showHistoryKeybindingHint } from '../../../../../platform/history/browser/historyWidgetKeybindingHint.js';
import { type IStorageService, type StorageValue, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';

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
	assert.equal(fixture.findElement.querySelector('svg[data-ash-icon-id="find-selection"]')?.getAttribute('aria-hidden'), 'true');
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

test('find and replace inputs traverse saved history and restore the draft', async () => {
	const stored = new Map<string, string>([
		['workbench.find.history', JSON.stringify(['alpha', 'beta'])],
		['workbench.replace.history', JSON.stringify(['one', 'two'])],
	]);
	using fixture = createFixture('alpha beta', new Position(1, 1), new Position(1, 1), undefined, stored);
	startFind(fixture, true);
	const commands = fixture.editor.invokeWithinContext(accessor => accessor.get(ICommandService));

	setInputValue(fixture.searchInput, 'draft');
	fixture.searchInput.focus();
	const contextKeys = fixture.editor.invokeWithinContext(accessor => accessor.get(IContextKeyService));
	const keybindings = fixture.editor.invokeWithinContext(accessor => accessor.get(IKeybindingService));
	const historyContext = contextKeys.getContext(fixture.searchInput);
	assert.equal(historyContext.getValue('historyNavigationWidgetFocus'), true);
	assert.equal(showHistoryKeybindingHint(keybindings, historyContext), true);
	assert.equal(fixture.searchInput.getAttribute('aria-keyshortcuts'), 'ArrowUp ArrowDown');
	await commands.executeCommand('history.showPrevious');
	assert.equal(fixture.searchInput.value, 'beta');
	await commands.executeCommand('history.showPrevious');
	assert.equal(fixture.searchInput.value, 'alpha');
	await commands.executeCommand('history.showNext');
	await commands.executeCommand('history.showNext');
	assert.equal(fixture.searchInput.value, 'draft');

	setInputValue(fixture.replaceInput, 'replacement draft');
	fixture.replaceInput.focus();
	assert.equal(historyContext.getValue('historyNavigationWidgetFocus'), false);
	const replaceContext = contextKeys.getContext(fixture.replaceInput);
	assert.equal(replaceContext.getValue('historyNavigationWidgetFocus'), true);
	assert.equal(showHistoryKeybindingHint(keybindings, replaceContext), true);
	assert.equal(fixture.replaceInput.getAttribute('aria-keyshortcuts'), 'ArrowUp ArrowDown');
	await commands.executeCommand('history.showPrevious');
	assert.equal(fixture.replaceInput.value, 'two');
	assert.equal(fixture.searchInput.value, 'draft');
	setInputValue(fixture.replaceInput, 'edited');
	await commands.executeCommand('history.showNext');
	assert.equal(fixture.replaceInput.value, 'edited');
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

test('closed find options keep visual and accessible toggle states in sync', () => {
	using fixture = createFixture('alpha beta');
	const state = fixture.find.getState();
	const options = requiredElement<HTMLElement>(fixture.editor.getContainerDomNode(), '.stanza-editor-find-options-widget');
	const buttons = [...options.querySelectorAll('button')];
	const states = () => buttons.map(button => ({ checked: button.classList.contains('checked'), pressed: button.getAttribute('aria-pressed') }));

	state.change({ matchCase: true, wholeWord: true, isRegex: true }, false);
	assert.equal(options.hidden, false);
	assert.deepEqual(states(), Array.from({ length: 3 }, () => ({ checked: true, pressed: 'true' })));

	buttons.forEach(button => button.click());
	assert.deepEqual(states(), Array.from({ length: 3 }, () => ({ checked: false, pressed: 'false' })));
	assert.deepEqual([state.matchCase, state.wholeWord, state.isRegex], [false, false, false]);
	startFind(fixture);
	assert.equal(options.hidden, true);
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

test('find shares queries through its injected clipboard without changing copied text', async () => {
	using clipboard = new BrowserClipboardService({ readText: async () => 'copied text' } as Clipboard);
	using first = createFixture('alpha beta', undefined, undefined, { globalFindClipboard: true }, undefined, clipboard);
	first.find.setSearchString('beta');
	assert.equal(await clipboard.readFindText(), 'beta');
	using second = createFixture('beta alpha beta', undefined, undefined, { globalFindClipboard: true, seedSearchStringFromSelection: 'never' }, undefined, clipboard);
	const opening = startGlobalFind(second);
	assert.equal(second.dom.window.document.activeElement, second.searchInput);
	await opening;
	assert.equal(second.searchInput.value, 'beta');
	assert.equal(second.find.getState().matchesCount, 2);
	assert.equal(await clipboard.readText(), 'copied text');
	second.find.closeFindWidget();
	first.find.setSearchString('alpha');
	await startGlobalFind(second);
	assert.equal(second.searchInput.value, 'alpha');
});

test('disabled global find clipboard and explicit queries do not seed from shared text', async () => {
	using clipboard = new BrowserClipboardService(undefined);
	await clipboard.writeFindText('shared');
	using disabled = createFixture('alpha', undefined, undefined, { globalFindClipboard: false }, undefined, clipboard);
	await startGlobalFind(disabled);
	disabled.find.setSearchString('local');
	assert.equal(await disabled.find.getGlobalBufferTerm(), '');
	assert.equal(await clipboard.readFindText(), 'shared');
	using enabled = createFixture('alpha', undefined, undefined, { globalFindClipboard: true }, undefined, clipboard);
	await startGlobalFind(enabled, 'explicit');
	assert.equal(enabled.searchInput.value, 'explicit');
	assert.equal(await clipboard.readFindText(), 'explicit');
});

test('pending global find reads cannot overwrite input, reopen a closed widget, change a new model, or survive disposal', async () => {
	for (const change of ['input', 'close', 'model', 'dispose', 'new request', 'disable', 'disable and reenable']) {
		let resolveRead!: (text: string) => void;
		class PendingFindClipboard extends BrowserClipboardService {
			override readFindText(): Promise<string> { return new Promise(resolve => { resolveRead = resolve; }); }
		}
		using clipboard = new PendingFindClipboard(undefined);
		using fixture = createFixture('alpha beta', undefined, undefined, { globalFindClipboard: true }, undefined, clipboard);
		const opening = startGlobalFind(fixture);
		if (change === 'input') setInputValue(fixture.searchInput, 'alpha');
		if (change === 'close') fixture.find.closeFindWidget();
		if (change === 'model') fixture.editor.setModel(null);
		if (change === 'disable' || change === 'disable and reenable') fixture.editor.updateOptions({ find: { globalFindClipboard: false } });
		if (change === 'disable and reenable') fixture.editor.updateOptions({ find: { globalFindClipboard: true } });
		if (change === 'dispose') fixture.find.dispose();
		if (change === 'new request') await startGlobalFind(fixture, 'newer');
		resolveRead('stale');
		await opening;
		assert.notEqual(fixture.find.getState().searchString, 'stale', change);
		if (change === 'close') assert.equal(fixture.find.getState().isRevealed, false);
	}
});

function startGlobalFind(fixture: Fixture, searchString?: string): Promise<void> {
	return fixture.find.start({
		forceRevealReplace: false,
		seedSearchStringFromSelection: 'none',
		seedSearchStringFromNonEmptySelection: false,
		seedSearchStringFromGlobalClipboard: true,
		shouldFocus: FindStartFocusAction.FocusFindInput,
		shouldAnimate: false,
		updateSearchScope: true,
		loop: true,
	}, searchString === undefined ? {} : { searchString });
}

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

function createFixture(text: string, anchor = new Position((0) + 1, (0) + 1), active = anchor, options?: IEditorFindOptions, stored?: Map<string, string>, clipboard?: IClipboardService): Fixture {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	const resources = new DisposableStore();
	resources.add(toDisposable(() => dom.window.close()));
	try {
		const container = requiredElement<HTMLElement>(dom.window.document, "main");
		const model = resources.add(new TextModel(text));
		dom.window.HTMLCanvasElement.prototype.getContext = () => null;
		const services = resources.add(new InstantiationService());
		if (clipboard) services.registerInstance(IClipboardService, clipboard);
		const editor = resources.add(createTestCodeEditor({
			instantiationService: services,
			container,
			model,
			contributions: [],
			lineHeight: 20,
			find: options,
		}));
		editor.layout({ width: 600, height: 120 });
		editor.setSelection(Selection.fromPositions(anchor, active));
		const editorInput = requiredElement<HTMLTextAreaElement>(container, ".stanza-editor-input");
		const storageService = stored ? new TestHistoryStorageService(stored) : undefined;
		const find = resources.add(editor.invokeWithinContext(accessor => accessor.get(IInstantiationService)).createInstance(FindController, editor,
			storageService ? FindWidgetSearchHistory.getOrCreate(storageService) : undefined,
			storageService ? ReplaceWidgetHistory.getOrCreate(storageService) : undefined));
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
				resources.dispose();
			},
		};
	} catch (error) {
		resources.dispose();
		throw error;
	}
}

class TestHistoryStorageService implements IStorageService {
	public readonly onDidChangeValue = Event.None;
	public readonly onWillSaveState = Event.None;

	constructor(private readonly values: Map<string, string>) { }

	public get(key: string, _scope: StorageScope, fallbackValue: string): string;
	public get(key: string, _scope: StorageScope): string | undefined;
	public get(key: string, _scope: StorageScope, fallbackValue?: string): string | undefined {
		return this.values.get(key) ?? fallbackValue;
	}

	public getBoolean(_key: string, _scope: StorageScope, fallbackValue: boolean): boolean;
	public getBoolean(_key: string, _scope: StorageScope): boolean | undefined;
	public getBoolean(_key: string, _scope: StorageScope, fallbackValue?: boolean): boolean | undefined {
		return fallbackValue;
	}

	public getNumber(_key: string, _scope: StorageScope, fallbackValue: number): number;
	public getNumber(_key: string, _scope: StorageScope): number | undefined;
	public getNumber(_key: string, _scope: StorageScope, fallbackValue?: number): number | undefined {
		return fallbackValue;
	}

	public store(key: string, value: StorageValue, _scope: StorageScope, _target: StorageTarget): void {
		if (value === undefined || value === null) return;
		this.values.set(key, String(value));
	}

	public remove(key: string, _scope: StorageScope): void {
		this.values.delete(key);
	}

	public keys(_scope: StorageScope, _target: StorageTarget): readonly string[] {
		return [...this.values.keys()];
	}

	public isNew(_scope: StorageScope): boolean {
		return false;
	}

	public async flush(): Promise<void> { }
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
