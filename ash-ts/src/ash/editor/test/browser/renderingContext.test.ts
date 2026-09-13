import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Position } from '../../common/core/position.js';
import { Range } from '../../common/core/range.js';
import { type IViewLayout } from '../../common/viewModel.js';
import { type ViewportData } from '../../common/viewLayout/viewLinesViewportData.js';
import { HorizontalPosition, HorizontalRange, LineVisibleRanges, RenderingContext, RestrictedRenderingContext, type IViewLines } from '../../browser/view/renderingContext.js';

const visibleRange = new Range(2, 1, 4, 8);
const viewportData = {
	visibleRange,
	bigNumbersDelta: 100,
	lineHeight: 20,
	startLineNumber: 2,
	endLineNumber: 4,
	getDecorationsInViewport: () => [],
} as unknown as ViewportData;
const viewLayout = {
	getScrollWidth: () => 800,
	getScrollHeight: () => 1_200,
	getCurrentViewport: () => ({ left: 30, top: 240, width: 600, height: 400 }),
	getVerticalOffsetForLineNumber: (lineNumber: number) => lineNumber * 20,
	getVerticalOffsetAfterLineNumber: (lineNumber: number) => (lineNumber + 1) * 20,
	getLineHeightForLineNumber: () => 20,
} as unknown as IViewLayout;

test('RestrictedRenderingContext exposes the immutable viewport contract', () => {
	const context = new class extends RestrictedRenderingContext {}(viewLayout, viewportData);

	assert.deepEqual({
		scrollWidth: context.scrollWidth,
		scrollHeight: context.scrollHeight,
		scrollLeft: context.scrollLeft,
		scrollTop: context.scrollTop,
		viewportWidth: context.viewportWidth,
		viewportHeight: context.viewportHeight,
		bigNumbersDelta: context.bigNumbersDelta,
	}, {
		scrollWidth: 800,
		scrollHeight: 1_200,
		scrollLeft: 30,
		scrollTop: 240,
		viewportWidth: 600,
		viewportHeight: 400,
		bigNumbersDelta: 100,
	});
	assert.equal(context.visibleRange, visibleRange);
	assert.equal(context.getScrolledTopFromAbsoluteTop(300), 60);
	assert.equal(context.getVerticalOffsetForLineNumber(3), 60);
	assert.equal(context.getVerticalOffsetAfterLineNumber(3), 80);
	assert.equal(context.getLineHeightForLineNumber(3), 20);
});

test('RenderingContext combines DOM and GPU line geometry', () => {
	const domLines: IViewLines = {
		linesVisibleRangesForRange: () => [new LineVisibleRanges(false, 4, [new HorizontalRange(10, 5)], false)],
		visibleRangeForPosition: () => null,
	};
	const gpuLines: IViewLines = {
		linesVisibleRangesForRange: () => [new LineVisibleRanges(false, 2, [new HorizontalRange(20, 6)], true)],
		visibleRangeForPosition: () => new HorizontalPosition(false, 12.6),
	};
	const context = new RenderingContext(viewLayout, viewportData, domLines, gpuLines);

	assert.deepEqual(context.linesVisibleRangesForRange(visibleRange, true)?.map(range => range.lineNumber), [2, 4]);
	assert.deepEqual(context.visibleRangeForPosition(new Position(2, 1)), new HorizontalPosition(false, 12.6));
});

test('rendering geometry keeps original coordinates and rounded DOM coordinates', () => {
	const position = new HorizontalPosition(false, 12.6);
	const ranges = [
		new LineVisibleRanges(false, 8, [new HorizontalRange(10.4, 3.7)], true),
		new LineVisibleRanges(false, 3, [new HorizontalRange(2.2, 5.8)], false),
	];

	assert.deepEqual({ left: position.left, originalLeft: position.originalLeft }, { left: 13, originalLeft: 12.6 });
	assert.deepEqual(ranges[0]?.ranges[0], new HorizontalRange(10, 4));
	assert.equal(LineVisibleRanges.firstLine(ranges)?.lineNumber, 3);
	assert.equal(LineVisibleRanges.lastLine(ranges)?.lineNumber, 8);
	assert.equal(LineVisibleRanges.firstLine(null), null);
});
