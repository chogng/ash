import assert from "node:assert/strict";
import { test } from "mocha";
import { ColorScheme } from "../../../../../platform/theme/common/theme.js";
import { projectExtensionTokenTheme } from "../../common/textMateThemeProjection.js";

test("extension token themes select the active scheme and compile TextMate presentation", () => {
	const catalog = { revision: 1, themes: [{ id: "dark", extensionId: "demo", label: "Dark", uiTheme: "vs-dark", colors: {}, tokenColors: [{ scopes: ["comment", "string.quoted"], settings: { foreground: "#6A9955", fontStyle: "italic bold" } }] }, { id: "light", extensionId: "demo", label: "Light", uiTheme: "vs", colors: {}, tokenColors: [{ scopes: ["comment"], settings: { foreground: "#008000" } }] }] } as const;
	assert.deepEqual(projectExtensionTokenTheme(catalog, ColorScheme.Dark, 3), { revision: 3, rules: [{ selector: "comment", foreground: "#6A9955", fontStyle: ["italic", "bold"] }, { selector: "string.quoted", foreground: "#6A9955", fontStyle: ["italic", "bold"] }] });
	assert.equal(projectExtensionTokenTheme(catalog, ColorScheme.Light, 4).rules[0]?.foreground, "#008000");
	assert.equal(projectExtensionTokenTheme(catalog, ColorScheme.Dark, 5, "light").rules[0]?.foreground, "#008000");
});
