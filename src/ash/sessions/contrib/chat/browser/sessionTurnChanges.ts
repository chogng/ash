import { canceled, isCancellationError } from '../../../../base/common/errors.js';
import { URI } from '../../../../base/common/uri.js';
import type { IChatListItem } from '../../../../workbench/contrib/chat/common/model/chatViewModel.js';
import type { ChatTurnChanges, ChatTurnChangeSource, IChatResponseFileChangesService } from '../../../../workbench/contrib/chat/browser/chatResponseFileChangesService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IChatService } from '../../../../workbench/services/chat/common/chatService.js';
import type { ChatWidgetModel } from '../../../browser/chatWidgetModel.js';
import { readCapturedTurnFile } from '../../../browser/turnMultiDiffSource.js';
import { createSessionFileChange } from '../../../services/sessions/common/session.js';
import { ISessionChangesService, type ISessionChangesEditorOptions } from '../../changes/common/sessionChangesService.js';

/** Projects the conversation model's captures into the Session's Changes editor. */
export class SessionsChatResponseFileChangesService implements IChatResponseFileChangesService {
	constructor(
		private readonly model: ChatWidgetModel,
		@ISessionChangesService private readonly changes: ISessionChangesService,
		@INotificationService private readonly notifications: INotificationService,
		@IChatService private readonly chat: IChatService,
	) { }

	getChangesForRequest(request: IChatListItem): ChatTurnChanges | undefined {
		return request.requestSource && this.getChanges(request.requestSource, false);
	}

	getChangesForResponse(source: ChatTurnChangeSource): ChatTurnChanges | undefined {
		return this.getChanges(source, true);
	}

	private getChanges(source: ChatTurnChangeSource, sealedOnly: boolean): ChatTurnChanges | undefined {
		const generation = this.model.composerGeneration;
		if (source.sessionId !== this.model.sessionId || source.threadId !== this.model.threadId) return undefined;
		const captures = this.model.changeSets.filter(summary => summary.turnId === source.turnId
			&& (sealedOnly ? summary.captureState === 'sealed' : summary.captureState !== 'discarded') && summary.statistics.files > 0);
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
			fileDiffs: captures.flatMap(summary => {
				const details = this.model.turnChangeDetails(summary.changeSetId);
				if (!details || sealedOnly && details.summary.revision !== summary.revision) return [];
				return details.files.map(file => ({
					id: JSON.stringify([summary.changeSetId, file.path]),
					path: file.path,
					previousPath: file.previousPath,
					kind: file.kind,
					additions: file.additions,
					deletions: file.deletions,
					preview: sealedOnly && !file.binary ? {
						revision: summary.revision,
						read: async (signal: AbortSignal) => {
							if (!isCurrent()) throw canceled();
							const contents = await readCapturedTurnFile(this.chat, createSessionFileChange(summary, file), signal);
							if (!isCurrent()) throw canceled();
							return { beforeContent: contents.before ?? '', afterContent: contents.after ?? '' };
						},
					} : undefined,
					review: () => {
						if (!isCurrent()) return;
						const currentSummary = this.model.changeSets.find(candidate => candidate.changeSetId === summary.changeSetId);
						const current = this.model.turnChangeDetails(summary.changeSetId);
						const currentFile = current?.files.find(candidate => candidate.path === file.path);
						if (!current || !currentFile || !currentSummary || currentSummary.captureState === 'discarded'
							|| sealedOnly && (currentSummary.captureState !== 'sealed' || current.summary.revision !== summary.revision
								|| currentSummary.revision !== summary.revision)) return;
						const change = createSessionFileChange(current.summary, currentFile);
						return open({
							changesetSelection: { kind: 'id', id: current.summary.changeSetId },
							viewState: { revealData: { resource: { original: change.originalUri, modified: change.modifiedUri } } },
						});
					},
				}));
			}),
		};
	}
}
