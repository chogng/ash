import assert from "node:assert/strict";
import { test } from "mocha";
import { SelectionDirection, Selection } from "../../common/core/selection.js";
import { Position } from "../../common/core/position.js";
import { Range } from "../../common/core/range.js";

test("Selection preserves anchor direction and ordered range", () => {
	const start = new Position((1) + 1, (2) + 1);
	const end = new Position((3) + 1, (4) + 1);
	const forward = Selection.fromPositions(start, end);
	const backward = Selection.fromPositions(end, start);
	const collapsed = Selection.fromPositions(start);

	assert.deepEqual({
		forward: {
			direction: forward.getDirection(),
			range: new Range(forward.startLineNumber, forward.startColumn, forward.endLineNumber, forward.endColumn),
			collapsed: forward.isEmpty(),
		},
		backward: {
			direction: backward.getDirection(),
			range: new Range(backward.startLineNumber, backward.startColumn, backward.endLineNumber, backward.endColumn),
			collapsed: backward.isEmpty(),
		},
		collapsed: {
			direction: collapsed.getDirection(),
			range: new Range(collapsed.startLineNumber, collapsed.startColumn, collapsed.endLineNumber, collapsed.endColumn),
			collapsed: collapsed.isEmpty(),
		},
	}, {
		forward: {
			direction: SelectionDirection.LTR,
			range: Range.fromPositions(start, end),
			collapsed: false,
		},
		backward: {
			direction: SelectionDirection.RTL,
			range: Range.fromPositions(start, end),
			collapsed: false,
		},
		collapsed: {
			direction: SelectionDirection.LTR,
			range: Range.fromPositions(start),
			collapsed: true,
		},
	});
});

test("Selection arrays keep the primary cursor first", () => {
	const first = Selection.fromPositions(new Position((0) + 1, (1) + 1));
	const second = Selection.fromPositions(new Position((2) + 1, (3) + 1));
	const selections = [first, second];
	const set = primaryFirst(selections, 1);
	selections.reverse();

	assert.deepEqual({
		frozen: Object.isFrozen(set),
		selectionsFrozen: Object.isFrozen(set),
		selections: set,
		primary: set[0]!,
	}, {
		frozen: true,
		selectionsFrozen: true,
		selections: [second, first],
		primary: second,
	});
	assert.equal([first][0]!, first);
	assert.throws(
		() => primaryFirst([], 0),
		/must not be empty/,
	);
	assert.throws(
		() => primaryFirst([first], 1),
		/primaryIndex/,
	);
});

function primaryFirst<T>(items: readonly T[], primaryIndex: number): readonly T[] {
	if (items.length === 0) throw new RangeError('Selections must not be empty');
	if (!Number.isSafeInteger(primaryIndex) || primaryIndex < 0 || primaryIndex >= items.length) throw new RangeError('primaryIndex must identify a selection');
	if (primaryIndex === 0) return Object.freeze([...items]);
	return Object.freeze([items[primaryIndex]!, ...items.slice(0, primaryIndex), ...items.slice(primaryIndex + 1)]);
}
