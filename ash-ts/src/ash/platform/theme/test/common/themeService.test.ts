import { strict as assert } from "node:assert";
import { test } from "mocha";
import {
	ColorId,
	colorCssVariable,
	colorIdentifiers,
	darkColorTheme,
	highContrastDarkColorTheme,
	highContrastLightColorTheme,
	lightColorTheme,
	sizeCssVariable,
} from "../../common/colorTheme.js";
import { ThemeService } from "../../common/themeService.js";

test("ThemeService exposes its initial theme and emits actual changes", () => {
	using service = new ThemeService(darkColorTheme);
	const changes: string[] = [];
	using listener = service.onDidColorThemeChange((theme) => {
		changes.push(theme.id);
	});

	service.setColorTheme(darkColorTheme);
	service.setColorTheme(lightColorTheme);

	assert.equal(service.getColorTheme(), lightColorTheme);
	assert.deepEqual(changes, ["ash-light"]);
});

test("built-in themes define every registered color", () => {
	for (const id of colorIdentifiers) {
		assert.equal(typeof darkColorTheme.colors[id], "string");
		assert.equal(typeof lightColorTheme.colors[id], "string");
		assert.equal(darkColorTheme.getColorCss(id), darkColorTheme.colors[id]);
		assert.equal(lightColorTheme.getColorCss(id), lightColorTheme.colors[id]);
	}
});

test("color identifiers map to stable CSS custom properties", () => {
	assert.equal(
		colorCssVariable(ColorId.primaryButtonHoverBackground),
		"--ash-button-primary-hover-background",
	);
	assert.equal(
		colorCssVariable(ColorId.titleBarForeground),
		"--ash-title-bar-foreground",
	);
	assert.equal(
		colorCssVariable(ColorId.editorMultiCursorSecondaryBackground),
		"--ash-editor-multi-cursor-secondary-background",
	);
	assert.equal(colorCssVariable(ColorId.editorFoldBackground), '--ash-editor-fold-background');
	assert.equal(colorCssVariable(ColorId.editorFoldPlaceholderForeground), '--ash-editor-fold-placeholder-foreground');
	assert.equal(colorCssVariable(ColorId.editorGutterFoldingControlForeground), '--ash-editor-gutter-folding-control-foreground');
	assert.equal(colorCssVariable(ColorId.editorLineHighlightBackground), '--ash-editor-line-highlight-background');
	assert.equal(colorCssVariable(ColorId.editorInactiveLineHighlightBackground), '--ash-editor-inactive-line-highlight-background');
	assert.equal(colorCssVariable(ColorId.editorLineHighlightBorder), '--ash-editor-line-highlight-border');
	assert.equal(colorCssVariable(ColorId.editorRulerForeground), '--ash-editor-ruler-foreground');
	assert.equal(colorCssVariable(ColorId.editorOverviewRulerBorder), '--ash-editor-overview-ruler-border');
	assert.equal(colorCssVariable(ColorId.editorOverviewRulerBackground), '--ash-editor-overview-ruler-background');
	assert.equal(sizeCssVariable('strokeThickness'), '--ash-stroke-thickness');
});

test('current-line colors preserve transparent fills and high-contrast borders', () => {
	assert.deepEqual({
		darkBackground: darkColorTheme.colors[ColorId.editorLineHighlightBackground],
		lightBackground: lightColorTheme.colors[ColorId.editorLineHighlightBackground],
		highContrastDarkBorder: highContrastDarkColorTheme.colors[ColorId.editorLineHighlightBorder],
		highContrastLightBorder: highContrastLightColorTheme.colors[ColorId.editorLineHighlightBorder],
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
		dark: darkColorTheme.colors[ColorId.editorRulerForeground],
		light: lightColorTheme.colors[ColorId.editorRulerForeground],
		highContrastDark: highContrastDarkColorTheme.colors[ColorId.editorRulerForeground],
		highContrastLight: highContrastLightColorTheme.colors[ColorId.editorRulerForeground],
	}, {
		dark: '#5a5a5a',
		light: '#d3d3d3',
		highContrastDark: '#ffffff',
		highContrastLight: '#292929',
	});
});

test('overview ruler colors preserve transparent normal borders and a solid high-contrast light border', () => {
	assert.deepEqual({
		darkBorder: darkColorTheme.colors[ColorId.editorOverviewRulerBorder],
		lightBorder: lightColorTheme.colors[ColorId.editorOverviewRulerBorder],
		highContrastDarkBorder: highContrastDarkColorTheme.colors[ColorId.editorOverviewRulerBorder],
		highContrastLightBorder: highContrastLightColorTheme.colors[ColorId.editorOverviewRulerBorder],
		darkBackground: darkColorTheme.colors[ColorId.editorOverviewRulerBackground],
		lightBackground: lightColorTheme.colors[ColorId.editorOverviewRulerBackground],
	}, {
		darkBorder: '#7f7f7f4d',
		lightBorder: '#7f7f7f4d',
		highContrastDarkBorder: '#7f7f7f4d',
		highContrastLightBorder: '#666666',
		darkBackground: '#1e1e1e00',
		lightBackground: '#ffffff00',
	});
});
