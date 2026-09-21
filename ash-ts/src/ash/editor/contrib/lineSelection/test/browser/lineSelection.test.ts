import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { CursorMoveCommands } from '../../../../common/cursor/cursorMoveCommands.js';
import { CursorState } from '../../../../common/cursorCommon.js';
import { CursorChangeReason } from '../../../../common/cursorEvents.js';
import { Position } from '../../../../common/core/position.js';
import { Selection } from '../../../../common/core/selection.js';
import { TextModel } from '../../../../common/model/textModel.js';
import { type TextMeasurer } from '../../../../common/viewModel.js';

const browserEnvironment = new JSDOM('<!doctype html><body></body>');
class TestResizeObserver { observe(): void {} unobserve(): void {} disconnect(): void {} }
for (const [name, value] of Object.entries({
	window: browserEnvironment.window, document: browserEnvironment.window.document, Node: browserEnvironment.window.Node,
	Element: browserEnvironment.window.Element, HTMLElement: browserEnvironment.window.HTMLElement, Event: browserEnvironment.window.Event,
	ResizeObserver: TestResizeObserver,
})) Object.defineProperty(globalThis, name, { configurable: true, value });

const { TestView } = await import('../../../../test/browser/viewModel/testViewModel.js');

test('Line selection expands through successive physical lines and includes their line breaks', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using model = new TextModel('zero\none\ntwo');
	using view = createView(dom, model);
	setSelections(view, [Selection.fromPositions(new Position(1, 3))]);
	expand(view);
	assert.deepEqual(selectionAt(view), Selection.fromPositions(new Position(1, 1), new Position(2, 1)));
	expand(view);
	assert.deepEqual(selectionAt(view), Selection.fromPositions(new Position(1, 1), new Position(3, 1)));
	expand(view);
	assert.deepEqual(selectionAt(view), Selection.fromPositions(new Position(1, 1), new Position(3, 4)));
	const saturated = selectionAt(view);
	expand(view);
	assert.deepEqual(selectionAt(view), saturated);
	dom.window.close();
});

test('Line selection normalizes reverse multi-selections while retaining the primary item', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using model = new TextModel('zero\none\ntwo\nthree');
	using view = createView(dom, model);
	setSelections(view, [
		Selection.fromPositions(new Position(4, 5)),
		Selection.fromPositions(new Position(3, 3), new Position(2, 2)),
	]);
	expand(view);
	assert.deepEqual(modelSelections(view), [
		Selection.fromPositions(new Position(4, 1), new Position(4, 6)),
		Selection.fromPositions(new Position(2, 1), new Position(4, 1)),
	]);
	dom.window.close();
});

function createView(dom: JSDOM, model: TextModel): InstanceType<typeof TestView> {
	return new TestView({ container: dom.window.document.querySelector('main')!, model, lineHeight: 20, textMeasurer: new FixedTextMeasurer() });
}

function setSelections(view: InstanceType<typeof TestView>, selections: readonly Selection[]): void {
	view.testViewModel.setCursorStates('test', CursorChangeReason.Explicit, CursorState.fromModelSelections(selections));
}

function expand(view: InstanceType<typeof TestView>): void {
	view.testViewModel.setCursorStates('test', CursorChangeReason.Explicit, CursorMoveCommands.expandLineSelection(view.testViewModel, view.testViewModel.getCursorStates()));
}

function modelSelections(view: InstanceType<typeof TestView>): Selection[] {
	return view.testViewModel.getCursorStates().map(state => state.modelState.selection);
}

function selectionAt(view: InstanceType<typeof TestView>): Selection { return modelSelections(view)[0]!; }

class FixedTextMeasurer implements TextMeasurer {
	readonly horizontalPadding = 24;
	readonly contentLeftPadding = 12;
	refresh(): boolean { return false; }
	measureLineWidth(text: string): number { return text.length * 10; }
}
