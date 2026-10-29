import { localize } from '../../../../../nls.js';
import type { IConfigurationPropertySchema } from '../../../../../platform/configuration/common/configurationRegistry.js';

export const enum TerminalOscNotificationsSettingId {
	EnableNotifications = 'terminal.integrated.enableNotifications',
}

export const terminalOscNotificationsConfiguration: Readonly<Record<string, IConfigurationPropertySchema>> = {
	[TerminalOscNotificationsSettingId.EnableNotifications]: {
		type: 'boolean',
		default: true,
		get description() {
			return localize(
				'terminal.notification.enable',
				'Show notifications sent by terminal processes using OSC 99 in the notification center. Sounds, icons and application filtering are not supported.',
			);
		},
	},
};
