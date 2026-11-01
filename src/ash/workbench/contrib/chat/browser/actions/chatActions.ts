import { IsNativeContext } from '../../../../../platform/contextkey/common/contextkeys.js';
import { BrowserViewCommandId } from '../../../../../platform/browserView/common/browserView.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IPreferencesService } from '../../../../services/preferences/common/preferences.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import {
	AGENT_SESSIONS_PRESENTATION_SETTING,
	AgentSessionsPresentation,
	AgentSessionsPresentationContext,
	OPEN_CHAT_BROWSER_COMMAND_ID,
	OPEN_CHAT_SETTINGS_COMMAND_ID,
	SHOW_CHAT_HISTORY_COMMAND_ID,
} from '../../common/chat.js';
import { Action2, MenuId, MenusRegistry, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IInstantiationService, type ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IMessageHistoryService } from '../../../../../platform/messageHistory/common/messageHistory.js';
import { localize, localize2 } from '../../../../../nls.js';
import { IChatSessionNavigationService } from '../../../../services/chat/common/chatSessionNavigationService.js';
import { AgentSessionsPicker } from '../agentSessions/agentSessionsPicker.js';
import { isHTMLElement } from '../../../../../base/browser/dom.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { ChatAIDisabledSettingId } from '../../../../../platform/chat/common/chatSettings.js';
import { IChatService, type RewriteChatRequestOptions } from '../../../../services/chat/common/chatService.js';

export function registerChatActions(): void {
	registerAction2(class ShowChatHistoryAction extends Action2 {
		constructor() {
			super({
				id: SHOW_CHAT_HISTORY_COMMAND_ID,
				precondition: ChatContextKeys.enabled.isEqualTo(true),
				title: localize2({ bundle: 'ash.sessions', key: 'command.ShowChatHistoryAction' }, 'Show Chat History'),
				tooltip: localize({ bundle: 'ash.sessions', key: 'command.ShowChatHistoryAction' }, 'Show Chat History'),
				icon: Lxicon.history,
				f1: true,
				menu: { id: MenuId.ChatTitle, group: 'navigation', order: 2 },
			});
		}

		override run(accessor: ServicesAccessor, anchor?: unknown): Promise<void> {
			if (accessor.get(IConfigurationService).getValue<boolean>(ChatAIDisabledSettingId)) return Promise.resolve();
			const navigation = accessor.get(IChatSessionNavigationService);
			if (navigation.showConversationHistory) return Promise.resolve(navigation.showConversationHistory());
			return accessor.get(IInstantiationService).createInstance(AgentSessionsPicker, isHTMLElement(anchor) ? anchor : undefined, undefined).pickAgentSession();
		}
	});

	registerAction2(class ResendRequestAction extends Action2 {
		constructor() {
			super({ id: 'workbench.action.chat.resendRequest', title: localize2('chat.edit.command', 'Send Edited Request') });
		}

		override async run(accessor: ServicesAccessor, context: unknown): Promise<void> {
			const invalid = localize('chat.edit.invalid', 'Choose an accepted request and enter a non-empty message before sending.');
			if (!context || typeof context !== 'object') throw new TypeError(invalid);
			const value = context as Record<string, unknown>;
			for (const key of ['sessionId', 'threadId', 'turnId', 'itemId', 'text', 'commandId']) {
				if (typeof value[key] !== 'string' || !(value[key] as string).trim()) throw new TypeError(invalid);
			}
			const options = value as unknown as RewriteChatRequestOptions;
			const navigation = accessor.get(IChatSessionNavigationService);
			const revision = navigation.revision;
			const result = await accessor.get(IChatService).rewriteRequest(options);
			const active = navigation.getActiveConversation();
			if (navigation.revision === revision && active?.sessionId === options.sessionId && active.threadId === options.threadId) {
				await navigation.openConversation(result.sessionId, result.threadId);
			}
		}
	});
	registerAction2(class ClearChatInputHistoryAction extends Action2 {
		constructor() {
			super({ id: 'workbench.action.chat.clearInputHistory', title: localize2('chat.history.clear', 'Chat: Clear Input History'), f1: true });
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			const history = accessor.get(IMessageHistoryService);
			if (!history) throw new Error(localize('chat.history.unavailable', 'Input history is unavailable on this connection.'));
			await history.clear();
		}
	});
	MenusRegistry.appendMenuItem(MenuId.ChatTitle, {
		submenu: MenuId.ChatSessionsLayout,
		title: localize2('chat.sessions.presentation.title', 'Session display'),
		group: 'layout',
		order: 1,
	});

	for (const [presentation, title, id] of [
		[AgentSessionsPresentation.Tabs, localize2('chat.sessions.presentation.tabs', 'Tabs'), 'workbench.action.chat.setAgentSessionsPresentationTabs'],
		[AgentSessionsPresentation.List, localize2('chat.sessions.presentation.list', 'List'), 'workbench.action.chat.setAgentSessionsPresentationList'],
	] as const) {
		registerAction2(class extends Action2 {
			constructor() {
				super({
					id,
					title,
					toggled: AgentSessionsPresentationContext.isEqualTo(presentation),
					menu: { id: MenuId.ChatSessionsLayout, group: 'navigation', order: presentation === AgentSessionsPresentation.Tabs ? 1 : 2 },
					f1: true,
				});
			}
			override async run(accessor: ServicesAccessor): Promise<void> {
				await accessor.get(IConfigurationService).updateValue(AGENT_SESSIONS_PRESENTATION_SETTING, presentation, ConfigurationTarget.USER_LOCAL);
			}
		});
	}

	registerAction2(class OpenChatBrowserAction extends Action2 {
		constructor() {
			super({
				id: OPEN_CHAT_BROWSER_COMMAND_ID,
				title: localize2({ bundle: 'ash.sessions', key: 'command.OpenChatBrowserAction' }, 'Open Browser'),
				icon: Lxicon.global,
				precondition: IsNativeContext.isEqualTo(true),
				menu: {
					id: MenuId.ChatTitle,
					group: '0_browser',
					order: 1,
				},
			});
		}

		override async run(accessor: ServicesAccessor): Promise<void> {
			await accessor.get(ICommandService).executeCommand(BrowserViewCommandId.Open);
		}
	});

	registerAction2(class OpenChatSettingsAction extends Action2 {
		constructor() {
			super({
				id: OPEN_CHAT_SETTINGS_COMMAND_ID,
				title: localize2({ bundle: 'ash.sessions', key: 'command.OpenChatSettingsAction' }, 'Chat Settings'),
				icon: Lxicon.settings,
				menu: {
					id: MenuId.ChatTitle,
					group: 'chatActions',
					order: 4,
				},
			});
		}

		override async run(accessor: ServicesAccessor): Promise<void> {
			await accessor.get(IPreferencesService).openSettings({ section: 'chat-appearance', jsonEditor: false });
		}
	});
}
