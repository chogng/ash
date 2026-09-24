import '../../../../test/browser/testEditorDom.js';
import { browserEnvironment } from '../../../../test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { type CancellationToken } from '../../../../../base/common/cancellation.js';
import { CursorsController } from '../../../../common/cursor/cursor.js';
import { type ICursorPositionChangedEvent } from '../../../../common/cursorEvents.js';
import { Position } from '../../../../common/core/position.js';
import { Range } from '../../../../common/core/range.js';
import { Selection } from '../../../../common/core/selection.js';
import { LanguageFeatureRegistry } from '../../../../common/languageFeatureRegistry.js';
import { type LinkedEditingRangeProvider } from '../../../../common/languages.js';
import { TextModel } from '../../../../common/model/textModel.js';
import { createTestCursorsController } from '../../../../test/common/testCursorConfiguration.js';
import { type ICodeEditor } from '../../../../browser/editorBrowser.js';
import { type ICommand } from '../../../../common/editorCommon.js';
import { type TextMeasurer } from '../../../../common/viewModel.js';

const { TestView: View } = await import('../../../../test/browser/viewModel/testViewModel.js');
const { ViewController } = await import('../../../../browser/view/viewController.js');
const { LinkedEditingContribution } = await import('../../browser/linkedEditing.js');


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

test('linked editing uses F2 without consuming select-all-occurrences', async () => {
	using fixture = createFixture({ provideLinkedEditingRanges: () => ({ ranges: [new Range(1, 1, 1, 4), new Range(1, 5, 1, 8)] }) });
	const active = () => fixture.viewport.domNode.domNode.classList.contains('linked-editing-active');
	await waitFor(active);
	fixture.input.element.dispatchEvent(new fixture.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
	assert.equal(active(), false);
	const occurrences = new fixture.dom.window.KeyboardEvent('keydown', { key: 'L', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
	fixture.input.element.dispatchEvent(occurrences);
	assert.equal(occurrences.defaultPrevented, false);
	const linked = new fixture.dom.window.KeyboardEvent('keydown', { key: 'F2', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
	fixture.input.element.dispatchEvent(linked);
	assert.equal(linked.defaultPrevented, true);
	await waitFor(active);
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
	const viewport = new View({
		container: requiredElement<HTMLElement>(dom.window.document, 'main'),
		model,
		lineHeight: 20,
		textMeasurer: new FixedTextMeasurer(),
		selectionController: selections,
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
			viewport.dispose();
			selections.dispose();
			model.dispose();
			registration.dispose();
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
