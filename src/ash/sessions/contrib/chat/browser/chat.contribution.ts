import { localize } from '../../../../nls.js';
import { ConfigurationScope, Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { NEW_SESSION_WELCOME_MESSAGES_SETTING, NEW_SESSION_WELCOME_NAME_SETTING, NEW_SESSION_WELCOME_PHRASES_SETTING } from '../common/constants.js';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).updateConfigurations({
	remove: [],
	add: [{
		id: 'sessions',
		title: localize('newSession.welcome.settingsTitle', 'New session welcome'),
		scope: ConfigurationScope.APPLICATION,
		properties: {
			[NEW_SESSION_WELCOME_PHRASES_SETTING]: {
				type: 'boolean', default: true,
				description: localize('sessions.chat.experimental.welcomePhrases', 'Show rotating welcome phrases above the new-session input.'),
			},
			[NEW_SESSION_WELCOME_NAME_SETTING]: {
				type: 'string', default: '',
				description: localize('sessions.chat.experimental.welcomeName', 'The name used in welcome phrases. Leave empty to omit the name.'),
			},
			[NEW_SESSION_WELCOME_MESSAGES_SETTING]: {
				type: 'object', default: { mode: 'append', phrases: [] }, additionalProperties: false,
				properties: {
					mode: { type: 'string', enum: ['append', 'replace'] },
					phrases: { type: 'array', items: { type: 'string' } },
				},
				description: localize('sessions.chat.experimental.welcomeMessages', 'Customize welcome phrases. Use mode "append" to add phrases or "replace" to use only your phrases. Use ${name} to position the welcome name.'),
			},
			'accessibility.verbosity.newSessionWelcome': {
				type: 'boolean', default: true,
				description: localize('newSession.welcome.verbosity', 'Announce the welcome phrase once when a new session is shown to a screen reader.'),
			},
		},
	}],
});
