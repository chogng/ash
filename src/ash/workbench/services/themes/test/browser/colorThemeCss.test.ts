import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { darkColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme, lightColorTheme } from '../../../../../platform/theme/common/colorTheme.js';
import { generateColorThemeCSS } from '../../browser/colorThemeCss.js';
import { ManagedStyleSheet } from '../../../../../base/browser/domStylesheets.js';
import { registerColor } from '../../../../../platform/theme/common/colorUtils.js';

test('theme CSS applies registered colors, sizes and scheme, masks missing colors, and releases its styles', () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	try {
		const root = browser.window.document.documentElement;
		const styles = new ManagedStyleSheet(browser.window.document);
		for (const theme of [lightColorTheme, darkColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme]) {
			styles.setText(generateColorThemeCSS(theme, ':root').code);
			const computed = browser.window.getComputedStyle(root);
			assert.equal(computed.getPropertyValue('--ash-editor-background'), theme.getColorCss('editor.background'));
			assert.equal(computed.getPropertyValue('--ash-fontSize-body1'), '13px');
			assert.equal(computed.getPropertyValue('--ash-fontWeight-semiBold'), '600');
			assert.equal(computed.getPropertyValue('--ash-spacing-size80'), '8px');
			assert.equal(computed.getPropertyValue('--ash-lxiconFontSize-compact'), '12px');
			const highContrast = theme === highContrastDarkColorTheme || theme === highContrastLightColorTheme;
			assert.equal(computed.getPropertyValue('--ash-shadow-lg'), highContrast ? 'none' : '0 0 12px rgba(0,0,0,0.14)');
			assert.equal(computed.getPropertyValue('color-scheme'), theme === darkColorTheme || theme === highContrastDarkColorTheme ? 'dark' : 'light');
			if (highContrast) assert.equal(computed.getPropertyValue('--ash-widget-shadow'), '');
		}
		styles.dispose();
		assert.equal(browser.window.getComputedStyle(root).getPropertyValue('--ash-editor-background'), '');
		assert.equal(browser.window.document.querySelector('style'), null);
	} finally { browser.window.close(); }
});

test('theme CSS includes colors registered after a theme was first serialized', () => {
	const previous = generateColorThemeCSS(darkColorTheme, ':root').code;
	registerColor('test.cssLate', { dark: '#123456', light: '#abcdef', hcDark: '#ffffff', hcLight: '#000000' }, { description: 'Late CSS test.', owner: 'test' });
	assert(!previous.includes('--ash-test-cssLate'));
	assert(generateColorThemeCSS(darkColorTheme, ':root').code.includes('--ash-test-cssLate: #123456;'));
	assert(generateColorThemeCSS(lightColorTheme, ':root').code.includes('--ash-test-cssLate: #abcdef;'));
});
