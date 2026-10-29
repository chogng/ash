import { localize } from '../../../../../nls.js';
import type { IConfigurationPropertySchema } from '../../../../../platform/configuration/common/configurationRegistry.js';

export const enum TerminalCommandGuideSettingId {
	ShowCommandGuide = 'terminal.integrated.shellIntegration.showCommandGuide',
}

export const terminalCommandGuideConfiguration: Readonly<Record<string, IConfigurationPropertySchema>> = {
	[TerminalCommandGuideSettingId.ShowCommandGuide]: {
		type: 'boolean',
		default: true,
		restricted: true,
		get description() {
			return localize(
				'terminal.commandGuide.enabled',
				'Show a guide beside a command and its output when hovering over the terminal.',
			);
		},
	},
};
