import { Event } from '../../base/common/event.js';
import { Separator, type IAction } from '../../base/common/actions.js';
import type { ICommandService } from '../../platform/commands/common/commands.js';
import type { INotificationService } from '../../platform/notification/common/notification.js';
import { StorageScope, type IStorageService } from '../../platform/storage/common/storage.js';
import type { ISessionGroupsService } from '../services/sessions/browser/sessionGroupsService.js';
import type { SessionsViewSelection } from '../services/sessions/browser/sessionsService.js';
import { localize } from '../../nls.js';
import type { IAgentSessionListItem, IAgentSessionsModel } from '../../workbench/contrib/chat/browser/agentSessions/agentSessionsModel.js';
import type { ISessionsManagementService } from '../services/sessions/common/sessionsManagement.js';
import { getInProgressSessionDescription } from '../../workbench/contrib/chat/browser/chatSessions/chatSessionDescription.js';

/** Exposes the Sessions catalog to the Chat view without moving session ownership into Workbench. */
export function createAgentSessionsModel(
	sessions: ISessionsManagementService,
	storage: IStorageService,
	groups: ISessionGroupsService,
	actions: (selection: SessionsViewSelection) => readonly IAction[],
	onDidOpen?: () => void,
): IAgentSessionsModel {
	return {
		onDidChange: Event.any(sessions.onDidChange, groups.onDidChange, (listener: () => void) =>
			storage.onDidChangeValue(event => {
				if (event.scope === StorageScope.PROFILE && event.key.startsWith('sessions.list.pinned.')) listener();
			}),
		),
		get items() {
			return sessionItems(sessions, storage, groups, actions, onDidOpen);
		},
		get state() {
			return sessions.state === 'loading' ? 'loading' : sessions.state === 'error' ? 'error' : 'ready';
		},
		get error() {
			return sessions.error;
		},
	};
}

function sessionItems(
	sessions: ISessionsManagementService,
	storage: IStorageService,
	groups: ISessionGroupsService,
	actions: (selection: SessionsViewSelection) => readonly IAction[],
	onDidOpen?: () => void,
): readonly IAgentSessionListItem[] {
	const items: IAgentSessionListItem[] = sessions.untitledSessions.map(draft => ({
		id: `draft:${draft.untitledSessionId}`,
		title: draft.title.trim() || localize('chat.sessions.new', 'New Session'),
		description: localize('chat.sessions.draft', 'Draft'),
		kind: 'draft',
		getActions: () => actions({ kind: 'untitled', session: draft }),
		active: sessions.activeUntitledSession?.untitledSessionId === draft.untitledSessionId,
		open: () => {
			sessions.selectUntitledSession(draft.untitledSessionId);
			onDidOpen?.();
		},
	}));
	for (const session of sessions.sessions) {
		if (session.status !== 'active') continue;
		const selectedThreadId = sessions.active?.session.sessionId === session.sessionId ? sessions.active.threadId : undefined;
		const thread =
			session.chats.find(chat => chat.threadId === selectedThreadId && chat.status === 'active') ??
			session.chats.find(chat => chat.status === 'active' && chat.origin.type === 'root') ??
			session.chats.find(chat => chat.status === 'active');
		if (!thread) continue;
		items.push({
			id: `session:${session.sessionId}`,
			title: session.title.trim() || localize('chat.sessions.untitled', 'Untitled session'),
			description: getInProgressSessionDescription(thread.management ?? session.management) ?? session.workspace?.root ?? '',
			kind: 'session',
			pinned: storage.getBoolean(`sessions.list.pinned.${session.sessionId}`, StorageScope.PROFILE, false),
			group: groups.groups.find(group => group.sessionIds.includes(session.sessionId)),
			getActions: () => actions({ kind: 'session', active: { session, threadId: thread.threadId } }),
			active: sessions.activeUntitledSession === undefined && sessions.active?.session.sessionId === session.sessionId,
			open: () => {
				sessions.selectThread(session.sessionId, thread.threadId);
				onDidOpen?.();
			},
		});
	}
	return items;
}

/** Both list hosts invoke the same captured-target commands; only their window owner differs. */
export function createSessionItemActions(
	selection: SessionsViewSelection,
	commands: ICommandService,
	storage: IStorageService,
	notifications: INotificationService,
	openInNewWindow: () => Promise<unknown>,
	didPin?: (sessionId: string) => void,
): readonly IAction[] {
	const id = selection.kind === 'session' ? selection.active.session.sessionId : undefined;
	const target = selection.kind === 'untitled' ? { untitledSessionId: selection.session.untitledSessionId } : id;
	const pinned = id !== undefined && storage.getBoolean(`sessions.list.pinned.${id}`, StorageScope.PROFILE, false);
	const action = (commandId: string, label: string, argument: unknown = target): IAction => ({
		id: commandId,
		label,
		enabled: true,
		tooltip: '',
		run: () => commands.executeCommand(commandId, argument).catch(error => notifications.error(String(error))),
	});
	return [
		{
			...action('sessions.list.togglePin', pinned ? localize('sessions.list.unpin', 'Unpin chat') : localize('sessions.list.pin', 'Pin chat')),
			run: async () => {
				try {
					const id = await commands.executeCommand<string>('sessions.list.togglePin', target);
					didPin?.(id);
				} catch (error) {
					notifications.error(String(error));
				}
			},
		},
		action('agentSession.rename', localize('sessions.list.rename', 'Rename')),
		action('agentSession.archive', localize('chatSession.archive', 'Archive')),
		new Separator(),
		action('agentSession.addToProject', localize('sessions.list.addToProject', 'Add to project')),
		action('agentSession.moveToGroup', localize('sessions.list.moveToGroup', 'Move to group')),
		new Separator(),
		action('agentSession.delete', localize('sessions.list.delete', 'Delete'), id ?? selection),
		new Separator(),
		{
			...action('sessions.openInNewWindow', localize('sessions.list.openWindow', 'Open in new window')),
			run: () => openInNewWindow().catch(error => notifications.error(String(error))),
		},
	];
}
