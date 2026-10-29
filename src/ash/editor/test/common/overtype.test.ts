import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Selection } from '../../common/core/selection.js';
import { Position } from '../../common/core/position.js';
import { TextModel } from '../../common/model/textModel.js';
import { createTestCursorsController } from './testCursorConfiguration.js';
import { InputMode } from '../../common/inputMode.js';
import { ViewModelEventsCollector } from '../../common/viewModelEventDispatcher.js';

test('Overtype replaces complete following graphemes and stops at physical line ends', () => {
	using model = new TextModel('a😊b\ncd');
	using selections = createTestCursorsController(model, primaryFirst([caret(0, 1), caret(1, 1)], 0));
	InputMode.setInputMode('overtype');
	try {
		selections.type(new ViewModelEventsCollector(), 'XY', 'keyboard');
	} finally {
		InputMode.setInputMode('insert');
	}
	assert.equal(model.getText(), 'aXY\ncXY');
	assert.deepEqual(selections.getSelections(), primaryFirst([caret(0, 3), caret(1, 3)], 0));
	selections.context.model.undo();
	assert.equal(model.getText(), 'a😊b\ncd');
});

test('Composition overtype removes the following text in the same undo transaction', () => {
	using model = new TextModel('ab');
	using selections = createTestCursorsController(model, [caret(0, 1)]);
	const events = new ViewModelEventsCollector();
	InputMode.setInputMode('overtype');
	try {
		selections.startComposition(events);
		selections.compositionType(events, 'X', 0, 0, 0, 'keyboard');
		selections.endComposition(events, 'keyboard');
	} finally {
		InputMode.setInputMode('insert');
	}

	assert.equal(model.getText(), 'aX');
	model.undo();
	assert.equal(model.getText(), 'ab');
});

for (const input of ['e\u0301', '👩‍💻', '🇨🇳', '😀', '中']) {
	for (const composition of [false, true]) {
		test(`Overtype ${composition ? 'composition' : 'typing'} replaces one grapheme for ${input}`, () => {
			const original = 'ab😀e\u0301z\nend';
			using model = new TextModel(original);
			const before = [caret(0, 1)];
			using controller = createTestCursorsController(model, before);
			const events = new ViewModelEventsCollector();
			InputMode.setInputMode('overtype');
			try {
				if (composition) {
					controller.startComposition(events);
					controller.compositionType(events, input, 0, 0, 0, 'keyboard');
					controller.endComposition(events, 'keyboard');
				} else {
					controller.type(events, input, 'keyboard');
				}
			} finally {
				InputMode.setInputMode('insert');
			}

			const after = [caret(0, 1 + input.length)];
			assert.deepEqual(
				{ text: model.getText(), selections: controller.getSelections() },
				{ text: `a${input}😀e\u0301z\nend`, selections: after },
			);
			model.undo();
			assert.deepEqual(
				{ text: model.getText(), selections: controller.getSelections(), canUndo: model.canUndo() },
				{ text: original, selections: before, canUndo: false },
			);
			model.redo();
			assert.deepEqual(
				{ text: model.getText(), selections: controller.getSelections() },
				{ text: `a${input}😀e\u0301z\nend`, selections: after },
			);
		});
	}
}

test('Composition overtype removes the whole following combining grapheme', () => {
	using model = new TextModel('ae\u0301bc\nend');
	using controller = createTestCursorsController(model, [caret(0, 1)]);
	const events = new ViewModelEventsCollector();
	InputMode.setInputMode('overtype');
	try {
		controller.startComposition(events);
		controller.compositionType(events, '中', 0, 0, 0, 'keyboard');
		controller.endComposition(events, 'keyboard');
	} finally {
		InputMode.setInputMode('insert');
	}
	assert.equal(model.getText(), 'a中bc\nend');
	model.undo();
	assert.equal(model.getText(), 'ae\u0301bc\nend');
});

function caret(lineIndex: number, columnIndex: number): Selection {
	return Selection.fromPositions(new Position(lineIndex + 1, columnIndex + 1));
}

function primaryFirst<T>(items: readonly T[], primaryIndex: number): readonly T[] {
	if (primaryIndex === 0) return Object.freeze([...items]);
	return Object.freeze([items[primaryIndex]!, ...items.slice(0, primaryIndex), ...items.slice(primaryIndex + 1)]);
}
