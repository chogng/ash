import assert from "node:assert/strict";
import { test } from "mocha";
import { createColorTheme, darkColorTheme, lightColorTheme } from "../../../../../platform/theme/common/colorTheme.js";
import { terminalTheme } from "../../../../../workbench/contrib/terminal/browser/xterm/xtermTerminal.js";
import { TerminalLocation } from '../../../../../platform/terminal/common/terminal.js';

test("Terminal renderer follows its host background instead of a fixed canvas color", () => {
	assert.equal(terminalTheme(lightColorTheme).background, "#f8f8f8");
	assert.equal(terminalTheme(lightColorTheme).foreground, "#333333");
	assert.equal(terminalTheme(darkColorTheme).background, "#252526");
	assert.equal(terminalTheme(darkColorTheme).foreground, "#d4d4d4");
	assert.equal(terminalTheme(lightColorTheme, TerminalLocation.Editor).background, '#ffffff');
	assert.equal(terminalTheme(darkColorTheme, TerminalLocation.Editor).background, '#1e1e1e');
});

test('Terminal background overrides have priority over distinct panel and editor surfaces', () => {
	const base = { id: 'terminal-host-test', label: 'Terminal host test', colorScheme: lightColorTheme.colorScheme };
	const hosts = { 'panel.background': '#112233', 'editor.background': '#445566' };
	const theme = createColorTheme({ ...base, colorOverrides: hosts });
	assert.equal(terminalTheme(theme, TerminalLocation.Panel).background, '#112233');
	assert.equal(terminalTheme(theme, TerminalLocation.Editor).background, '#445566');
	const overridden = createColorTheme({ ...base, colorOverrides: { ...hosts, 'terminal.background': '#778899' } });
	assert.equal(terminalTheme(overridden, TerminalLocation.Panel).background, '#778899');
	assert.equal(terminalTheme(overridden, TerminalLocation.Editor).background, '#778899');
});
