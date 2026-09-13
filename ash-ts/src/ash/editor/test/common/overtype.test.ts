import assert from "node:assert/strict";
import { test } from "mocha";
import { Selection } from "../../common/core/selection.js";
import { Position } from "../../common/core/position.js";
import { TextModel } from "../../common/model/textModel.js";
import { createTestCursorsController } from './testCursorConfiguration.js';
import { InputMode } from '../../common/inputMode.js';
import { ViewModelEventsCollector } from '../../common/viewModelEventDispatcher.js';

test("Overtype replaces complete following graphemes and stops at physical line ends", () => {
	using model = new TextModel("a😊b\ncd");
	using selections = createTestCursorsController(model, primaryFirst([caret(0, 1), caret(1, 1)], 0));
	InputMode.setInputMode('overtype');
	try {
		selections.type(new ViewModelEventsCollector(), 'XY', 'keyboard');
	} finally {
		InputMode.setInputMode('insert');
	}
	assert.equal(model.getText(), "aXY\ncXY");
	assert.deepEqual(selections.getSelections(), primaryFirst([caret(0, 3), caret(1, 3)], 0));
	selections.context.model.undo();
	assert.equal(model.getText(), "a😊b\ncd");
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

function caret(lineIndex: number, columnIndex: number): Selection {
	return Selection.fromPositions(new Position((lineIndex) + 1, (columnIndex) + 1));
}

function primaryFirst<T>(items: readonly T[], primaryIndex: number): readonly T[] {
	if (primaryIndex === 0) return Object.freeze([...items]);
	return Object.freeze([items[primaryIndex]!, ...items.slice(0, primaryIndex), ...items.slice(primaryIndex + 1)]);
}
