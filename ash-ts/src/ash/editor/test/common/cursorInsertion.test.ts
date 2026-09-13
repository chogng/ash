import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { CursorMoveCommands } from '../../common/cursor/cursorMoveCommands.js';
import { CursorState, type PartialCursorState } from '../../common/cursorCommon.js';
import { CursorChangeReason } from '../../common/cursorEvents.js';
import { Position } from '../../common/core/position.js';
import { Selection } from '../../common/core/selection.js';
import { TextModel } from '../../common/model/textModel.js';
import { type TextMeasurer } from '../../common/viewModel/textMeasurer.js';

const browserEnvironment = new JSDOM('<!doctype html><body></body>');
class TestResizeObserver { observe(): void {} unobserve(): void {} disconnect(): void {} }
for (const [name, value] of Object.entries({
	window: browserEnvironment.window, document: browserEnvironment.window.document, Node: browserEnvironment.window.Node,
	Element: browserEnvironment.window.Element, HTMLElement: browserEnvironment.window.HTMLElement, Event: browserEnvironment.window.Event,
	ResizeObserver: TestResizeObserver,
})) Object.defineProperty(globalThis, name, { configurable: true, value });

const { TestView } = await import('../browser/viewModel/testViewModel.js');

test('Adjacent cursor insertion adds clamped carets and preserves existing selection state', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using model = new TextModel('zero\nx\nthree');
	using view = new TestView({ container: dom.window.document.querySelector('main')!, model, lineHeight: 20, textMeasurer: new FixedTextMeasurer() });
	view.testViewModel.setCursorStates('test', CursorChangeReason.Explicit, CursorState.fromModelSelections([Selection.fromPositions(new Position(2, 2))]));
	let states = CursorMoveCommands.addCursorDown(view.testViewModel, view.testViewModel.getCursorStates(), true);
	view.testViewModel.setCursorStates('test', CursorChangeReason.Explicit, states);
	assert.deepEqual(modelSelections(view), [Selection.fromPositions(new Position(2, 2)), Selection.fromPositions(new Position(3, 2))]);
	states = CursorMoveCommands.addCursorUp(view.testViewModel, view.testViewModel.getCursorStates(), true);
	view.testViewModel.setCursorStates('test', CursorChangeReason.Explicit, states);
	assert.deepEqual(modelSelections(view), [Selection.fromPositions(new Position(2, 2)), Selection.fromPositions(new Position(1, 2)), Selection.fromPositions(new Position(3, 2))]);
	dom.window.close();
});

test('Adjacent cursor insertion does not emit an unchanged edge cursor', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using model = new TextModel('zero\none\ntwo');
	using view = new TestView({ container: dom.window.document.querySelector('main')!, model, lineHeight: 20, textMeasurer: new FixedTextMeasurer() });
	view.testViewModel.setCursorStates('test', CursorChangeReason.Explicit, CursorState.fromModelSelections([Selection.fromPositions(new Position(1, 1), new Position(3, 4))]));
	assert.equal(CursorMoveCommands.addCursorDown(view.testViewModel, view.testViewModel.getCursorStates(), true).length, 1);
	dom.window.close();
});

test('CursorMoveCommands owns standard point, word, line, selection, and buffer commands', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using model = new TextModel('alpha beta\nlast');
	using view = new TestView({ container: dom.window.document.querySelector('main')!, model, lineHeight: 20, textMeasurer: new FixedTextMeasurer() });
	view.layout({ width: 200, height: 40 });
	setSelections(view, [Selection.fromPositions(new Position(1, 3))]);

	apply(view, CursorMoveCommands.word(view.testViewModel, view.testViewModel.getPrimaryCursorState(), false, new Position(1, 3)));
	assert.deepEqual(modelSelections(view)[0], Selection.fromPositions(new Position(1, 1), new Position(1, 6)));
	apply(view, CursorMoveCommands.cancelSelection(view.testViewModel, view.testViewModel.getPrimaryCursorState()));
	assert.deepEqual(modelSelections(view)[0], Selection.fromPositions(new Position(1, 6)));
	apply(view, CursorMoveCommands.moveTo(view.testViewModel, view.testViewModel.getPrimaryCursorState(), false, new Position(2, 3), undefined));
	assert.deepEqual(modelSelections(view)[0], Selection.fromPositions(new Position(2, 3)));
	apply(view, CursorMoveCommands.line(view.testViewModel, view.testViewModel.getPrimaryCursorState(), false, new Position(1, 2), undefined));
	assert.deepEqual(modelSelections(view)[0], Selection.fromPositions(new Position(1, 1), new Position(2, 1)));
	apply(view, CursorMoveCommands.selectAll(view.testViewModel, view.testViewModel.getPrimaryCursorState()));
	assert.deepEqual(modelSelections(view)[0], Selection.fromPositions(new Position(1, 1), new Position(2, 5)));
	dom.window.close();
});

function modelSelections(view: InstanceType<typeof TestView>): Selection[] {
	return view.testViewModel.getCursorStates().map(state => state.modelState.selection);
}

function setSelections(view: InstanceType<typeof TestView>, selections: readonly Selection[]): void {
	view.testViewModel.setCursorStates('test', CursorChangeReason.Explicit, CursorState.fromModelSelections(selections));
}

function apply(view: InstanceType<typeof TestView>, state: PartialCursorState): void {
	view.testViewModel.setCursorStates('test', CursorChangeReason.Explicit, [state]);
}

class FixedTextMeasurer implements TextMeasurer {
	readonly horizontalPadding = 24;
	readonly contentLeftPadding = 12;
	refresh(): boolean { return false; }
	measureLineWidth(text: string): number { return text.length * 10; }
}
