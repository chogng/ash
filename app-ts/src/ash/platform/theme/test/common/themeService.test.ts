import { strict as assert } from "node:assert";
import { test } from "mocha";
import {
	ColorId,
	colorCssVariable,
	darkColorTheme,
	highContrastDarkColorTheme,
	lightColorTheme,
	sizeCssVariable,
} from "../../common/colorTheme.js";
import { TestThemeService } from "./testThemeService.js";
import { Colors } from "../../common/colorRegistry.js";

test("TestThemeService exposes its initial theme and emits actual changes", () => {
	using service = new TestThemeService(darkColorTheme);
	const changes: string[] = [];
	using listener = service.onDidColorThemeChange((theme) => {
		changes.push(theme.id);
	});

	service.setColorTheme(darkColorTheme);
	service.setColorTheme(lightColorTheme);

	assert.equal(service.getColorTheme(), lightColorTheme);
	assert.deepEqual(changes, ["ash-light"]);
});

test("built-in themes resolve registered colors and omit inactive high contrast borders", () => {
	for (const theme of [darkColorTheme, lightColorTheme, highContrastDarkColorTheme]) {
		assert.equal(theme.colorEntries.length, Colors.getColors().length);
		for (const { id, value } of theme.colorEntries) {
			assert.equal(theme.getColorCss(id), theme.colors[id]);
			assert.equal(typeof theme.colors[id], value ? "string" : "undefined");
		}
	}
	assert.equal(darkColorTheme.getColorCss('contrastBorder'), undefined);
	assert.equal(highContrastDarkColorTheme.getColorCss('contrastBorder'), '#ffffff');
});

test("color identifiers map to stable CSS custom properties", () => {
	assert.equal(
		colorCssVariable(ColorId.primaryButtonHoverBackground),
		"--ash-button-primary-hover-background",
	);
	assert.equal(
		colorCssVariable(ColorId.editorForeground),
		"--ash-editor-foreground",
	);
	assert.equal(sizeCssVariable('strokeThickness'), '--ash-stroke-thickness');
	assert.equal(colorCssVariable(ColorId.editorFoldBackground), '--ash-editor-fold-background');
	assert.equal(colorCssVariable(ColorId.editorFoldPlaceholderForeground), '--ash-editor-fold-placeholder-foreground');
	assert.equal(colorCssVariable(ColorId.editorGutterFoldingControlForeground), '--ash-editor-gutter-folding-control-foreground');
});
