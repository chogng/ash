import { isCancellationError } from '../../../../base/common/errors.js';
import { URI } from '../../../../base/common/uri.js';
import type { IChatListItem } from '../../../../workbench/contrib/chat/common/model/chatViewModel.js';
import type { PromptFileDiff } from '../../../../workbench/contrib/chat/browser/promptTimeline/promptTimelineModel.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import type { ChatWidgetModel } from '../../../browser/chatWidgetModel.js';
import { createSessionFileChange } from '../../../services/sessions/common/session.js';
import { ISessionChangesService } from '../../changes/common/sessionChangesService.js';

/** Projects prompt timeline files into the Session's Changes editor. */
export class SessionsChatResponseFileChangesService {
	constructor(
		private readonly model: ChatWidgetModel,
		@ISessionChangesService private readonly changes: ISessionChangesService,
		@INotificationService private readonly notifications: INotificationService,
	) { }

	getChangesForRequest(request: IChatListItem): readonly PromptFileDiff[] {
		const source = request.requestSource;
		const generation = this.model.composerGeneration;
		if (!source || source.sessionId !== this.model.sessionId || source.threadId !== this.model.threadId) return [];
		return this.model.changeSets.filter(summary => summary.turnId === source.turnId && summary.captureState !== 'discarded')
			.flatMap(summary => this.model.turnChangeDetails(summary.changeSetId)?.files.map(file => ({
				id: JSON.stringify([summary.changeSetId, file.path]),
				path: file.path,
				review: async () => {
					if (this.model.isDisposed || this.model.composerGeneration !== generation || this.model.sessionId !== source.sessionId || this.model.threadId !== source.threadId) return;
					const current = this.model.turnChangeDetails(summary.changeSetId);
					const currentFile = current?.files.find(candidate => candidate.path === file.path);
					if (!current || !currentFile || current.summary.captureState === 'discarded') return;
					const change = createSessionFileChange(current.summary, currentFile);
					const resource = URI.from({ scheme: 'ash-session', path: `/${source.sessionId}`, query: new URLSearchParams({ thread: source.threadId }).toString() });
					try {
						await this.changes.openChangesEditor(resource, {
							changesetSelection: { kind: 'id', id: current.summary.changeSetId },
							viewState: { revealData: { resource: { original: change.originalUri, modified: change.modifiedUri } } },
						});
					} catch (error) {
						if (!this.model.isDisposed && !isCancellationError(error)) this.notifications.error(error instanceof Error ? error : String(error));
					}
				},
			})) ?? []);
	}
}
