import assert from 'node:assert/strict';
import { test } from 'mocha';
import { darkColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme, lightColorTheme } from '../../../platform/theme/common/colorTheme.js';
import { colorCssVariable } from '../../../platform/theme/common/colorUtils.js';
import { ColorScheme } from '../../../platform/theme/common/theme.js';
import { StandaloneThemeService } from '../../standalone/browser/standaloneThemeService.js';
import { registerColor } from '../../../platform/theme/common/colorUtils.js';
import { Color } from '../../../base/common/color.js';
import { TokenMetadata } from '../../common/encodedTokenAttributes.js';
import { TokenizationRegistry } from '../../common/languages.js';

class TestMediaQueryList extends EventTarget {
	public matches = false;

	public setMatches(matches: boolean): void {
		if (this.matches === matches) {
			return;
		}
		this.matches = matches;
		this.dispatchEvent(new Event('change'));
	}
}

function createThemeService(): { readonly mediaQuery: TestMediaQueryList; readonly service: StandaloneThemeService } {
	const mediaQuery = new TestMediaQueryList();
	const ownerWindow = {
		matchMedia(query: string): MediaQueryList {
			assert.equal(query, '(forced-colors: active)');
			return mediaQuery as unknown as MediaQueryList;
		},
	} as Window;
	return { mediaQuery, service: new StandaloneThemeService(ownerWindow) };
}

const colorsBeforeEditor = lightColorTheme.colors;
const {
	editorCursorForeground,
	editorMultiCursorSecondaryBackground,
	editorLineHighlight,
	editorInactiveLineHighlight,
	editorLineHighlightBorder,
	editorRuler,
	editorOverviewRulerBorder,
	editorOverviewRulerBackground,
	editorBracketHighlightingForeground1,
	editorBracketHighlightingForeground2,
	editorBracketHighlightingForeground3,
	editorBracketHighlightingForeground4,
	editorBracketHighlightingForeground5,
	editorBracketHighlightingForeground6,
} = await import('../../common/core/editorColorRegistry.js');

test('all bracket nesting colors remain readable in light, dark and high contrast themes', () => {
	const identifiers = [editorBracketHighlightingForeground1, editorBracketHighlightingForeground2, editorBracketHighlightingForeground3, editorBracketHighlightingForeground4, editorBracketHighlightingForeground5, editorBracketHighlightingForeground6];
	for (const theme of [lightColorTheme, darkColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme]) {
		const background = theme.getColor('editor.background');
		assert.ok(background);
		const colors = identifiers.map(identifier => {
			const color = theme.getColor(identifier);
			assert.ok(color, `${theme.id}: ${identifier}`);
			assert.equal(color.rgba.a, 1);
			assert.ok(color.getContrastRatio(background) >= 4.5, `${theme.id}: ${identifier}`);
			return color.toString();
		});
		assert.equal(new Set(colors).size, 6);
	}
});

test('themes created before the editor loads include its color contributions', () => {
	assert.deepEqual({ before: colorsBeforeEditor[editorCursorForeground], after: lightColorTheme.getColorCss(editorCursorForeground) }, {
		before: undefined, after: '#000000',
	});
});

test('standalone themes default to the built-in light theme', () => {
	const fixture = createThemeService();
	using service = fixture.service;
	assert.equal(service.getColorTheme().id, lightColorTheme.id);
});

test('standard theme inheritance updates selected child token colors and preserves input ownership', () => {
	using service = createThemeService().service;
	const rules = [{ token: 'entity', foreground: '124578', fontStyle: 'italic' }];
	service.defineTheme('child-theme', { base: 'vs-dark', inherit: true, rules, colors: { 'editor.background': '#111111' } });
	service.setTheme('child-theme');
	rules[0]!.foreground = 'ffffff';
	const readColor = (scope: string) => {
		const theme = service.getColorTheme().tokenTheme;
		return Color.Format.CSS.formatHex(theme.getColorMap()[TokenMetadata.getForeground(theme.match(1, scope))]!);
	};
	assert.equal(readColor('entity.method'), '#124578');
	assert.equal(service.getColorTheme().getColorCss('editor.background'), '#111111');
	service.defineTheme('vs-dark', { base: 'vs-dark', inherit: true, rules: [{ token: 'comment', foreground: '345678' }], colors: {} });
	assert.equal(service.getColorTheme().themeName, 'child-theme');
	assert.equal(readColor('comment.line'), '#345678');
	assert.equal(readColor('entity.method'), '#124578');
	assert.equal(service.getColorTheme().getColorCss('editor.background'), '#111111');
	const palette = service.getColorTheme().tokenTheme.getColorMap();
	service.setColorMapOverride([Color.transparent, Color.fromHex('#abcdef'), Color.fromHex('#010101')]);
	assert.equal(TokenizationRegistry.getColorMap()![1]!.toString(), '#abcdef');
	service.setColorMapOverride(null);
	assert.deepEqual(TokenizationRegistry.getColorMap(), palette);
});

test('Ash named themes preserve standard base inheritance when replacing a built-in theme', () => {
	using service = createThemeService().service;
	service.defineTheme('inherited', { base: 'vs-dark', inherit: true, rules: [], colors: {} });
	service.setTheme('inherited');
	service.defineNamedTheme('vs-dark', { label: 'Custom Dark', colorScheme: ColorScheme.Dark, colors: { 'editor.background': '#121314' } });
	assert.equal(service.getColorTheme().getColorCss('editor.background'), '#121314');
	service.defineTheme('another', { base: 'vs-dark', inherit: true, rules: [], colors: {} });
	service.setTheme('another');
	assert.equal(service.getColorTheme().getColorCss('editor.background'), '#121314');
	service.setTheme('vs-dark');
	assert.equal(service.getColorTheme().label, 'Custom Dark');
});

test('standalone themes preserve overrides for later contributions and stop notifying after disposal', () => {
	const fixture = createThemeService();
	using service = fixture.service;
	const overrides = { 'editor.background': '#101010' };
	service.defineNamedTheme('late-colors', { label: 'Late Colors', colorScheme: ColorScheme.Dark, colors: overrides });
	service.setTheme('late-colors');
	const theme = service.getColorTheme();
	const before = theme.colors;
	const entries = theme.colorEntries;
	assert.equal(theme.colorEntries, entries);
	overrides['editor.background'] = '#ffffff';
	const changes: string[] = [];
	using listener = service.onDidColorThemeChange(value => changes.push(value.getColorCss('test.standaloneLate')!));
	registerColor('test.standaloneLate', { dark: 'editor.background', light: '#abcdef' }, { description: 'Late standalone test.', owner: 'test' });
	assert.deepEqual({ before: before['test.standaloneLate'], value: theme.colors['test.standaloneLate'], changes }, {
		before: undefined, value: '#101010', changes: ['#101010'],
	});
	assert.equal(theme.getColorCss('editor.background'), '#101010');
	assert.equal(theme.colorEntries, theme.colorEntries);
	service.dispose();
	registerColor('test.standaloneAfterDispose', { dark: '#000000', light: '#ffffff' }, { description: 'Disposed standalone test.', owner: 'test' });
	assert.deepEqual(changes, ['#101010']);
});

test('standalone themes register by ID and refresh the active theme', () => {
	const fixture = createThemeService();
	using service = fixture.service;
	const events: string[] = [];
	using listener = service.onDidColorThemeChange(theme => events.push(theme.id));

	service.defineNamedTheme('sample-dark', {
		label: 'Sample Dark',
		colorScheme: ColorScheme.Dark,
		colors: { 'editor.background': '#101010' },
	});
	service.setTheme('sample-dark');
	assert.equal(service.getColorTheme().getColorCss('editor.background'), '#101010');

	service.defineNamedTheme('sample-dark', {
		label: 'Updated Sample Dark',
		colorScheme: ColorScheme.Dark,
		colors: { 'editor.background': '#202020' },
	});
	assert.deepEqual(events, ['sample-dark', 'sample-dark']);
	assert.equal(service.getColorTheme().getColorCss('editor.background'), '#202020');
	assert.throws(() => service.setTheme('missing-theme'), /Unknown standalone color theme/);
});

test('standalone themes track forced colors without losing the selected theme', () => {
	const fixture = createThemeService();
	using service = fixture.service;
	service.setTheme(darkColorTheme.id);
	fixture.mediaQuery.setMatches(true);
	assert.equal(service.getColorTheme().id, highContrastDarkColorTheme.id);
	service.defineNamedTheme(highContrastDarkColorTheme.id, {
		label: 'Updated High Contrast Dark',
		colorScheme: ColorScheme.HighContrastDark,
		colors: { 'editor.background': '#010101' },
	});
	assert.equal(service.getColorTheme().getColorCss('editor.background'), '#010101');

	fixture.mediaQuery.setMatches(false);
	assert.equal(service.getColorTheme().id, darkColorTheme.id);
	service.setTheme(lightColorTheme.id);
	fixture.mediaQuery.setMatches(true);
	assert.equal(service.getColorTheme().id, highContrastLightColorTheme.id);

	service.setAutoDetectHighContrast(false);
	assert.equal(service.getColorTheme().id, lightColorTheme.id);
});

test('editor identifiers retain their CSS variables', () => {
	assert.equal(
		colorCssVariable(editorMultiCursorSecondaryBackground),
		'--ash-editor-multi-cursor-secondary-background',
	);
	assert.equal(colorCssVariable(editorLineHighlight), '--ash-editor-line-highlight-background');
	assert.equal(colorCssVariable(editorInactiveLineHighlight), '--ash-editor-inactive-line-highlight-background');
	assert.equal(colorCssVariable(editorLineHighlightBorder), '--ash-editor-line-highlight-border');
	assert.equal(colorCssVariable(editorRuler), '--ash-editor-ruler-foreground');
	assert.equal(colorCssVariable(editorOverviewRulerBorder), '--ash-editor-overview-ruler-border');
	assert.equal(colorCssVariable(editorOverviewRulerBackground), '--ash-editor-overview-ruler-background');
});

test('current-line colors preserve transparent fills and high-contrast borders', () => {
	assert.deepEqual({
		darkBackground: darkColorTheme.colors[editorLineHighlight],
		lightBackground: lightColorTheme.colors[editorLineHighlight],
		highContrastDarkBorder: highContrastDarkColorTheme.colors[editorLineHighlightBorder],
		highContrastLightBorder: highContrastLightColorTheme.colors[editorLineHighlightBorder],
		strokeThickness: darkColorTheme.getSize('strokeThickness'),
	}, {
		darkBackground: '#00000000',
		lightBackground: '#00000000',
		highContrastDarkBorder: '#f38518',
		highContrastLightBorder: '#0f4a85',
		strokeThickness: { value: 1, unit: 'px' },
	});
});

test('editor ruler colors preserve the editor theme contract', () => {
	assert.deepEqual({
		dark: darkColorTheme.colors[editorRuler],
		light: lightColorTheme.colors[editorRuler],
		highContrastDark: highContrastDarkColorTheme.colors[editorRuler],
		highContrastLight: highContrastLightColorTheme.colors[editorRuler],
	}, {
		dark: '#5a5a5a',
		light: '#d3d3d3',
		highContrastDark: '#ffffff',
		highContrastLight: '#292929',
	});
});

test('overview ruler colors preserve transparent normal borders and a solid high-contrast light border', () => {
	assert.deepEqual({
		darkBorder: darkColorTheme.colors[editorOverviewRulerBorder],
		lightBorder: lightColorTheme.colors[editorOverviewRulerBorder],
		highContrastDarkBorder: highContrastDarkColorTheme.colors[editorOverviewRulerBorder],
		highContrastLightBorder: highContrastLightColorTheme.colors[editorOverviewRulerBorder],
		darkBackground: darkColorTheme.colors[editorOverviewRulerBackground],
		lightBackground: lightColorTheme.colors[editorOverviewRulerBackground],
	}, {
		darkBorder: '#7f7f7f4d',
		lightBorder: '#7f7f7f4d',
		highContrastDarkBorder: '#7f7f7f4d',
		highContrastLightBorder: '#666666',
		darkBackground: '#1e1e1e00',
		lightBackground: '#ffffff00',
	});
});
