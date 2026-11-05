import { Separator, type IAction } from '../../../../base/common/actions.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { derived, observableFromEvent, observableSignalFromEvent } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import type { ISessionStatusIcon } from '../../../browser/sessionStatusIcon.js';
import { LOCAL_AGENT_HOST_PROVIDER_ID } from '../../../common/agentHostSessionsProvider.js';
import { ISessionsListModelService } from '../../../services/sessions/browser/sessionsListModelService.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { getSessionsListEntries } from '../../sessions/browser/views/sessionsListFilters.js';
import type { ChatListEntry, ChatListSnapshot, ChatListSource } from '../../sessions/browser/views/chatListModel.js';
import { ASH_CHAT_SELECTED_CONTEXT, SHOW_ASH_CHAT_COMMAND } from '../common/constants.js';

/** Projects the local Ash catalog and routes actions to its Session owner. */
export class AshChatNavigationSource implements ChatListSource {
	readonly snapshot;

	constructor(
		@ISessionsManagementService management: ISessionsManagementService,
		@ISessionsService sessions: ISessionsService,
		@ISessionsListModelService list: ISessionsListModelService,
		@IContextKeyService contextKeys: IContextKeyService,
		@ICommandService commands: ICommandService,
		@ILayoutService layout: ILayoutService,
	) {
		const context = new Set([ASH_CHAT_SELECTED_CONTEXT]);
		const active = observableFromEvent(this, listener => contextKeys.onDidChangeContext(event => {
			if (event.affectsSome(context)) listener(event);
		}), () => contextKeys.getValue(ASH_CHAT_SELECTED_CONTEXT) === true);
		const catalog = observableFromEvent(this, management.onDidChange, () => management.sessions);
		const listChanged = observableSignalFromEvent(this, list.onDidChange);
		const working: ISessionStatusIcon = {
			label: localize('sessions.management.working', 'Working'), kind: 'inProgress', icon: Lxicon.sync,
		};
		this.snapshot = derived<ChatListSnapshot>(reader => {
			listChanged.read(reader);
			const selection = sessions.getSelection(reader).activeSelection;
			const selectedId = active.read(reader) && selection?.kind === 'session' ? selection.active.session.sessionId : undefined;
			const rows: ChatListEntry[] = [];
			const entries = getSessionsListEntries(catalog.read(reader), list, selectedId);
			for (const session of entries) {
				// The ambient local provider keeps its raw catalog IDs and omits providerId.
				if (session.providerId && session.providerId !== LOCAL_AGENT_HOST_PROVIDER_ID) continue;
				const chats = session.chats.filter(chat => chat.status === 'active');
				const thread = chats.find(chat => chat.threadId === session.sessionId)
					?? chats.find(chat => chat.origin.type === 'root') ?? chats[0];
				if (!thread) continue;
				const id = session.sessionId;
				const isPinned = list.isSessionPinned(session);
				const action = (id: string, label: string, icon: IAction['icon']): IAction => ({
					id, label, tooltip: label, icon, enabled: true,
					run: () => commands.executeCommand(id, session.sessionId),
				});
				rows.push({
					id: `ash:${id}`,
					title: session.title || localize('sessions.list.untitled', 'Untitled Session'),
					selected: selectedId === id,
					status: session.management?.status === 'working' ? working : undefined,
					defaultIcon: Lxicon.chat,
					iconId: list.getRowIcon(`session:${id}`),
					setIcon: icon => list.setRowIcon(`session:${id}`, icon?.id),
					pinned: isPinned,
					setPinned: pinned => pinned ? list.pinSession(session) : list.unpinSession(session),
					open: async signal => {
						await commands.executeCommand(SHOW_ASH_CHAT_COMMAND);
						if (signal.aborted) return;
						sessions.openSession(id, thread.threadId);
						layout.focus();
					},
					getActions: () => [
						action('agentSession.rename', localize('sessions.list.rename', 'Rename'), Lxicon.edit),
						new Separator(),
						action('agentSession.archive', localize('chatSession.archive', 'Archive'), Lxicon.archive),
						{ ...action('agentSession.delete', localize('sessions.list.delete', 'Delete'), Lxicon.trash), class: 'ash-chat-navigation-delete-action' },
					],
				});
			}
			return { entries: rows };
		});
	}
}
