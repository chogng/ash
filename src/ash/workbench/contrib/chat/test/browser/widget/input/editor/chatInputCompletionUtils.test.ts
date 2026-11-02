import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { Position } from '../../../../../../../../editor/common/core/position.js';
import { Range } from '../../../../../../../../editor/common/core/range.js';
import { TextModel } from '../../../../../../../../editor/common/model/textModel.js';
import { computeCompletionRanges, getCompletionRangeWord } from '../../../../../browser/widget/input/editor/chatInputCompletionUtils.js';

suite('Chat completion ranges', () => {
	test('a multiline resource prefix replaces its complete token without consuming the following prompt', () => {
		using model = new TextModel('Review\n  #src/旧-name.ts after');
		const pattern = /[@#][^\s@#]*/gu;
		pattern.lastIndex = 9;
		const result = computeCompletionRanges(model, new Position(2, 9), pattern, true)!;
		assert.deepEqual(result, {
			insert: new Range(2, 3, 2, 9),
			replace: new Range(2, 3, 2, 17),
			varWord: { word: '#src/旧-name.ts', startColumn: 3, endColumn: 17 },
		});
		assert.equal(getCompletionRangeWord(result), '#src/旧');
		assert.equal(pattern.lastIndex, 9);
	});

	test('resource suggestions reject embedded leaders and ordinary words', () => {
		for (const text of ['mail@example', 'word#file', '@one#two', 'ordinary']) {
			using model = new TextModel(text);
			assert.equal(computeCompletionRanges(model, model.getPositionAt(text.length), /[@#][^\s@#]*/u, true), undefined, text);
		}
	});

	test('an empty position has no resource token', () => {
		using model = new TextModel('Review ');
		const position = new Position(1, 8);
		assert.deepEqual(computeCompletionRanges(model, position, /[@#][^\s@#]*/u, true), {
			insert: Range.fromPositions(position), replace: Range.fromPositions(position), varWord: null,
		});
	});
});
