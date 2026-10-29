import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Selection } from '../../../common/core/selection.js';
import { TextAreaState } from '../../../browser/controller/editContext/textArea/textAreaEditContextState.js';

test('textarea state derives inserted text from two snapshots', () => {
	const before = new TextAreaState('ac', 1, 1, null, 0);
	const after = new TextAreaState('abc', 2, 2, null, 0);
	assert.deepEqual(TextAreaState.deduceInput(before, after, false), {
		text: 'b', replacePrevCharCnt: 0, replaceNextCharCnt: 0, positionDelta: 0,
	});
});

test('textarea state reports Android selection-only composition moves', () => {
	const before = new TextAreaState('abc', 1, 1, null, 0);
	const after = new TextAreaState('abc', 2, 2, null, 0);
	assert.equal(TextAreaState.deduceAndroidCompositionInput(before, after).positionDelta, 1);
});

test('textarea state maps content offsets independently of selection direction', () => {
	const forward = new TextAreaState('abcd', 1, 3, new Selection(1, 2, 1, 4), 0);
	const backward = new TextAreaState('abcd', 3, 1, new Selection(1, 4, 1, 2), 0);
	assert.deepEqual(forward.deduceEditorPosition(2), backward.deduceEditorPosition(2));
	assert.deepEqual(backward.deduceEditorPosition(2), [backward.selection!.getStartPosition(), 1, 0]);
});
