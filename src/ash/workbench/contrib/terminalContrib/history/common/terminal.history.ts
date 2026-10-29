import { localize } from '../../../../../nls.js';
import type { IConfigurationPropertySchema } from '../../../../../platform/configuration/common/configurationRegistry.js';

export const enum TerminalHistoryCommandId {
	ClearPreviousSessionHistory = 'workbench.action.terminal.clearPreviousSessionHistory',
	RunRecentCommand = 'workbench.action.terminal.runRecentCommand',
	GoToRecentDirectory = 'workbench.action.terminal.goToRecentDirectory',
}

export const enum TerminalHistorySettingId {
	ShellIntegrationCommandHistory = 'terminal.integrated.shellIntegration.history',
}

const settingDescription = () =>
	localize(
		'terminal.history.limitDescription',
		'Controls the number of nonce-verified commands per terminal profile and directories per workspace execution host to keep. Set to 0 to disable both histories.',
	);

/** Merged into the existing integrated terminal configuration registration. */
export const terminalHistoryConfiguration: Readonly<Record<string, IConfigurationPropertySchema>> = {
	[TerminalHistorySettingId.ShellIntegrationCommandHistory]: {
		type: 'integer',
		default: 100,
		minimum: 0,
		maximum: 10000,
		get description() {
			return settingDescription();
		},
		get markdownDescription() {
			return settingDescription();
		},
		ashSetting: {
			valueType: 'number',
			minimum: 0,
			maximum: 10000,
			get title() {
				return localize('terminal.history.limitTitle', 'Terminal command history limit');
			},
			get description() {
				return settingDescription();
			},
		},
	},
};
