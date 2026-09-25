import assert from 'node:assert/strict';
import { test } from 'mocha';
import { themeColorFromId } from '../../../base/common/themables.js';
import { errorForeground } from '../../../platform/theme/common/colors/baseColors.js';
import { TextDecorationCollection } from '../../common/model/decorationCollection.js';
import { Range } from '../../common/core/range.js';
import { TextModel } from '../../common/model/textModel.js';
import { GlyphMarginLane, MinimapPosition, OverviewRulerLane, TrackedRangeStickiness } from '../../common/model.js';

test('TextDecorationCollection keeps opaque metadata beside standard model options', () => {
	using model = new TextModel('abcd\nefgh\nij');
	using collection = new TextDecorationCollection<{ readonly kind: 'match' | 'error' }>(model);
	const match = collection.add({
		range: new Range(1, 2, 2, 3),
		stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
		options: { description: 'find-match', className: 'findMatch' },
		metadata: { kind: 'match' },
	});
	const error = collection.add({
		range: new Range(3, 1, 3, 3),
		stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
		options: {
			description: 'marker-decoration',
			className: 'squiggly-error',
			hoverMessage: { value: 'error' },
			overviewRuler: { color: themeColorFromId(errorForeground), position: OverviewRulerLane.Right },
			minimap: { color: themeColorFromId(errorForeground), position: MinimapPosition.Inline },
		},
		metadata: { kind: 'error' },
	});

	assert.deepEqual(collection.decorations.map(decoration => [decoration.id, decoration.metadata.kind]), [[match, 'match'], [error, 'error']]);
	assert.deepEqual(model.getAllDecorations().map(decoration => decoration.options.className), ['findMatch', 'squiggly-error']);
	collection.delete(error);
	assert.deepEqual(model.getAllDecorations().map(decoration => decoration.options.className), ['findMatch']);
});

test('TextDecorationCollection updates empty-range presentation through model options', () => {
	using model = new TextModel('abcd\nefgh');
	using collection = new TextDecorationCollection<string>(model);
	const id = collection.add({
		range: new Range(2, 3, 2, 3),
		stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
		options: { description: 'hint', className: 'squiggly-hint', showIfCollapsed: true },
		metadata: 'hint',
	});
	collection.update(id, {
		range: new Range(2, 2, 2, 4),
		stickiness: TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges,
		options: { description: 'warning', className: 'squiggly-warning', showIfCollapsed: true },
		metadata: 'warning',
	});

	const [decoration] = model.getAllDecorations();
	assert.deepEqual(decoration?.range, new Range(2, 2, 2, 4));
	assert.equal(decoration?.options.className, 'squiggly-warning');
	assert.equal(collection.get(id)?.metadata, 'warning');
});

test('Glyph margin presentation uses the standard lane and z-index options', () => {
	using model = new TextModel('abc');
	using collection = new TextDecorationCollection<string>(model);
	collection.add({
		range: new Range(1, 1, 1, 1),
		stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
		options: {
			description: 'folding',
			glyphMarginClassName: 'folding-marker',
			glyphMargin: { position: GlyphMarginLane.Center },
			glyphMarginHoverMessage: { value: 'Collapse lines' },
			zIndex: 4,
		},
		metadata: 'folding',
	});

	const [decoration] = model.getAllMarginDecorations();
	assert.equal(decoration?.options.glyphMarginClassName, 'folding-marker');
	assert.equal(decoration?.options.glyphMargin?.position, GlyphMarginLane.Center);
	assert.equal(decoration?.options.zIndex, 4);
});

test('Line-side and block presentation remain standard model decoration options', () => {
	using model = new TextModel('one\ntwo\nthree');
	using collection = new TextDecorationCollection<string>(model);
	collection.add({
		range: new Range(1, 1, 3, 1),
		stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
		options: {
			description: 'line-and-block',
			linesDecorationsClassName: 'line-marker',
			firstLineDecorationClassName: 'first-line-marker',
			linesDecorationsTooltip: 'Changed lines',
			blockClassName: 'changed-block',
			blockPadding: [1, 2, 3, 4],
		},
		metadata: 'changed',
	});

	const [decoration] = model.getAllDecorations();
	assert.equal(decoration?.options.linesDecorationsClassName, 'line-marker');
	assert.equal(decoration?.options.firstLineDecorationClassName, 'first-line-marker');
	assert.equal(decoration?.options.blockClassName, 'changed-block');
	assert.deepEqual(decoration?.options.blockPadding, [1, 2, 3, 4]);
});
