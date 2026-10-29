import { localize } from '../../../../../nls.js';
import type { IConfigurationPropertySchema } from '../../../../../platform/configuration/common/configurationRegistry.js';

export const enum TerminalStickyScrollSettingId {
	Enabled = 'terminal.integrated.stickyScroll.enabled',
	MaxLineCount = 'terminal.integrated.stickyScroll.maxLineCount',
	IgnoredCommands = 'terminal.integrated.stickyScroll.ignoredCommands',
}

export const terminalStickyScrollConfiguration: Readonly<Record<string, IConfigurationPropertySchema>> = {
	[TerminalStickyScrollSettingId.Enabled]: {
		type: 'boolean', default: true,
		get description() { return localize('terminal.stickyScroll.enabled', 'Keep the current command at the top of the terminal while scrolling its output. Requires shell integration.'); },
	},
	[TerminalStickyScrollSettingId.MaxLineCount]: {
		type: 'integer', default: 5, minimum: 1, maximum: 10,
		get description() { return localize('terminal.stickyScroll.maxLineCount', 'Maximum command lines to keep at the top of the terminal, limited to 40% of its visible rows.'); },
	},
	[TerminalStickyScrollSettingId.IgnoredCommands]: {
		type: 'array', items: { type: 'string' },
		default: ['clear', 'cls', 'clear-host', 'agent', 'agy', 'copilot', 'claude', 'codex', 'gemini'],
		get description() { return localize('terminal.stickyScroll.ignoredCommands', 'Commands whose output should not show a sticky command header.'); },
	},
};
