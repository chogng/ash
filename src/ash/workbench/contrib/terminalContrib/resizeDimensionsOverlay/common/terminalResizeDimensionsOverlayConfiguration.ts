import { localize } from '../../../../../nls.js';
import type { IConfigurationPropertySchema } from '../../../../../platform/configuration/common/configurationRegistry.js';

export const enum TerminalResizeDimensionsOverlaySettingId {
	Enabled = 'terminal.integrated.resizeDimensionsOverlay.enabled',
}

export const terminalResizeDimensionsOverlayConfiguration: Readonly<Record<string, IConfigurationPropertySchema>> = {
	[TerminalResizeDimensionsOverlaySettingId.Enabled]: {
		type: 'boolean',
		default: true,
		get description() {
			return localize('terminal.resizeDimensionsOverlay.enabled', 'Show the terminal column and row counts briefly when its size changes.');
		},
	},
};
