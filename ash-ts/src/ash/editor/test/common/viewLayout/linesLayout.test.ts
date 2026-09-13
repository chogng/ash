import assert from 'node:assert/strict';
import { test } from 'mocha';
import { LinesLayout } from '../../../common/viewLayout/linesLayout.js';

test('whitespace batches preserve visual order, offsets, and width', () => {
	const layout = new LinesLayout(4, 10, 2, 3, []);
	let first = '';
	let narrow = '';
	let wide = '';
	layout.changeWhitespace(accessor => {
		wide = accessor.insertWhitespace(2, 20, 7, 30);
		narrow = accessor.insertWhitespace(2, 10, 5, 50);
		first = accessor.insertWhitespace(0, 0, 4, 20);
	});

	assert.deepEqual(layout.getWhitespaces().map(space => [space.id, space.afterLineNumber]), [
		[first, 0],
		[narrow, 2],
		[wide, 2],
	]);
	assert.deepEqual([0, 1, 2].map(index => layout.getVerticalOffsetForWhitespaceIndex(index)), [2, 26, 31]);
	assert.equal(layout.getVerticalOffsetForLineNumber(1), 6);
	assert.equal(layout.getWhitespaceMinWidth(), 50);
	assert.equal(layout.getLinesTotalHeight(), 61);

	layout.changeWhitespace(accessor => {
		accessor.changeOneWhitespace(wide, 3, 8);
		accessor.removeWhitespace(narrow);
	});
	assert.deepEqual(layout.getWhitespaces().map(space => [space.id, space.afterLineNumber, space.height]), [
		[first, 0, 4],
		[wide, 3, 8],
	]);
	assert.equal(layout.getWhitespaceMinWidth(), 30);
});

test('line changes keep custom heights and whitespace anchored to the line collection', () => {
	const layout = new LinesLayout(5, 10, 0, 0, [{
		decorationId: 'tall',
		startLineNumber: 2,
		endLineNumber: 3,
		lineHeight: 20,
	}]);
	let zone = '';
	layout.changeWhitespace(accessor => {
		zone = accessor.insertWhitespace(3, 0, 6, 0);
	});

	assert.deepEqual([1, 2, 3, 4].map(line => layout.getVerticalOffsetForLineNumber(line)), [0, 10, 30, 56]);
	assert.equal(layout.getLinesTotalHeight(), 76);

	layout.onLinesInserted(2, 3);
	assert.deepEqual(layout.getWhitespaces().map(space => [space.id, space.afterLineNumber]), [[zone, 5]]);
	assert.deepEqual([2, 4, 5].map(line => layout.getLineHeightForLineNumber(line)), [10, 20, 20]);
	assert.equal(layout.getLinesTotalHeight(), 96);

	layout.onLinesDeleted(4, 5);
	assert.deepEqual(layout.getWhitespaces().map(space => [space.id, space.afterLineNumber]), [[zone, 3]]);
	assert.equal(layout.getLineHeightForLineNumber(4), 20);
	assert.equal(layout.getLinesTotalHeight(), 66);
});

test('viewport queries include intersecting lines and whitespace geometry', () => {
	const layout = new LinesLayout(6, 10, 0, 0, []);
	let zone = '';
	layout.changeWhitespace(accessor => {
		zone = accessor.insertWhitespace(2, 0, 20, 0);
	});

	const viewport = layout.getLinesViewportData(5, 45);
	assert.deepEqual({
		startLineNumber: viewport.startLineNumber,
		endLineNumber: viewport.endLineNumber,
		relativeVerticalOffset: viewport.relativeVerticalOffset,
		centeredLineNumber: viewport.centeredLineNumber,
		completelyVisibleStartLineNumber: viewport.completelyVisibleStartLineNumber,
		completelyVisibleEndLineNumber: viewport.completelyVisibleEndLineNumber,
	}, {
		startLineNumber: 1,
		endLineNumber: 3,
		relativeVerticalOffset: [0, 10, 40],
		centeredLineNumber: 3,
		completelyVisibleStartLineNumber: 2,
		completelyVisibleEndLineNumber: 2,
	});
	assert.deepEqual(layout.getWhitespaceViewportData(0, 45), [{ id: zone, afterLineNumber: 2, verticalOffset: 20, height: 20 }]);
	assert.deepEqual(layout.getWhitespaceAtVerticalOffset(39), { id: zone, afterLineNumber: 2, verticalOffset: 20, height: 20 });
	assert.equal(layout.getWhitespaceAtVerticalOffset(40), null);
});
