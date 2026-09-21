import { strict as assert } from "node:assert";
import { test } from "mocha";
import {
	ColorId,
	colorCssVariable,
	darkColorTheme,
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

test("built-in themes define every registered color", () => {
	for (const { id } of Colors.getColors()) {
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
	assert.equal(sizeCssVariable('strokeThickness'), '--ash-stroke-thickness');
	assert.equal(colorCssVariable(ColorId.editorFoldBackground), '--ash-editor-fold-background');
	assert.equal(colorCssVariable(ColorId.editorFoldPlaceholderForeground), '--ash-editor-fold-placeholder-foreground');
	assert.equal(colorCssVariable(ColorId.editorGutterFoldingControlForeground), '--ash-editor-gutter-folding-control-foreground');
});
