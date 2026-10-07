import { localize } from '../../nls.js';
import type { IAgentSessionListItem, IAgentSessionsModel } from '../../workbench/contrib/chat/browser/agentSessions/agentSessionsModel.js';
import type { ISessionsManagementService } from '../services/sessions/common/sessionsManagement.js';

/** Exposes the Sessions catalog to the Chat view without moving session ownership into Workbench. */
export function createAgentSessionsModel(sessions: ISessionsManagementService): IAgentSessionsModel {
	return {
		onDidChange: sessions.onDidChange,
		get items() { return sessionItems(sessions); },
		get state() { return sessions.state === 'loading' ? 'loading' : sessions.state === 'error' ? 'error' : 'ready'; },
		get error() { return sessions.error; },
	};
}

function sessionItems(sessions: ISessionsManagementService): readonly IAgentSessionListItem[] {
	const items: IAgentSessionListItem[] = sessions.untitledSessions.map(draft => ({
		id: `draft:${draft.untitledSessionId}`,
		title: draft.title.trim() || localize('chat.sessions.new', 'New Session'),
		description: localize('chat.sessions.draft', 'Draft'),
		kind: 'draft',
		active: sessions.activeUntitledSession?.untitledSessionId === draft.untitledSessionId,
		open: () => sessions.selectUntitledSession(draft.untitledSessionId),
	}));
	for (const session of sessions.sessions) {
		if (session.status !== 'active') continue;
		const selectedThreadId = sessions.active?.session.sessionId === session.sessionId ? sessions.active.threadId : undefined;
		const thread = session.chats.find(chat => chat.threadId === selectedThreadId && chat.status === 'active')
			?? session.chats.find(chat => chat.status === 'active' && chat.origin.type === 'root')
			?? session.chats.find(chat => chat.status === 'active');
		if (!thread) continue;
		items.push({
			id: `session:${session.sessionId}`,
			title: session.title.trim() || localize('chat.sessions.untitled', 'Untitled session'),
			description: session.workspace?.root ?? '',
			kind: 'session',
			active: sessions.activeUntitledSession === undefined && sessions.active?.session.sessionId === session.sessionId,
			open: () => sessions.selectThread(session.sessionId, thread.threadId),
		});
	}
	return items;
}
