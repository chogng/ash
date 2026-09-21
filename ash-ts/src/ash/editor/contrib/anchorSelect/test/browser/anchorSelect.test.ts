import assert from 'node:assert/strict';
import { test, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';
import { h } from '../../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { type ICodeEditor } from '../../../../browser/editorBrowser.js';
import { CursorsController } from '../../../../common/cursor/cursor.js';
import { Selection, type ISelection } from '../../../../common/core/selection.js';
import { Position } from '../../../../common/core/position.js';
import { Range } from '../../../../common/core/range.js';
import { TextDecorationCollection } from '../../../../common/model/decorationCollection.js';
import { TextModel } from '../../../../common/model/textModel.js';
import { createTestCursorsController } from '../../../../test/common/testCursorConfiguration.js';
import { type TextMeasurer } from '../../../../common/viewModel.js';

const browserEnvironment = new JSDOM('<!doctype html><body></body>');
for (const [name, value] of Object.entries({
	window: browserEnvironment.window,
	document: browserEnvironment.window.document,
	Node: browserEnvironment.window.Node,
	Element: browserEnvironment.window.Element,
	HTMLElement: browserEnvironment.window.HTMLElement,
	Event: browserEnvironment.window.Event,
	KeyboardEvent: browserEnvironment.window.KeyboardEvent,
})) Object.defineProperty(globalThis, name, { configurable: true, value });

const { TestView: View } = await import('../../../../test/browser/viewModel/testViewModel.js');
const { SelectionAnchorController } = await import('../../browser/anchorSelect.js');

suiteTeardown(() => browserEnvironment.window.close());

test('Selection anchor follows edits and supports set, go to, select, and cancel', async () => {
	const fixture = createFixture('abcd');
	using resources = fixture.resources;
	fixture.selections.setSelections(singleCaret(0, 2));
	fixture.controller.setSelectionAnchor();
	fixture.viewport.layout({ width: 240, height: 40 });
	await Promise.resolve();
	assert.equal(fixture.controller.selectionAnchorSet, true);
	assert.deepEqual(fixture.decorations.decorations[0]?.range, Range.fromPositions(new Position((0) + 1, (2) + 1)));
	assert.equal(fixture.model.getAllDecorations()[0]?.options.className, 'selection-anchor');

	fixture.model.applyEdits([{ range: Range.fromPositions(new Position((0) + 1, (0) + 1)), text: 'x' }]);
	fixture.selections.setSelections(singleCaret(0, 0));
	fixture.controller.goToSelectionAnchor();
	assert.deepEqual(fixture.selections.getSelections(), singleCaret(0, 3));

	fixture.selections.setSelections(singleCaret(0, 5));
	fixture.controller.selectFromAnchorToCursor();
	assert.deepEqual(fixture.selections.getSelections(), [Selection.fromPositions(new Position((0) + 1, (3) + 1), new Position((0) + 1, (5) + 1))]);
	assert.equal(fixture.controller.selectionAnchorSet, false);
	assert.deepEqual(fixture.decorations.decorations, []);

	fixture.controller.setSelectionAnchor();
	fixture.controller.cancelSelectionAnchor();
	assert.equal(fixture.controller.selectionAnchorSet, false);
	fixture.dom.window.close();
});

test('Selection anchor keybindings use the two-key commands and leave navigation alone', () => {
	const fixture = createFixture('abcd');
	using resources = fixture.resources;
	fixture.selections.setSelections(singleCaret(0, 1));
	fixture.input.dispatchEvent(keydown(fixture.dom.window, 'k', { ctrlKey: true }));
	const set = keydown(fixture.dom.window, 'b', { ctrlKey: true });
	fixture.input.dispatchEvent(set);
	assert.equal(set.defaultPrevented, true);
	assert.equal(fixture.controller.selectionAnchorSet, true);

	fixture.selections.setSelections(singleCaret(0, 4));
	const arrow = keydown(fixture.dom.window, 'ArrowLeft');
	fixture.input.dispatchEvent(arrow);
	assert.equal(arrow.defaultPrevented, false);
	fixture.input.dispatchEvent(keydown(fixture.dom.window, 'k', { ctrlKey: true }));
	const select = keydown(fixture.dom.window, 'k', { ctrlKey: true });
	fixture.input.dispatchEvent(select);
	assert.equal(select.defaultPrevented, true);
	assert.deepEqual(fixture.selections.getSelections()[0]!, Selection.fromPositions(new Position((0) + 1, (1) + 1), new Position((0) + 1, (4) + 1)));
	assert.equal(fixture.controller.selectionAnchorSet, false);

	fixture.controller.setSelectionAnchor();
	const cancel = keydown(fixture.dom.window, 'Escape');
	fixture.input.dispatchEvent(cancel);
	assert.equal(cancel.defaultPrevented, true);
	assert.equal(fixture.controller.selectionAnchorSet, false);
	fixture.dom.window.close();
});

function createFixture(text: string): {
	readonly dom: JSDOM;
	readonly model: TextModel;
	readonly selections: CursorsController;
	readonly decorations: TextDecorationCollection<void>;
	readonly viewport: InstanceType<typeof View>;
	readonly input: HTMLTextAreaElement;
	readonly controller: InstanceType<typeof SelectionAnchorController>;
	readonly resources: DisposableStore;
} {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	const container = dom.window.document.querySelector<HTMLElement>('main')!;
	const model = new TextModel(text);
	const selections = createTestCursorsController(model, singleCaret(0, 0));
	const decorations = new TextDecorationCollection<void>(model);
	const viewport = new View({ container, model, lineHeight: 20, textMeasurer: new FixedTextMeasurer(), selectionController: selections });
	const input = h(dom.window.document, 'textarea') as unknown as HTMLTextAreaElement;
	container.append(input);
	const editor = {
		getModel: () => model,
		getPosition: () => selections.getPosition(),
		setSelection: (selection: ISelection) => selections.setSelections([Selection.liftSelection(selection)]),
	} as unknown as ICodeEditor;
	const controller = new SelectionAnchorController(input, editor, viewport, decorations);
	const resources = new DisposableStore();
	resources.add(model);
	resources.add(selections);
	resources.add(decorations);
	resources.add(viewport);
	resources.add(controller);
	return { dom, model, selections, decorations, viewport, input, controller, resources };
}

class FixedTextMeasurer implements TextMeasurer {
	readonly horizontalPadding = 24;
	readonly contentLeftPadding = 12;
	refresh(): boolean { return false; }
	measureLineWidth(text: string): number { return text.length * 10; }
}

function singleCaret(lineIndex: number, columnIndex: number): readonly Selection[] {
	return [Selection.fromPositions(new Position((lineIndex) + 1, (columnIndex) + 1))];
}

function keydown(targetWindow: typeof browserEnvironment.window, key: string, options: KeyboardEventInit = {}): KeyboardEvent {
	return new targetWindow.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, ...options }) as unknown as KeyboardEvent;
}
