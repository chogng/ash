import { localize } from '../../../../../nls.js';
import type { IConfigurationPropertySchema } from '../../../../../platform/configuration/common/configurationRegistry.js';

export const enum TerminalZoomCommandId {
	FontZoomIn = 'workbench.action.terminal.fontZoomIn',
	FontZoomOut = 'workbench.action.terminal.fontZoomOut',
	FontZoomReset = 'workbench.action.terminal.fontZoomReset',
}

export const enum TerminalZoomSettingId {
	MouseWheelZoom = 'terminal.integrated.mouseWheelZoom',
}

export const terminalZoomConfiguration: Readonly<Record<string, IConfigurationPropertySchema>> = {
	[TerminalZoomSettingId.MouseWheelZoom]: {
		type: 'boolean',
		default: false,
		get description() {
			return localize(
				'terminal.zoom.mouseWheelZoom',
				'Change the terminal font size with the mouse wheel while holding Ctrl, or Command on macOS. Pinch gestures also zoom on macOS.',
			);
		},
	},
};
