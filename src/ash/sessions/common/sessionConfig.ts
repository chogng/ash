import { localize } from '../../nls.js';
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
	setting: {
		included: false,
		valueType: 'select',
		get title() { return localize('sessions.layoutScope.title', 'Layout scope'); },
		get description() { return localize('sessions.layoutScope.description', 'Keep documents per session, per chat with shared visibility, or per chat with its own visibility.'); },
		get options() {
			return [
				{ value: 'session-shared', label: localize('sessions.layoutScope.session', 'Session') },
				{ value: 'chat-shared', label: localize('sessions.layoutScope.sharedChat', 'Chat, shared visibility') },
				{ value: 'chat', label: localize('sessions.layoutScope.chat', 'Chat') },
			] as const;
		}
	},
});

export const BROWSER_FOLLOWS_SESSION_SETTING = 'sessions.browser.followSession';

registry.registerConfiguration<boolean>({
	key: BROWSER_FOLLOWS_SESSION_SETTING,
	defaultValue: false,
	scope: ConfigurationScope.APPLICATION,
	schema: { type: 'boolean' },
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') throw new TypeError('Browser follow session must be a boolean');
		return value;
	},
	setting: {
		included: false,
		valueType: 'boolean',
		get title() { return localize({ bundle: 'ash', key: 'sessions.browser.followSession' }, 'Browser follows session'); },
		get description() { return localize({ bundle: 'ash', key: 'sessions.browser.followSession.description' }, 'Keep separate browser tabs for each conversation in Chat.'); },
	},
});
