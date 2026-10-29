import assert from 'node:assert/strict';
import { test } from 'mocha';
import { type IEditorConfiguration } from '../../../common/config/editorConfiguration.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import { type ICoordinatesConverter } from '../../../common/coordinatesConverter.js';
import { Range } from '../../../common/core/range.js';
import { type IModelDecoration } from '../../../common/model.js';
import { CustomLineHeightData, LineHeightsManager } from '../../../common/viewLayout/lineHeights.js';

test('line heights resolve the tallest overlapping decoration', () => {
	const heights = new LineHeightsManager(10, [
		new CustomLineHeightData('wide', 2, 4, 18),
		new CustomLineHeightData('tall', 3, 5, 24),
	]);
	assert.deepEqual([1, 2, 3, 4, 5, 6].map(line => heights.heightForLineNumber(line)), [10, 18, 24, 24, 24, 10]);
	assert.equal(heights.getAccumulatedLineHeightsIncludingLineNumber(6), 110);
});

test('line insertions shift later ranges and extend containing ranges', () => {
	const heights = new LineHeightsManager(10, []);
	heights.insertOrChangeCustomLineHeight('range', 3, 5, 20);
	heights.onLinesInserted(4, 5);
	assert.deepEqual([3, 4, 5, 6, 7, 8].map(line => heights.heightForLineNumber(line)), [20, 20, 20, 20, 20, 10]);
	heights.onLinesInserted(1, 1);
	assert.deepEqual([3, 4, 8].map(line => heights.heightForLineNumber(line)), [10, 20, 20]);
});

test('line deletions preserve surviving spans and collapse fully removed ranges', () => {
	const heights = new LineHeightsManager(10, []);
	heights.insertOrChangeCustomLineHeight('partial', 3, 7, 20);
	heights.insertOrChangeCustomLineHeight('removed', 9, 10, 30);
	heights.onLinesDeleted(5, 10);
	assert.deepEqual([3, 4, 5, 6].map(line => heights.heightForLineNumber(line)), [20, 20, 30, 10]);
});

test('changing and removing a decoration takes effect immediately', () => {
	const heights = new LineHeightsManager(12, []);
	heights.insertOrChangeCustomLineHeight('active', 2, 2, 20);
	heights.insertOrChangeCustomLineHeight('active', 4, 4, 28);
	assert.deepEqual([2, 4].map(line => heights.heightForLineNumber(line)), [12, 28]);
	heights.removeCustomLineHeight('active');
	assert.equal(heights.heightForLineNumber(4), 12);
});

test('custom line height data uses visual ranges and the configured base height', () => {
	const modelRange = new Range(2, 1, 4, 1);
	const viewRange = new Range(3, 1, 6, 1);
	const decorations = [{
		id: 'block',
		range: modelRange,
		options: { lineHeight: 1.5 },
	}] as IModelDecoration[];
	const coordinates = {
		convertModelRangeToViewRange: (range: Range) => {
			assert.strictEqual(range, modelRange);
			return viewRange;
		},
	} as unknown as ICoordinatesConverter;
	const configuration = {
		options: {
			get: (option: EditorOption) => {
				assert.equal(option, EditorOption.lineHeight);
				return 20;
			},
		},
	} as unknown as IEditorConfiguration;

	assert.deepEqual(CustomLineHeightData.fromDecorations(decorations, coordinates, configuration), [
		new CustomLineHeightData('block', 3, 6, 30),
	]);
});
