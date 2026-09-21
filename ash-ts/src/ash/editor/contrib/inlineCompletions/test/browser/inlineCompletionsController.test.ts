import { ILanguageFeatureDebounceService, LanguageFeatureDebounceService } from '../../../../common/services/languageFeatureDebounce.js';
import { ServiceContainer } from '../../../../../platform/instantiation/common/instantiation.js';
import { IInlineCompletionsService, InlineCompletionsService } from '../../../../browser/services/inlineCompletionsService.js';
import assert from 'node:assert/strict';
import { test, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { h } from '../../../../../base/browser/dom.js';
import { TriggerInlineEditCommandsRegistry } from '../../../../browser/triggerInlineEditCommandsRegistry.js';
import { LanguageFeatureRegistry } from '../../../../common/languageFeatureRegistry.js';
import { Selection } from '../../../../common/core/selection.js';
import { Position } from '../../../../common/core/position.js';
import { TextModel } from '../../../../common/model/textModel.js';
import { type LanguageInlineCompletionsProvider } from '../../common/inlineCompletions.js';
import { createTestCursorsController } from '../../../../test/common/testCursorConfiguration.js';
import { type ICodeEditor } from '../../../../browser/editorBrowser.js';
import { type ICommand } from '../../../../common/editorCommon.js';
import { type CursorsController } from '../../../../common/cursor/cursor.js';
import { type ICursorSelectionChangedEvent } from '../../../../common/cursorEvents.js';
import { type TextMeasurer } from '../../../../common/viewModel.js';

class TestResizeObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}

const browserEnvironment = new JSDOM('<!doctype html><body></body>');
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

const { TestView: View } = await import('../../../../test/browser/viewModel/testViewModel.js');
const { InlineCompletionsController } = await import('../../browser/controller/inlineCompletionsController.js');

suiteTeardown(() => browserEnvironment.window.close());

test('Registered editor commands retrigger inline completions after their edit', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	const container = dom.window.document.querySelector<HTMLElement>('main')!;
	using model = new TextModel('abc');
	using selections = createTestCursorsController(model, [Selection.fromPositions(new Position((0) + 1, (3) + 1))]);
	using viewport = new View({ container, model, lineHeight: 20, textMeasurer: new FixedTextMeasurer(), selectionController: selections });
	viewport.layout({ width: 200, height: 40 });
	const input = h(dom.window.document, 'textarea');
	container.append(input);
	const providers = new LanguageFeatureRegistry<LanguageInlineCompletionsProvider>();
	const requests: string[] = [];
	let provided!: () => void;
	const ready = new Promise<void>(resolve => { provided = resolve; });
	using provider = providers.register('plaintext', {
		provideInlineCompletions: request => {
			requests.push(request.triggerKind);
			provided();
			return [{ insertText: ' completion' }];
		},
	});
	using inlineCompletionsService = new InlineCompletionsService();
	using commands = new Emitter<{ readonly commandId: string }>();
	const commandId = 'editor.test.inlineCompletionTrigger';
	TriggerInlineEditCommandsRegistry.registerCommand(commandId);
	using services = new ServiceContainer();
	services.registerInstance(IInlineCompletionsService, inlineCompletionsService);
	services.registerInstance(ILanguageFeatureDebounceService, new LanguageFeatureDebounceService());
	using controller = services.createInstance(InlineCompletionsController, input, editorFor(model, selections), viewport, model, providers, commands.event, (error: unknown) => { throw error; });

	commands.fire({ commandId: 'editor.test.unrelatedCommand' });
	await flushPromises();
	assert.deepEqual(requests, []);
	commands.fire({ commandId });
	commands.fire({ commandId });
	assert.deepEqual(requests, []);
	await ready;
	await flushPromises();
	assert.deepEqual(requests, ['automatic']);
	assert.equal(viewport.domNode.domNode.querySelector('.stanza-editor-inline-completion')?.textContent, ' completion');
	selections.setSelections([Selection.fromPositions(new Position(1, 2))]);
	assert.equal(viewport.domNode.domNode.querySelector<HTMLElement>('.stanza-editor-inline-completion')?.hidden, true);

	dom.window.close();
});

test('inline completion acceptance applies additional edits and undoes atomically', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	const container = dom.window.document.querySelector<HTMLElement>('main')!;
	using model = new TextModel('name = ', { languageId: 'plaintext' });
	using selections = createTestCursorsController(model, [Selection.fromPositions(new Position(1, 8))]);
	using viewport = new View({ container, model, lineHeight: 20, textMeasurer: new FixedTextMeasurer(), selectionController: selections });
	viewport.layout({ width: 200, height: 40 });
	const input = h(dom.window.document, 'textarea');
	container.append(input);
	const providers = new LanguageFeatureRegistry<LanguageInlineCompletionsProvider>();
	using provider = providers.register('plaintext', {
		provideInlineCompletions: () => [{
			insertText: 'value',
			additionalTextEdits: [{ range: new Selection(1, 1, 1, 1), text: 'const ' }],
		}],
	});
	using service = new InlineCompletionsService();
	using services = new ServiceContainer();
	assert.throws(() => services.createInstance(InlineCompletionsController, input, editorFor(model, selections), viewport, model, providers, undefined, (error: unknown) => { throw error; }), /Unknown service/);
	services.registerInstance(IInlineCompletionsService, service);
	assert.throws(() => services.createInstance(InlineCompletionsController, input, editorFor(model, selections), viewport, model, providers, undefined, (error: unknown) => { throw error; }), /Unknown service/);
	services.registerInstance(ILanguageFeatureDebounceService, new LanguageFeatureDebounceService());
	using controller = services.createInstance(InlineCompletionsController, input, editorFor(model, selections), viewport, model, providers, undefined, (error: unknown) => { throw error; });

	input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: ' ', ctrlKey: true, altKey: true }));
	await flushPromises();
	input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', altKey: true }));
	assert.equal(model.getText(), 'const name = value');
	assert.deepEqual(selections.getSelection().getPosition(), new Position(1, 19));
	selections.context.model.undo();
	assert.equal(model.getText(), 'name = ');
	dom.window.close();
});

test('InlineCompletionsService owns snooze state and change events', () => {
	using service = new InlineCompletionsService();
	const changes: boolean[] = [];
	using listener = service.onDidChangeIsSnoozing(value => changes.push(value));
	service.snooze(10_000);
	assert.equal(service.isSnoozing(), true);
	assert.ok(service.snoozeTimeLeft > 0);
	service.snooze(10_000);
	assert.deepEqual(changes, [true]);
	service.cancelSnooze();
	assert.equal(service.isSnoozing(), false);
	assert.deepEqual(changes, [true, false]);
	assert.throws(() => service.setSnoozeDuration(-1), /non-negative/);
	assert.throws(() => service.reportNewCompletion(''), /non-empty string/);
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

async function flushPromises(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

function editorFor(model: TextModel, selections: CursorsController): ICodeEditor {
	return {
		onDidType: Event.None,
		onDidCompositionStart: Event.None,
		onDidCompositionEnd: Event.None,
		onDidBlurEditorText: Event.None,
		onDidChangeCursorSelection: (listener: (event: ICursorSelectionChangedEvent) => void) => {
			let previous = selections.getSelections();
			return selections.onDidChange(change => {
				const [primary, ...secondary] = change.selections;
				const oldSelections = previous;
				previous = [...change.selections];
				listener({
					selection: primary!,
					secondarySelections: secondary,
					modelVersionId: change.modelVersion,
					oldSelections: [...oldSelections],
					oldModelVersionId: change.modelVersion,
					source: 'test',
					reason: change.reason,
				});
			});
		},
		getModel: () => model,
		getSelection: () => selections.getSelection(),
		getSelections: () => selections.getSelections(),
		pushUndoStop: () => { model.pushStackElement(); return true; },
		executeCommands: (source: string | null | undefined, commands: (ICommand | null)[]) => selections.executeCommands(commands, source),
	} as unknown as ICodeEditor;
}
