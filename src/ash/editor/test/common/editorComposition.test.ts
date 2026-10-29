import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Selection } from '../../common/core/selection.js';
import { Position } from '../../common/core/position.js';
import { Range } from '../../common/core/range.js';
import { TextModel } from '../../common/model/textModel.js';
import { ReplaceCommand } from '../../common/commands/replaceCommand.js';
import { ViewModelEventsCollector } from '../../common/viewModelEventDispatcher.js';
import { createTestCursorsController } from './testCursorConfiguration.js';

const position = (lineIndex: number, columnIndex: number): Position => new Position(lineIndex + 1, columnIndex + 1);
const range = (
	startColumn: number,
	endColumn: number,
): Range => Range.fromPositions(
	position(0, startColumn),
	position(0, endColumn),
);
const selection = (
	anchorOffset: number,
	activeOffset: number,
): readonly Selection[] => [Selection.fromPositions(
	position(0, anchorOffset),
	position(0, activeOffset),
)];

test('Composition revisions commit as one selection-aware undo step', () => {
	using model = new TextModel('hello');
	using controller = createTestCursorsController(
		model,
		selection(1, 4),
	);
	const events = new ViewModelEventsCollector();
	controller.startComposition(events);
	controller.compositionType(events, 'n', 0, 0, 0, 'keyboard');
	controller.compositionType(events, 'ni', 1, 0, 0, 'keyboard');
	controller.compositionType(events, '你', 2, 0, 0, 'keyboard');
	controller.endComposition(events, 'keyboard');
	const afterCommit = {
		text: model.getText(),
		selections: controller.getSelections(),
	};
	controller.context.model.undo();
	const afterUndo = {
		text: model.getText(),
		selections: controller.getSelections(),
	};
	controller.context.model.redo();

	assert.deepEqual({
		afterCommit,
		afterUndo,
		afterRedo: {
			text: model.getText(),
			selections: controller.getSelections(),
		},
	}, {
		afterCommit: {
			text: 'h你o',
			selections: selection(2, 2),
		},
		afterUndo: {
			text: 'hello',
			selections: selection(1, 4),
		},
		afterRedo: {
			text: 'h你o',
			selections: selection(2, 2),
		},
	});
});

test('Composition normalizes multiline text through the production cursor path', () => {
	using model = new TextModel('a\nbc');
	using controller = createTestCursorsController(
		model,
		[Selection.fromPositions(
			position(1, 1),
			position(1, 2),
		)],
	);
	const events = new ViewModelEventsCollector();
	controller.startComposition(events);
	controller.compositionType(events, 'x\r\ny', 0, 0, 0, 'keyboard');
	controller.endComposition(events, 'keyboard');

	assert.equal(model.getText(), 'a\nbx\ny');
});

test('External model edits release the active cursor composition', () => {
	using model = new TextModel('ab');
	using controller = createTestCursorsController(
		model,
		selection(0, 1),
	);
	const events = new ViewModelEventsCollector();
	controller.startComposition(events);
	controller.compositionType(events, 'X', 0, 0, 0, 'keyboard');
	model.applyEdits([{ range: range(2, 2), text: '!' }]);

	assert.doesNotThrow(() => controller.startComposition(events));
	controller.endComposition(events, 'keyboard');
	assert.equal(model.getText(), 'Xb!');
});

test('Active composition survives zero history budgets until resolution', () => {
	using model = new TextModel('hello', {
		historyLimit: { transactions: 0, textUnits: 0 },
	});
	using controller = createTestCursorsController(
		model,
		selection(1, 4),
	);
	const events = new ViewModelEventsCollector();
	controller.startComposition(events);
	controller.compositionType(events, '你', 0, 0, 0, 'keyboard');
	assert.equal(model.canUndo(), true);
	controller.endComposition(events, 'keyboard');

	assert.equal(model.getText(), 'h你o');
	assert.equal(model.canUndo(), false);
});

test('No-op composition updates preserve the selection without history', () => {
	using model = new TextModel('a');
	using controller = createTestCursorsController(
		model,
		selection(0, 1),
	);
	const events = new ViewModelEventsCollector();
	controller.startComposition(events);
	controller.compositionType(events, 'a', 0, 0, -1, 'keyboard');
	controller.endComposition(events, 'keyboard');

	assert.deepEqual({
		text: model.getText(),
		selections: controller.getSelections(),
		canUndo: model.canUndo(),
	}, {
		text: 'a',
		selections: selection(0, 1),
		canUndo: false,
	});
});

test('Disposing a cursor releases its active model history revision', () => {
	using model = new TextModel('ab');
	const controller = createTestCursorsController(model, selection(0, 1));
	const events = new ViewModelEventsCollector();
	controller.startComposition(events);
	controller.compositionType(events, 'X', 0, 0, 0, 'keyboard');
	controller.dispose();

	using nextController = createTestCursorsController(model, selection(0, 1));
	assert.doesNotThrow(() => nextController.startComposition(events));
	nextController.endComposition(events, 'keyboard');
});

test('Composition returning to its original text leaves no undo step', () => {
	using model = new TextModel('a');
	using controller = createTestCursorsController(
		model,
		selection(0, 1),
	);
	const events = new ViewModelEventsCollector();
	controller.startComposition(events);
	controller.compositionType(events, 'X', 0, 0, 0, 'keyboard');
	controller.compositionType(events, 'a', 1, 0, 0, 'keyboard');
	controller.endComposition(events, 'keyboard');

	assert.deepEqual({
		text: model.getText(),
		canUndo: model.canUndo(),
		undo: controller.context.model.undo(),
	}, {
		text: 'a',
		canUndo: false,
		undo: undefined,
	});
});

test('Composition keeps command ownership inside the standard lifecycle', () => {
	using model = new TextModel('ab');
	using controller = createTestCursorsController(
		model,
		selection(0, 1),
	);
	const events = new ViewModelEventsCollector();
	controller.startComposition(events);

	assert.throws(
		() => controller.executeCommand(new ReplaceCommand(range(0, 1), 'X')),
		/active composition/,
	);
	controller.compositionType(events, 'X', 0, 0, 0, 'keyboard');
	controller.endComposition(events, 'keyboard');
	assert.equal(model.getText(), 'Xb');

	using multiModel = new TextModel('ab');
	using multiController = createTestCursorsController(
		multiModel,
		primaryFirst([
			Selection.fromPositions(position(0, 0)),
			Selection.fromPositions(position(0, 2)),
		], 0),
	);
	const multiEvents = new ViewModelEventsCollector();
	multiController.startComposition(multiEvents);
	multiController.compositionType(multiEvents, 'X', 0, 0, 0, 'keyboard');
	multiController.endComposition(multiEvents, 'keyboard');
	assert.equal(multiModel.getText(), 'XabX');
});

test('Chinese composition revisions replace around a caret inside the candidate', () => {
	using model = new TextModel('前后');
	using controller = createTestCursorsController(model, selection(1, 1));
	const events = new ViewModelEventsCollector();
	controller.startComposition(events);
	controller.compositionType(events, '你好', 0, 0, 0, 'keyboard');
	controller.compositionType(events, '', 0, 0, -1, 'keyboard');
	assert.deepEqual({ text: model.getText(), selections: controller.getSelections() }, { text: '前你好后', selections: selection(2, 2) });
	controller.compositionType(events, '您好', 1, 1, -1, 'keyboard');
	assert.deepEqual({ text: model.getText(), selections: controller.getSelections() }, { text: '前您好后', selections: selection(2, 2) });
	controller.compositionType(events, '您们好', 1, 1, 0, 'keyboard');
	controller.endComposition(events, 'keyboard');
	assert.equal(model.getText(), '前您们好后');
	model.undo();
	assert.deepEqual({ text: model.getText(), selections: controller.getSelections() }, { text: '前后', selections: selection(1, 1) });
	model.redo();
	assert.equal(model.getText(), '前您们好后');
});

test('Cancelled Chinese composition restores a backward multiline selection without a redo candidate', () => {
	using model = new TextModel('前一行\n后一行');
	const before = [new Selection(2, 3, 1, 2)];
	using controller = createTestCursorsController(model, before);
	const events = new ViewModelEventsCollector();
	controller.startComposition(events);
	controller.compositionType(events, 'ni', 0, 0, 0, 'keyboard');
	controller.compositionType(events, '你', 2, 0, 0, 'keyboard');
	controller.endComposition(events, 'compositionCancel');
	assert.deepEqual({ text: model.getText(), selections: controller.getSelections(), canUndo: model.canUndo(), canRedo: model.canRedo() }, {
		text: '前一行\n后一行', selections: before, canUndo: false, canRedo: false,
	});
});

test('Cancelling an unchanged composition preserves the preceding edit and original selection', () => {
	using model = new TextModel('中文');
	using controller = createTestCursorsController(model, selection(2, 2));
	const events = new ViewModelEventsCollector();
	controller.type(events, '!', 'keyboard');
	controller.setSelections(selection(1, 0));
	controller.startComposition(events);
	controller.compositionType(events, '中', 0, 0, 0, 'keyboard');
	controller.endComposition(events, 'compositionCancel');
	assert.deepEqual({ text: model.getText(), selections: controller.getSelections(), canRedo: model.canRedo() }, {
		text: '中文!', selections: selection(1, 0), canRedo: false,
	});
	model.undo();
	assert.equal(model.getText(), '中文');
	model.redo();
	assert.equal(model.getText(), '中文!');
});

test('Cancelling an empty composition preserves existing undo and redo history', () => {
	using model = new TextModel('中文');
	using controller = createTestCursorsController(model, selection(2, 2));
	const events = new ViewModelEventsCollector();
	controller.type(events, '!', 'keyboard');
	model.undo();
	controller.startComposition(events);
	controller.endComposition(events, 'compositionCancel');
	assert.deepEqual({ text: model.getText(), canUndo: model.canUndo(), canRedo: model.canRedo() }, {
		text: '中文', canUndo: false, canRedo: true,
	});
	model.redo();
	assert.equal(model.getText(), '中文!');
});

test('Cancelling a composition which returned to its original text restores the saved revision', () => {
	using model = new TextModel('中文');
	const beforeVersion = model.getAlternativeVersionId();
	using controller = createTestCursorsController(model, selection(1, 0));
	const events = new ViewModelEventsCollector();
	controller.startComposition(events);
	controller.compositionType(events, 'n', 0, 0, 0, 'keyboard');
	controller.compositionType(events, '中', 1, 0, 0, 'keyboard');
	controller.endComposition(events, 'compositionCancel');
	assert.deepEqual({ text: model.getText(), selections: controller.getSelections(), version: model.getAlternativeVersionId(), canUndo: model.canUndo(), canRedo: model.canRedo() }, {
		text: '中文', selections: selection(1, 0), version: beforeVersion, canUndo: false, canRedo: false,
	});
});

function primaryFirst<T>(items: readonly T[], primaryIndex: number): readonly T[] {
	if (primaryIndex === 0) return Object.freeze([...items]);
	return Object.freeze([items[primaryIndex]!, ...items.slice(0, primaryIndex), ...items.slice(primaryIndex + 1)]);
}
