import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { ViewLineOptions } from '../../browser/viewParts/viewLines/viewLineOptions.js';
import { ColorScheme } from '../../../platform/theme/common/theme.js';
import { createTestConfiguration, TEST_FONT_INFO } from './config/testConfiguration.js';

test('ViewLineOptions snapshots every line-rendering input', () => {
	const dom = new JSDOM('<div></div>');
	using configuration = createTestConfiguration(dom.window.document.querySelector('div')!, {
		renderWhitespace: 'boundary',
		experimentalWhitespaceRendering: 'font',
		renderControlCharacters: true,
		disableMonospaceOptimizations: true,
		lineHeight: 22,
		stopRenderingLineAfter: 2_000,
		fontLigatures: true,
		scrollbar: { verticalScrollbarSize: 18 },
		experimentalGpuAcceleration: 'on',
	});
	const options = new ViewLineOptions(configuration, ColorScheme.HighContrastDark);

	assert.deepEqual({
		themeType: options.themeType,
		renderWhitespace: options.renderWhitespace,
		experimentalWhitespaceRendering: options.experimentalWhitespaceRendering,
		renderControlCharacters: options.renderControlCharacters,
		spaceWidth: options.spaceWidth,
		middotWidth: options.middotWidth,
		wsmiddotWidth: options.wsmiddotWidth,
		useMonospaceOptimizations: options.useMonospaceOptimizations,
		canUseHalfwidthRightwardsArrow: options.canUseHalfwidthRightwardsArrow,
		lineHeight: options.lineHeight,
		stopRenderingLineAfter: options.stopRenderingLineAfter,
		fontLigatures: options.fontLigatures,
		verticalScrollbarSize: options.verticalScrollbarSize,
		useGpu: options.useGpu,
	}, {
		themeType: ColorScheme.HighContrastDark,
		renderWhitespace: 'boundary',
		experimentalWhitespaceRendering: 'font',
		renderControlCharacters: true,
		spaceWidth: TEST_FONT_INFO.spaceWidth,
		middotWidth: TEST_FONT_INFO.middotWidth,
		wsmiddotWidth: TEST_FONT_INFO.wsmiddotWidth,
		useMonospaceOptimizations: false,
		canUseHalfwidthRightwardsArrow: TEST_FONT_INFO.canUseHalfwidthRightwardsArrow,
		lineHeight: 22,
		stopRenderingLineAfter: 2_000,
		fontLigatures: '"liga" on, "calt" on',
		verticalScrollbarSize: 18,
		useGpu: true,
	});
	dom.window.close();
});

test('ViewLineOptions compares every renderer-owned field', () => {
	const dom = new JSDOM('<div></div>');
	using configuration = createTestConfiguration(dom.window.document.querySelector('div')!);
	const options = new ViewLineOptions(configuration, ColorScheme.Dark);
	assert.equal(options.equals(new ViewLineOptions(configuration, ColorScheme.Dark)), true);
	assert.equal(options.equals(new ViewLineOptions(configuration, ColorScheme.Light)), false);
	configuration.updateOptions({ renderWhitespace: 'all' });
	assert.equal(options.equals(new ViewLineOptions(configuration, ColorScheme.Dark)), false);
	dom.window.close();
});
