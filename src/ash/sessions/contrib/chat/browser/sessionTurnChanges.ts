import { isCancellationError } from '../../../../base/common/errors.js';
import { URI } from '../../../../base/common/uri.js';
import type { IChatListItem } from '../../../../workbench/contrib/chat/common/model/chatViewModel.js';
import type { PromptTurnChanges } from '../../../../workbench/contrib/chat/browser/promptTimeline/promptTimelineModel.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import type { ChatWidgetModel } from '../../../browser/chatWidgetModel.js';
import { createSessionFileChange } from '../../../services/sessions/common/session.js';
import { ISessionChangesService, type ISessionChangesEditorOptions } from '../../changes/common/sessionChangesService.js';

/** Projects prompt timeline captures into the Session's Changes editor. */
export class SessionsChatResponseFileChangesService {
	constructor(
		private readonly model: ChatWidgetModel,
		@ISessionChangesService private readonly changes: ISessionChangesService,
		@INotificationService private readonly notifications: INotificationService,
	) { }

	getChangesForRequest(request: IChatListItem): PromptTurnChanges | undefined {
		const source = request.requestSource;
		const generation = this.model.composerGeneration;
		if (!source || source.sessionId !== this.model.sessionId || source.threadId !== this.model.threadId) return undefined;
		const captures = this.model.changeSets.filter(summary =>
			summary.turnId === source.turnId && summary.captureState !== 'discarded' && summary.statistics.files > 0);
		if (!captures.length) return undefined;

		const isCurrent = () => !this.model.isDisposed && this.model.composerGeneration === generation
			&& this.model.sessionId === source.sessionId && this.model.threadId === source.threadId;
		const open = async (options: ISessionChangesEditorOptions) => {
			const resource = URI.from({ scheme: 'ash-session', path: `/${source.sessionId}`, query: new URLSearchParams({ thread: source.threadId }).toString() });
			try {
				await this.changes.openChangesEditor(resource, options);
			} catch (error) {
				if (isCurrent() && !isCancellationError(error)) this.notifications.error(error instanceof Error ? error : String(error));
			}
		};

		return {
			files: captures.reduce((count, capture) => count + capture.statistics.files, 0),
			insertions: captures.reduce((count, capture) => count + capture.statistics.additions, 0),
			deletions: captures.reduce((count, capture) => count + capture.statistics.deletions, 0),
			review: () => isCurrent() ? open({ changesetSelection: { kind: 'turn', turnId: source.turnId } }) : undefined,
			fileDiffs: captures.flatMap(summary => this.model.turnChangeDetails(summary.changeSetId)?.files.map(file => ({
				id: JSON.stringify([summary.changeSetId, file.path]),
				path: file.path,
				review: () => {
					if (!isCurrent()) return;
					const current = this.model.turnChangeDetails(summary.changeSetId);
					const currentFile = current?.files.find(candidate => candidate.path === file.path);
					if (!current || !currentFile || current.summary.captureState === 'discarded') return;
					const change = createSessionFileChange(current.summary, currentFile);
					return open({
						changesetSelection: { kind: 'id', id: current.summary.changeSetId },
						viewState: { revealData: { resource: { original: change.originalUri, modified: change.modifiedUri } } },
					});
				},
			})) ?? []),
		};
	}
}
