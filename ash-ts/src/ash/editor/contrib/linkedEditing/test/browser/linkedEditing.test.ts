import assert from 'node:assert/strict';
import { test, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';
import { type CancellationToken } from '../../../../../base/common/cancellation.js';
import { CursorsController } from '../../../../common/cursor/cursor.js';
import { type ICursorPositionChangedEvent } from '../../../../common/cursorEvents.js';
import { Position } from '../../../../common/core/position.js';
import { Range } from '../../../../common/core/range.js';
import { Selection } from '../../../../common/core/selection.js';
import { LanguageFeatureRegistry } from '../../../../common/languageFeatureRegistry.js';
import { registerBuiltinLanguageConfigurations } from '../../../../common/languages/languageBuiltinConfigurations.js';
import { type LinkedEditingRangeProvider } from '../../../../common/languages.js';
import { TextModel } from '../../../../common/model/textModel.js';
import { type TextMeasurer } from '../../../../common/viewModel/textMeasurer.js';
import { TestLanguageConfigurationService } from '../../../../test/common/modes/testLanguageConfigurationService.js';
import { createTestCursorsController } from '../../../../test/common/testCursorConfiguration.js';
import { type ICodeEditor } from '../../../../browser/editorBrowser.js';
import { type ICommand } from '../../../../common/editorCommon.js';

const browserEnvironment = new JSDOM('<!doctype html><body></body>');
for (const [name, value] of Object.entries({
	window: browserEnvironment.window,
	document: browserEnvironment.window.document,
	Node: browserEnvironment.window.Node,
	Element: browserEnvironment.window.Element,
	HTMLElement: browserEnvironment.window.HTMLElement,
	Event: browserEnvironment.window.Event,
	InputEvent: browserEnvironment.window.InputEvent,
	KeyboardEvent: browserEnvironment.window.KeyboardEvent,
})) {
	Object.defineProperty(globalThis, name, { configurable: true, value });
}

const { TestView: View } = await import('../../../../test/browser/viewModel/testViewModel.js');
const { LanguageEditingAdapter, ViewController } = await import('../../../../browser/view/viewController.js');
const { LinkedEditingContribution } = await import('../../browser/linkedEditing.js');

suiteTeardown(() => browserEnvironment.window.close());

test('linked editing applies one input transaction to every provider range', async () => {
	const calls: Array<{ readonly model: TextModel; readonly position: Position; readonly token: CancellationToken }> = [];
	using fixture = createFixture({
		provideLinkedEditingRanges: (model, position, token) => {
			calls.push({ model: model as TextModel, position, token });
			return {
				ranges: [new Range(1, 1, 1, 4), new Range(1, 5, 1, 8)],
				wordPattern: /^[a-z]+$/,
			};
		},
	});
	await waitFor(() => fixture.viewport.domNode.domNode.classList.contains('linked-editing-active'));

	const event = beforeInputEvent(fixture.dom.window, 'x');
	fixture.input.element.dispatchEvent(event);

	assert.equal(event.defaultPrevented, true);
	await waitFor(() => fixture.model.getText() === 'txag txag');
	assert.equal(fixture.model.getText(), 'txag txag');
	assert.strictEqual(calls[0]!.model, fixture.model);
	assert.equal(Position.equals(calls[0]!.position, new Position(1, 2)), true);
	assert.equal(calls[0]!.token.isCancellationRequested, false);
	fixture.selections.context.model.undo();
	assert.equal(fixture.model.getText(), 'tag tag');
});

test('linked editing cancels stale and disposed provider requests', async () => {
	const tokens: CancellationToken[] = [];
	const fixture = createFixture({
		provideLinkedEditingRanges: (_model, _position, token) => {
			tokens.push(token);
			return new Promise(() => {});
		},
	});
	await waitFor(() => tokens.length === 1);

	fixture.selections.setSelections([Selection.fromPositions(new Position(1, 3))]);
	await waitFor(() => tokens.length === 2);
	assert.equal(tokens[0]!.isCancellationRequested, true);

	fixture[Symbol.dispose]();
	assert.equal(tokens[1]!.isCancellationRequested, true);
});

interface Fixture {
	readonly dom: JSDOM;
	readonly model: TextModel;
	readonly viewport: InstanceType<typeof View>;
	readonly input: InstanceType<typeof ViewController>;
	readonly selections: CursorsController;
	[Symbol.dispose](): void;
}

function createFixture(provider: LinkedEditingRangeProvider): Fixture {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const registry = new LanguageFeatureRegistry<LinkedEditingRangeProvider>();
	const registration = registry.register('html', provider);
	const model = new TextModel('tag tag', { languageId: 'html' });
	const selections = createTestCursorsController(model, [Selection.fromPositions(new Position(1, 2))]);
	const configurations = new TestLanguageConfigurationService();
	const builtinConfigurations = registerBuiltinLanguageConfigurations(configurations);
	const languageEditing = new LanguageEditingAdapter(model, selections, 'html', configurations);
	const viewport = new View({
		container: requiredElement<HTMLElement>(dom.window.document, 'main'),
		model,
		lineHeight: 20,
		textMeasurer: new FixedTextMeasurer(),
		selectionController: selections,
		controller: { languageEditing },
	});
	viewport.layout({ width: 300, height: 40 });
	const input = viewport.controller;
	const contribution = new LinkedEditingContribution(input, editorFor(model, selections), input.element, viewport, registry, () => /^[a-z]+$/);
	viewport.focus();
	return {
		dom,
		model,
		viewport,
		input,
		selections,
		[Symbol.dispose](): void {
			contribution.dispose();
			languageEditing.dispose();
			viewport.dispose();
			selections.dispose();
			model.dispose();
			registration.dispose();
			builtinConfigurations.dispose();
			configurations.dispose();
			dom.window.close();
		},
	};
}

function editorFor(model: TextModel, selections: CursorsController): ICodeEditor {
	return {
		getModel: () => model,
		getSelection: () => selections.getSelection(),
		getSelections: () => selections.getSelections(),
		onDidChangeCursorPosition: (listener: (event: ICursorPositionChangedEvent) => void) => selections.onDidChange(change => {
			const [primary, ...secondary] = change.selections;
			listener({
				position: primary!.getPosition(),
				secondaryPositions: secondary.map(selection => selection.getPosition()),
				reason: change.reason,
				source: 'test',
			});
		}),
		executeCommands: (source: string | null | undefined, commands: (ICommand | null)[]) => selections.executeCommands(commands, source),
	} as unknown as ICodeEditor;
}

function beforeInputEvent(targetWindow: typeof browserEnvironment.window, data: string): InputEvent {
	return new targetWindow.InputEvent('beforeinput', {
		bubbles: true,
		cancelable: true,
		inputType: 'insertText',
		data,
	}) as unknown as InputEvent;
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		if (predicate()) return;
		await new Promise<void>(resolve => setTimeout(resolve, 0));
	}
	assert.fail('Timed out waiting for linked editing');
}

function requiredElement<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
	const element = root.querySelector<T>(selector);
	assert.ok(element);
	return element;
}

class FixedTextMeasurer implements TextMeasurer {
	readonly horizontalPadding = 24;
	readonly contentLeftPadding = 12;
	refresh(): boolean { return false; }
	measureLineWidth(text: string): number { return text.length * 10; }
}
