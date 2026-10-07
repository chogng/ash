import assert from "node:assert/strict";
import { test } from "mocha";
import { darkColorTheme, lightColorTheme } from "../../../../../platform/theme/common/colorTheme.js";
import { terminalTheme } from "../../../../../workbench/contrib/terminal/browser/instance/terminalTheme.js";

test("Terminal renderer uses the active editor background instead of a fixed canvas color", () => {
	assert.equal(terminalTheme(lightColorTheme).background, "#ffffff");
	assert.equal(terminalTheme(lightColorTheme).foreground, "#333333");
	assert.equal(terminalTheme(darkColorTheme).background, "#1e1e1e");
	assert.equal(terminalTheme(darkColorTheme).foreground, "#d4d4d4");
});
