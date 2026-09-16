import { strict as assert } from "node:assert";
import { test } from "mocha";
import { ColorId } from "../../../../../platform/theme/common/colorTheme.js";
import { ColorScheme } from "../../../../../platform/theme/common/theme.js";
import { createExtensionWorkbenchColorTheme, extensionWorkbenchThemeId, parseExtensionTheme } from "../../common/extensionTheme.js";

test("compiles a stable selectable Workbench theme from supported extension colors", () => {
	const id = extensionWorkbenchThemeId("vscode.theme-defaults", "Visual Studio Dark", 0);
	const definition = parseExtensionTheme({
		name: "Dark (Visual Studio)",
		colors: { "editor.background": "#1E1E1E", "unsupported.color": "#ffffff" },
		tokenColors: [],
	}, id, "vscode.theme-defaults", "%darkColorThemeLabel%", "vs-dark", "theme test");

	const theme = createExtensionWorkbenchColorTheme(definition);

	assert.equal(id, "extension-vscode-theme-defaults-visual-studio-dark");
	assert.equal(theme.label, "Dark (Visual Studio)");
	assert.equal(theme.colorScheme, ColorScheme.Dark);
	assert.equal(theme.getColorCss(ColorId.editorBackground), "#1e1e1e");
});

test("rejects selectable extension themes without a supported UI scheme", () => {
	const definition = parseExtensionTheme({ colors: {}, tokenColors: [] }, "extension-ash-demo-one", "ash.demo", "Demo", undefined, "theme test");
	assert.throws(() => createExtensionWorkbenchColorTheme(definition), /uiTheme/);
});

test("rejects invalid token colors and font styles before a theme becomes active", () => {
	assert.throws(() => parseExtensionTheme({ tokenColors: [{ scope: "comment", settings: { foreground: "green" } }] }, "extension-ash-demo-one", "ash.demo", "Demo", "vs-dark", "theme test"), /Invalid color theme/);
	assert.throws(() => parseExtensionTheme({ tokenColors: [{ scope: "comment", settings: { fontStyle: "italic blink" } }] }, "extension-ash-demo-one", "ash.demo", "Demo", "vs-dark", "theme test"), /Invalid color theme/);
});
