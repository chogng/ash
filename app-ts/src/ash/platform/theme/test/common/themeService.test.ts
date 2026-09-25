import { strict as assert } from "node:assert";
import { test } from "mocha";
import {
	darkColorTheme,
	highContrastDarkColorTheme,
	lightColorTheme,
} from "../../common/colorTheme.js";
import { colorCssVariable } from "../../common/colorUtils.js";
import { editorForeground, foldBackground, foldPlaceholderForeground, foldingControlForeground } from "../../common/colors/editorColors.js";
import { primaryButtonHoverBackground } from "../../common/colors/inputColors.js";
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
		colorCssVariable(primaryButtonHoverBackground),
		"--ash-button-primary-hover-background",
	);
	assert.equal(
		colorCssVariable(editorForeground),
		"--ash-editor-foreground",
	);
	assert.equal(colorCssVariable(foldBackground), '--ash-editor-fold-background');
	assert.equal(colorCssVariable(foldPlaceholderForeground), '--ash-editor-fold-placeholder-foreground');
	assert.equal(colorCssVariable(foldingControlForeground), '--ash-editor-gutter-folding-control-foreground');
});
