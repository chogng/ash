import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ISessionComparisonService, type SessionComparisonService } from '../../../services/sessions/browser/sessionComparisonService.js';
import { ISessionGroupsService } from '../../../services/sessions/browser/sessionGroupsService.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import type { ComparisonThread } from '../../../services/sessions/common/sessionComparison.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';

export const ISessionComparisonViewService = createServiceIdentifier<ISessionComparisonViewService>('sessionComparisonViewService');

export interface ISessionComparisonViewService {
	open(comparisonId: string): Promise<void>;
}

export class SessionComparisonViewService implements ISessionComparisonViewService {
	constructor(
		@ISessionComparisonService private readonly comparisons: SessionComparisonService,
		@ISessionGroupsService private readonly groups: ISessionGroupsService,
		@ISessionsManagementService private readonly management: ISessionsManagementService,
		@ISessionsService private readonly views: ISessionsService,
		@INotificationService private readonly notifications: INotificationService,
	) { }

	async open(comparisonId: string): Promise<void> {
		const group = this.groups.groups.find(group => group.sectionId === comparisonId && group.kind === 'comparison');
		if (!group) return;

		// Groups from before comparison records stored the attempts as ordinary members.
		const attempts: readonly ComparisonThread[] = this.comparisons.get(comparisonId)?.attempts ?? group.sessionIds.flatMap(sessionId => {
			const session = this.management.sessions.find(candidate => candidate.sessionId === sessionId && candidate.status === 'active');
			const thread = session?.chats.find(chat => chat.status === 'active' && chat.origin.type === 'root')
				?? session?.chats.find(chat => chat.status === 'active');
			return thread ? [{ sessionId, threadId: thread.threadId }] : [];
		});
		for (const { sessionId, threadId } of attempts) {
			const session = this.management.sessions.find(candidate => candidate.sessionId === sessionId && candidate.status === 'active');
			if (!session?.chats.some(chat => chat.threadId === threadId && chat.status === 'active')) continue;
			const revision = this.views.navigationRevision;
			try {
				await this.views.openThread(sessionId, threadId, { sideBySide: true });
			} catch (error) {
				this.notifications.error(String(error));
				if (this.views.navigationRevision !== revision + 1) break;
				continue;
			}
			const active = this.views.activeSelection;
			if (active?.kind !== 'session' || active.active.session.sessionId !== sessionId || active.active.threadId !== threadId) break;
		}
	}
}
