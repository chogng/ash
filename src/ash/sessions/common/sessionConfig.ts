import { ConfigurationScope, Extensions, type IConfigurationRegistry } from '../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../platform/registry/common/platform.js';
import { SESSIONS_LAYOUT_SCOPE_SETTING, type ChatLayoutMode } from './chatLayout.js';

const registry = Registry.as<IConfigurationRegistry>(Extensions.Configuration);

registry.registerConfiguration<ChatLayoutMode>({
	key: SESSIONS_LAYOUT_SCOPE_SETTING,
	defaultValue: 'session-shared',
	scope: ConfigurationScope.WINDOW,
	schema: { type: 'string', enum: ['session-shared', 'chat-shared', 'chat'] },
	parse(value: unknown): ChatLayoutMode {
		if (value === 'session-shared' || value === 'chat-shared' || value === 'chat') { return value; }
		throw new TypeError(`Unknown Sessions layout scope: ${String(value)}`);
	},
});
