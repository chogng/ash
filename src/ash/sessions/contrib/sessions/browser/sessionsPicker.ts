import { localize } from '../../../../nls.js';
import type { IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { sessionManagementLabel } from '../../../browser/sessionManagementLabels.js';
import { getRecencyEntryKey, type SessionRecencyEntry } from '../../../services/sessions/browser/sessionsRecencyHistory.js';
import type { ISession, SessionId, ThreadId } from '../../../services/sessions/common/session.js';

export interface ISessionPickItem extends IQuickPickItem {
	readonly sessionId: SessionId;
	readonly threadId: ThreadId;
}

export function groupSessionsForPicker(sessions: readonly ISession[], history: readonly SessionRecencyEntry[], getLastViewedAt: (entry: SessionRecencyEntry) => number | undefined, active?: SessionRecencyEntry) {
	const visits = new Map(history.map((entry, index) => [getRecencyEntryKey(entry), index]));
	const activeKey = active && getRecencyEntryKey(active);
	const items = sessions.flatMap(session => {
		if (session.status !== 'active') return [];
		const threads = session.chats.filter(thread => thread.status === 'active');
		return threads.map((thread, index) => {
			const management = thread.management ?? (thread.origin.type === 'root' ? session.management : undefined);
			const item: ISessionPickItem = {
				sessionId: session.sessionId,
				threadId: thread.threadId,
				label: session.title.trim() || localize('sessions.list.untitled', 'Untitled Session'),
				description: [
					session.application?.label ?? session.providerLabel,
					threads.length > 1 ? localize('sessions.history.thread', 'Thread {0}', index + 1) : undefined,
					thread.origin.type !== 'root' && thread.title?.trim() !== session.title.trim() ? thread.title?.trim() : undefined,
					sessionManagementLabel(management),
				].filter(Boolean).join(' · ') || undefined,
				detail: management?.activity?.text ?? management?.summary ?? thread.workspace?.root ?? session.workspace?.root ?? undefined,
			};
			const key = getRecencyEntryKey(item);
			const rank = visits.get(key);
			const updatedAt = thread.updatedAt?.getTime();
			const busy = management?.status === 'working' || thread.executionStatus === 'running' || thread.executionStatus === 'queued' || thread.executionStatus === 'waiting';
			let unread = false;
			if (activeKey !== key && !busy && updatedAt !== undefined && Number.isFinite(updatedAt)) {
				const lastViewed = getLastViewedAt(item);
				unread = lastViewed === undefined ? rank === undefined : updatedAt > lastViewed;
			}
			return { item, needsInput: management?.status === 'needsInput', unread, rank: rank ?? Infinity };
		});
	});
	const groups = { needsInput: [] as ISessionPickItem[], unread: [] as ISessionPickItem[], other: [] as ISessionPickItem[] };
	for (const entry of items.sort((left, right) => left.rank - right.rank)) {
		groups[entry.needsInput ? 'needsInput' : entry.unread ? 'unread' : 'other'].push(entry.item);
	}
	return groups;
}
