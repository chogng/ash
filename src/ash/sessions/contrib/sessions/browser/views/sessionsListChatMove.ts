import type { ISessionsService } from '../../../../services/sessions/browser/sessionsService.js';
import type { SessionId, ThreadId } from '../../../../services/sessions/common/session.js';
import type { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';

export async function runSessionsListMove(
	view: Pick<ISessionsService, 'activeSelection' | 'navigationRevision' | 'openThread'>,
	sessionId: SessionId,
	threadId: ThreadId,
	destination: SessionId,
	moveChat: NonNullable<ISessionsManagementService['moveChat']>,
): Promise<void> {
	const active = view.activeSelection;
	const follow = active?.kind === 'session' && active.active.session.sessionId === sessionId && active.active.threadId === threadId;
	const revision = view.navigationRevision;
	await moveChat(sessionId, threadId, destination);
	if (follow && revision === view.navigationRevision) await view.openThread(destination, threadId);
}
