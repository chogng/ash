import { sessionManagementLabel } from '../sessionManagementLabels.js';
import { onUnexpectedError } from '../../../base/common/errors.js';
import { localize, localize2 } from '../../../nls.js';
import { Lxicon } from '../../../base/common/lxicons.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { Action2, MenuId, MenusRegistry, registerAction2 } from '../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, type IQuickPickItem } from '../../../platform/quickinput/common/quickInput.js';
import type { SessionId, ThreadId } from '../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../services/sessions/common/sessionsManagement.js';
import { IViewsService } from '../../../workbench/services/views/common/viewsService.js';
import { CHAT_VIEW_ID, NEW_CHAT_COMMAND_ID, SHOW_CHAT_HISTORY_COMMAND_ID } from '../../../workbench/contrib/chat/common/chat.js';
import { getInProgressSessionDescription } from '../../../workbench/contrib/chat/browser/chatSessions/chatSessionDescription.js';
import { ChatContextKeys } from '../../../workbench/contrib/chat/common/actions/chatContextKeys.js';
import { ChatAIDisabledSettingId } from '../../../platform/chat/common/chatSettings.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';

registerAction2(class NewChatAction extends Action2 {
	constructor() {
		super({
			id: NEW_CHAT_COMMAND_ID,
			precondition: ChatContextKeys.enabled.isEqualTo(true),
			title: localize2({ bundle: 'ash.sessions', key: 'command.NewChatAction' }, 'New Chat'),
			icon: Lxicon.add,
			f1: true,
			menu: {
				id: MenuId.ChatNewMenu,
				group: '1_open',
				order: 1,
				when: ChatContextKeys.enabled.isEqualTo(true),
			},
		});
	}

	override run(accessor: ServicesAccessor): Promise<boolean> {
		if (accessor.get(IConfigurationService).getValue<boolean>(ChatAIDisabledSettingId)) return Promise.resolve(false);
		const sessionService = accessor.get(ISessionsManagementService);
		const viewsService = accessor.get(IViewsService);
		sessionService.createUntitledSession();
		return viewsService.focusView(CHAT_VIEW_ID);
	}
});

MenusRegistry.appendMenuItem(MenuId.ChatTitle, {
	submenu: MenuId.ChatNewMenu,
	title: localize2({ bundle: 'ash.sessions', key: 'command.NewChatAction' }, 'New Chat'),
	isSplitButton: true,
	when: ChatContextKeys.enabled.isEqualTo(true),
	group: 'navigation',
	order: 1,
});

type ChatHistoryQuickPickItem = IQuickPickItem & (
	{ readonly kind: 'draft'; readonly untitledSessionId: string; }
	| { readonly kind: 'thread'; readonly sessionId: SessionId; readonly threadId: ThreadId; }
);

registerAction2(class ShowChatHistoryAction extends Action2 {
	constructor() {
		super({
			id: SHOW_CHAT_HISTORY_COMMAND_ID,
			precondition: ChatContextKeys.enabled.isEqualTo(true),
			title: localize2({ bundle: 'ash.sessions', key: 'command.ShowChatHistoryAction' }, 'Show Chat History'),
			tooltip: localize({ bundle: 'ash.sessions', key: 'command.ShowChatHistoryAction' }, 'Show Chat History'),
			icon: Lxicon.history,
			f1: true,
			menu: {
				id: MenuId.ChatTitle,
				group: 'navigation',
				order: 2,
			},
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		if (accessor.get(IConfigurationService).getValue<boolean>(ChatAIDisabledSettingId)) return Promise.resolve();
		const sessions = accessor.get(ISessionsManagementService);
		const views = accessor.get(IViewsService);
		const quickPick = accessor.get(IQuickInputService).createQuickPick<ChatHistoryQuickPickItem>();
		const disposables = new DisposableStore();
		disposables.add(quickPick);
		quickPick.placeholder = localize('sessions.history.placeholder', 'Select a conversation or draft');
		quickPick.items = [
			...sessions.untitledSessions.map(session => ({
				kind: 'draft' as const,
				untitledSessionId: session.untitledSessionId,
				label: session.title.trim() || localize('chat.title.new', 'New Chat'),
				description: localize('sessions.history.draft', 'Draft'),
			})),
			...sessions.sessions.flatMap((session) => {
				if (session.status !== 'active') return [];
				const threads = session.chats.filter((thread) => thread.status === 'active');
				return threads.map((thread, index) => ({
					kind: 'thread' as const,
					sessionId: session.sessionId,
					threadId: thread.threadId,
					label: session.title.trim() || localize('chat.title.default', 'Chat'),
					description: [threads.length > 1 ? localize('sessions.history.thread', 'Thread {0}', index + 1) : undefined, thread.origin.type !== 'root' && thread.title?.trim() !== session.title.trim() ? thread.title?.trim() : undefined, sessionManagementLabel(thread.management)].filter(Boolean).join(' · ') || undefined,
					detail: getInProgressSessionDescription(thread.management) ?? thread.management?.activity?.text ?? thread.management?.summary ?? undefined,
				}));
			})];
		disposables.add(quickPick.onDidAccept(() => {
			const item = quickPick.selectedItems[0];
			if (!item) return;

			if (item.kind === 'draft') sessions.selectUntitledSession(item.untitledSessionId);
			else sessions.selectThread(item.sessionId, item.threadId);
			quickPick.hide();
			void views.focusView(CHAT_VIEW_ID).catch(onUnexpectedError);

		}));
		const dismissed = new Promise<void>(resolve => {
			disposables.add(quickPick.onDidHide(() => {
				disposables.dispose();
				resolve();
			}));
		});
		quickPick.show();
		return dismissed;
	}
});
