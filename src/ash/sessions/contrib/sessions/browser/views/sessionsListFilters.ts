import type { ISessionsListModelService, SessionSortMode } from '../../../../services/sessions/browser/sessionsListModelService.js';
import type { ISession } from '../../../../services/sessions/common/session.js';

/** The selected session stays reachable when its automation visibility changes. */
export function getSessionsListEntries(catalog: readonly ISession[], model: ISessionsListModelService, activeSessionId: string | undefined): readonly ISession[] {
	return catalog.filter(session => session.status === 'active' && (session.sessionId === activeSessionId || model.isSessionListed(session)));
}

export function sessionSortTime(session: ISession, mode: Exclude<SessionSortMode, 'name'>): number {
	if (mode === 'created') {
		return (session.chats.find(chat => chat.origin.type === 'root') ?? session.chats[0])?.createdAt?.getTime() ?? 0;
	}
	return session.chats.reduce((latest, chat) => Math.max(latest, (chat.updatedAt ?? chat.createdAt)?.getTime() ?? 0), 0);
}
