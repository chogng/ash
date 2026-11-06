import { Separator, type IAction } from '../../../../base/common/actions.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { derived, observableFromEvent, observableSignalFromEvent } from '../../../../base/common/observable.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import type { ISessionStatusIcon } from '../../../browser/sessionStatusIcon.js';
import { ISessionGroupsService } from '../../../services/sessions/browser/sessionGroupsService.js';
import { ISessionsListModelService } from '../../../services/sessions/browser/sessionsListModelService.js';
import type { ChatListEntry, ChatListSnapshot, ChatListSource } from './chatListModel.js';
import { ASH_CHAT_SELECTED_CONTEXT, SHOW_ASH_CHAT_COMMAND } from '../common/constants.js';
import { IAshChatSelectionService } from './ashChatSelectionService.js';
import { IAshChatSessionService } from './ashChatSessionService.js';
import { ISessionsSearchService } from '../../search/browser/searchService.js';
import type { SearchResult } from '../../search/browser/searchModel.js';

/** Projects native Chat conversations into the shared sidebar. */
export class AshChatNavigationSource extends Disposable implements ChatListSource {
	readonly snapshot;

	constructor(
		@IAshChatSessionService sessions: IAshChatSessionService,
		@IAshChatSelectionService selection: IAshChatSelectionService,
		@ISessionsListModelService list: ISessionsListModelService,
		@ISessionGroupsService groups: ISessionGroupsService,
		@ICommandService commands: ICommandService,
		@IContextKeyService contextKeys: IContextKeyService,
		@ISessionsSearchService search: ISessionsSearchService,
	) {
		super();
		const context = new Set([ASH_CHAT_SELECTED_CONTEXT]);
		const visible = observableFromEvent(this, listener => contextKeys.onDidChangeContext(event => {
			if (event.affectsSome(context)) listener(event);
		}), () => contextKeys.getValue(ASH_CHAT_SELECTED_CONTEXT) === true);
		sessions.initializeCatalog();
		const listChanged = observableSignalFromEvent(this, list.onDidChange);
		const groupsChanged = observableSignalFromEvent(this, groups.onDidChange);
		const working: ISessionStatusIcon = {
			label: localize('sessions.management.working', 'Working'), kind: 'inProgress', icon: Lxicon.sync,
		};
		this.snapshot = derived<ChatListSnapshot>(reader => {
			listChanged.read(reader);
			groupsChanged.read(reader);
			const active = selection.selection.read(reader);
			const selectedId = visible.read(reader) && active.kind === 'thread' ? active.sessionId : undefined;
			const rows: ChatListEntry[] = [];
			for (const session of sessions.catalog.read(reader)) {
				if (session.status !== 'active' || session.sessionId !== selectedId && !list.isSessionListed(session)) continue;
				const chats = session.threads.filter(chat => chat.status === 'active');
				const thread = chats.find(chat => chat.threadId === session.sessionId)
					?? chats.find(chat => !chat.parentThreadId && !chat.forkedFromId) ?? chats[0];
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
					sessionId: id,
					createdAt: thread.createdAtUnixMs,
					updatedAt: thread.lastActivityAtUnixMs ?? thread.createdAtUnixMs,
					selected: selectedId === id,
					status: session.manager.status === 'working' ? working : undefined,
					defaultIcon: Lxicon.chatSession,
					iconId: list.getRowIcon(`session:${id}`),
					setIcon: icon => list.setRowIcon(`session:${id}`, icon?.id),
					pinned: isPinned,
					setPinned: pinned => pinned ? list.pinSession(session) : list.unpinSession(session),
					moveToGroup: group => groups.move(id, group),
					open: async signal => {
						await commands.executeCommand(SHOW_ASH_CHAT_COMMAND);
						if (signal.aborted) return;
						const current = selection.selection.get();
						if (current.kind !== 'thread' || current.sessionId !== id || current.threadId !== thread.threadId) {
							selection.select({ kind: 'thread', sessionId: id, threadId: thread.threadId });
						}
					},
					getActions: () => [
						action('agentSession.rename', localize('sessions.list.rename', 'Rename'), Lxicon.edit),
						action('agentSession.moveToGroup', localize('sessions.list.moveToGroup', 'Move to group'), Lxicon.folders),
						new Separator(),
						action('agentSession.archive', localize('chatSession.archive', 'Archive'), Lxicon.archive),
						{ ...action('agentSession.delete', localize('sessions.list.delete', 'Delete'), Lxicon.trash), class: 'ash-chat-navigation-delete-action' },
					],
				});
			}
			return { entries: rows, groups: groups.groups.filter(group => group.kind !== 'comparison') };
		});
		this._register(search.registerSource(this.snapshot.map(snapshot => snapshot.entries.map(entry => ({
			id: entry.id, category: 'sessions', title: entry.title, icon: entry.defaultIcon,
			target: { kind: 'contributed', open: () => entry.open(new AbortController().signal) },
		} satisfies SearchResult)))));
	}
}
