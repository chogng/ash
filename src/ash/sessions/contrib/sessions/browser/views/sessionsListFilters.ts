import type { ISessionsListModelService, SessionSortMode, SessionsListMode } from '../../../../services/sessions/browser/sessionsListModelService.js';
import type { ISession } from '../../../../services/sessions/common/session.js';

/** The selected session stays reachable when its automation visibility changes. */
export function getSessionsListEntries(catalog: readonly ISession[], model: ISessionsListModelService, mode: SessionsListMode, activeSessionId: string | undefined): readonly ISession[] {
	const { field, direction } = model.getSort(mode);
	const sign = direction === 'ascending' ? 1 : -1;
	const visible = catalog.filter(session => session.status === 'active' && (session.sessionId === activeSessionId || model.isSessionListed(session)));
	if (field === 'name') {
		return visible.sort((left, right) => sign * left.title.localeCompare(right.title, undefined, { numeric: true }));
	}
	return visible
		.map(session => ({ session, time: sessionSortTime(session, field) }))
		.sort((left, right) => sign * (left.time - right.time))
		.map(entry => entry.session);
}

function sessionSortTime(session: ISession, mode: Exclude<SessionSortMode, 'name'>): number {
	if (mode === 'created') {
		return (session.chats.find(chat => chat.origin.type === 'root') ?? session.chats[0])?.createdAt?.getTime() ?? 0;
	}
	return session.chats.reduce((latest, chat) => Math.max(latest, (chat.updatedAt ?? chat.createdAt)?.getTime() ?? 0), 0);
}
