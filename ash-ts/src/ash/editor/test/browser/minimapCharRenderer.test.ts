import assert from 'node:assert/strict';
import { test } from 'mocha';
import { MinimapCharRendererFactory } from '../../browser/viewParts/minimap/minimapCharRendererFactory.js';
import { Constants } from '../../browser/viewParts/minimap/minimapCharSheet.js';
import { RGBA8 } from '../../common/core/misc/rgba.js';

test('Minimap character renderer downsamples one glyph sheet into deterministic pixels', () => {
	const source = new Uint8ClampedArray(
		Constants.SAMPLED_CHAR_HEIGHT * Constants.SAMPLED_CHAR_WIDTH * Constants.RGBA_CHANNELS_CNT * Constants.CHAR_COUNT,
	);
	source.fill(255);
	const renderer = MinimapCharRendererFactory.createFromSampleData(source, 1);
	const target = createImageData(1, 2);

	renderer.renderChar(
		target,
		0,
		0,
		'A'.charCodeAt(0),
		new RGBA8(255, 255, 255, 255),
		255,
		new RGBA8(0, 0, 0, 255),
		255,
		1,
		false,
		false,
	);

	assert.deepEqual([...target.data], [204, 204, 204, 255, 204, 204, 204, 255]);
});

test('Minimap character renderer validates sheet dimensions and paints block mode', () => {
	assert.throws(() => MinimapCharRendererFactory.createFromSampleData(new Uint8ClampedArray(1), 1), /Unexpected source/);
	const source = new Uint8ClampedArray(
		Constants.SAMPLED_CHAR_HEIGHT * Constants.SAMPLED_CHAR_WIDTH * Constants.RGBA_CHANNELS_CNT * Constants.CHAR_COUNT,
	);
	source.fill(255);
	const renderer = MinimapCharRendererFactory.createFromSampleData(source, 2);
	const target = createImageData(2, 4);
	renderer.blockRenderChar(target, 0, 0, new RGBA8(255, 255, 255, 255), 255, new RGBA8(0, 0, 0, 255), 255, false);
	assert.deepEqual([...target.data.slice(0, 8)], [128, 128, 128, 255, 128, 128, 128, 255]);
});

function createImageData(width: number, height: number): ImageData {
	return {
		colorSpace: 'srgb',
		width,
		height,
		data: new Uint8ClampedArray(width * height * Constants.RGBA_CHANNELS_CNT),
	};
}
