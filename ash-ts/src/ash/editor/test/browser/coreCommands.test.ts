import assert from "node:assert/strict";
import { test, suiteTeardown } from "mocha";
import { JSDOM } from "jsdom";
import { type TextMeasurer } from "../../common/viewModel/textMeasurer.js";
import { Selection } from "../../common/core/selection.js";
import { Position } from "../../common/core/position.js";
import { TextModel } from "../../common/model/textModel.js";
import { h } from "../../../base/browser/dom.js";
import { CursorState } from '../../common/cursorCommon.js';
import { CursorChangeReason } from '../../common/cursorEvents.js';
import { OperatingSystem } from '../../../base/common/platform.js';
import { ContextKeyService, IContextKeyService } from '../../../platform/contextkey/common/contextkey.js';
import { ServiceContainer } from '../../../platform/instantiation/common/instantiation.js';
import { ILogService, NullLoggerService } from '../../../platform/log/common/log.js';
import { ICodeEditorService } from '../../browser/services/codeEditorService.js';

const browserEnvironment = new JSDOM("<!doctype html><body></body>");
browserEnvironment.window.HTMLCanvasElement.prototype.getContext = () => null;
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

const { TestView: View } = await import("./viewModel/testViewModel.js");
const { installCoreTextEditorCommands } = await import("../../browser/coreCommands.js");
const { KeyboardNavigationController } = await import('../../browser/view/viewController.js');
await import('../../contrib/lineSelection/browser/lineSelection.js');
const { CodeEditorWidget } = await import('../../browser/widget/codeEditor/codeEditorWidget.js');
const { SelectAllCommand } = await import('../../browser/editorExtensions.js');
const { createEditorBrowserServices } = await import('../../browser/services/contribution.js');

suiteTeardown(() => browserEnvironment.window.close());

test('workbench select-all command selects the focused editor model', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main><button>Outside</button></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('one\ntwo');
	using services = new ServiceContainer();
	using contextKeys = new ContextKeyService();
	const browserServices = createEditorBrowserServices();
	services.registerInstance(IContextKeyService, contextKeys);
	services.registerInstance(ILogService, new NullLoggerService());
	services.registerInstance(ICodeEditorService, browserServices.codeEditorService);
	using editor = new CodeEditorWidget({ container: dom.window.document.querySelector<HTMLElement>('main')!, model, input: { resource: model.uri }, languageId: model.getLanguageId(), instantiationService: services, codeEditorService: browserServices.codeEditorService });
	editor.focus();
	await SelectAllCommand.runCommand(services, undefined);
	assert.deepEqual(editor.getSelection(), new Selection(1, 1, 2, 4));
	editor.setSelection(new Selection(1, 1, 1, 1));
	dom.window.document.querySelector('button')!.focus();
	await SelectAllCommand.runCommand(services, undefined);
	assert.deepEqual(editor.getSelection(), new Selection(1, 1, 1, 1));
	dom.window.close();
});

test("core commands select all", () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	const container = dom.window.document.querySelector<HTMLElement>("main")!;
	using model = new TextModel("one\n  two\nthree");
	using viewport = new View({
		container,
		model,
		lineHeight: 20,
		textMeasurer: new FixedTextMeasurer(),
	});
	const selections = viewport.testSelectionController;
	viewport.testViewModel.setCursorStates('test', CursorChangeReason.NotSet, CursorState.fromModelSelections([Selection.fromPositions(new Position((0) + 1, (0) + 1))]));
	viewport.layout({ width: 400, height: 100 });
	const input = viewport.controller;
	using commands = installCoreTextEditorCommands(input.element, viewport, viewport.testViewModel);

	const selectAll = keyboardEvent(dom.window, "a", { metaKey: true });
	input.element.dispatchEvent(selectAll);
	assert.equal(selectAll.defaultPrevented, true);
	assert.deepEqual(selections.getSelections()[0]!.getEndPosition(), new Position((2) + 1, (5) + 1));

	dom.window.close();
});

test("line selection remains an independent editor extension", () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	const container = dom.window.document.querySelector<HTMLElement>("main")!;
	using model = new TextModel("one\ntwo\nthree");
	using editor = new CodeEditorWidget({ container, model, input: { resource: model.uri }, languageId: model.getLanguageId(), lineHeight: 20 });
	editor.viewport.layout({ width: 400, height: 100 });
	editor.setSelection(Selection.fromPositions(new Position((0) + 1, (1) + 1)));

	const first = keyboardEvent(dom.window, "l", { ctrlKey: true });
	editor.view.element.dispatchEvent(first);
	assert.equal(first.defaultPrevented, true);
	assert.deepEqual(editor.selections.getSelections()[0]!, Selection.fromPositions(new Position((0) + 1, (0) + 1), new Position((1) + 1, (0) + 1)));
	editor.view.element.dispatchEvent(keyboardEvent(dom.window, "l", { ctrlKey: true }));
	assert.deepEqual(editor.selections.getSelections()[0]!, Selection.fromPositions(new Position((0) + 1, (0) + 1), new Position((2) + 1, (0) + 1)));

	dom.window.close();
});

test('keyboard word navigation consumes standard WordOperations boundaries', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using model = new TextModel('alpha beta');
	using viewport = new View({
		container: dom.window.document.querySelector<HTMLElement>('main')!,
		model,
		lineHeight: 20,
		textMeasurer: new FixedTextMeasurer(),
	});
	viewport.layout({ width: 400, height: 100 });
	viewport.testViewModel.setCursorStates('test', CursorChangeReason.NotSet, CursorState.fromModelSelections([
		Selection.fromPositions(new Position(1, 11)),
	]));
	using navigation = new KeyboardNavigationController(viewport, viewport.testViewModel, viewport.controller.userInputEvents, {
		operatingSystem: OperatingSystem.Macintosh,
	});

	viewport.controller.element.focus();
	viewport.controller.element.dispatchEvent(keyboardEvent(dom.window, 'ArrowLeft', { altKey: true }));
	assert.deepEqual(viewport.testSelectionController.getSelections()[0]!.getPosition(), new Position(1, 7));
	viewport.controller.element.dispatchEvent(keyboardEvent(dom.window, 'ArrowRight', { altKey: true }));
	assert.deepEqual(viewport.testSelectionController.getSelections()[0]!.getPosition(), new Position(1, 11));
	dom.window.close();
});

test("core commands reject dependencies from different text models", () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	using model = new TextModel("one");
	using otherModel = new TextModel("two");
	using viewport = new View({
		container: dom.window.document.querySelector<HTMLElement>("main")!,
		model,
		lineHeight: 20,
		textMeasurer: new FixedTextMeasurer(),
	});
	const input = h(dom.window.document, "textarea") as unknown as HTMLTextAreaElement;
	using otherViewport = new View({ container: dom.window.document.createElement('div'), model: otherModel, lineHeight: 20, textMeasurer: new FixedTextMeasurer() });
	assert.throws(() => installCoreTextEditorCommands(input, viewport, otherViewport.testViewModel), /must share one text model/);
	dom.window.close();
});

function keyboardEvent(targetWindow: typeof browserEnvironment.window, key: string, options: KeyboardEventInit = {}): KeyboardEvent {
	return new targetWindow.KeyboardEvent("keydown", {
		bubbles: true,
		cancelable: true,
		key,
		...options,
	}) as unknown as KeyboardEvent;
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
