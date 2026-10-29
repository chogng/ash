import assert from 'node:assert/strict';
import { test } from 'mocha';
import { LineRange } from '../../../../../editor/common/core/ranges/lineRange.js';
import { LineRangeMapping } from '../../../../../editor/common/diff/rangeMapping.js';
import type { MergeEditorHunk } from '../../browser/model/mergeEditorModel.js';
import { getAlignments } from '../../browser/view/lineAlignment.js';

test('merge line alignment pairs lines after an insertion within a conflict', () => {
	const hunk: MergeEditorHunk = {
		index: 0,
		base: new LineRange(2, 5),
		current: new LineRange(2, 6),
		incoming: new LineRange(2, 5),
		result: new LineRange(2, 9),
		unresolved: true,
		handled: false,
		resolution: 'unresolved',
	};
	const changes = {
		current: [
			new LineRangeMapping(new LineRange(2, 3), new LineRange(2, 4)),
			new LineRangeMapping(new LineRange(4, 5), new LineRange(5, 6)),
		],
		incoming: [new LineRangeMapping(new LineRange(3, 4), new LineRange(3, 4))],
		result: [new LineRangeMapping(new LineRange(2, 5), new LineRange(2, 9))],
	};
	assert.deepEqual(getAlignments(hunk, changes, ['current', 'incoming', 'result']), [
		{ current: 2, incoming: 2 },
		{ current: 4, incoming: 3 },
		{ current: 5, incoming: 4 },
	]);
	assert.deepEqual(getAlignments(hunk, changes, ['base', 'current', 'incoming', 'result']), [
		{ base: 2, current: 2, incoming: 2 },
		{ base: 3, current: 4, incoming: 3 },
		{ base: 4, current: 5, incoming: 4 },
	]);
});

test('merge line alignment includes accepted result lines and ignores deleted lines', () => {
	const hunk: MergeEditorHunk = {
		index: 0,
		base: new LineRange(2, 4),
		current: new LineRange(2, 3),
		incoming: new LineRange(2, 4),
		result: new LineRange(2, 3),
		unresolved: false,
		handled: true,
		resolution: 'current',
	};
	const changes = {
		current: [new LineRangeMapping(new LineRange(2, 4), new LineRange(2, 3))],
		incoming: [new LineRangeMapping(new LineRange(2, 4), new LineRange(2, 4))],
		result: [new LineRangeMapping(new LineRange(2, 4), new LineRange(2, 3))],
	};
	assert.deepEqual(getAlignments(hunk, changes, ['base', 'current', 'incoming', 'result']), [
		{ base: 2, current: 2, incoming: 2, result: 2 },
		{ base: 3, incoming: 3 },
	]);
});
