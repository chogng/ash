import { canceled, isCancellationError } from '../../../../base/common/errors.js';
import { URI } from '../../../../base/common/uri.js';
import { observableFromEvent, type IObservable } from '../../../../base/common/observable.js';
import type { IChatListItem } from '../../../../workbench/contrib/chat/common/model/chatViewModel.js';
import { LocalChatSessionUri } from '../../../../workbench/contrib/chat/common/model/chatUri.js';
import type { IEditSessionEntryDiff } from '../../../../workbench/contrib/chat/common/editing/chatEditingService.js';
import type { ChatTurnChanges, ChatTurnChangeSource, ChatTurnFileChange, ChatResponseFileChangesPresentation, IChatResponseFileChangesProvider } from '../../../../workbench/contrib/chat/browser/chatResponseFileChangesService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IChatService } from '../../../../workbench/services/chat/common/chatService.js';
import type { ChatWidgetModel } from '../../../browser/chatWidgetModel.js';
import { readCapturedTurnFile } from '../../../browser/turnMultiDiffSource.js';
import { createSessionFileChange } from '../../../services/sessions/common/session.js';
import { ISessionChangesService, type ISessionChangesEditorOptions } from '../../changes/common/sessionChangesService.js';

interface CapturedFileDiff extends IEditSessionEntryDiff {
	readonly presentation: ChatTurnFileChange;
}

/** Borrows one conversation model; the backend remains the owner of its captures. */
export class SessionsChatResponseFileChangesProvider implements IChatResponseFileChangesProvider, ChatResponseFileChangesPresentation {
	constructor(
		private readonly model: ChatWidgetModel,
		@ISessionChangesService private readonly changes: ISessionChangesService,
		@INotificationService private readonly notifications: INotificationService,
		@IChatService private readonly chat: IChatService,
	) { }

	getChangesForRequest(sessionResource: URI, requestId: string): IObservable<readonly CapturedFileDiff[]> | undefined {
		const owner = LocalChatSessionUri.parse(sessionResource);
		if (!owner || this.model.isDisposed || owner.sessionId !== this.model.sessionId || owner.threadId !== this.model.threadId
			|| !this.model.changeSets.some(capture => capture.turnId === requestId && capture.captureState !== 'discarded')) return undefined;
		const source = { ...owner, turnId: requestId };
		const generation = this.model.composerGeneration;
		return observableFromEvent(this, this.model.onDidChange, () => {
			if (this.model.isDisposed || this.model.composerGeneration !== generation) return [];
			return this.readChanges(source, false)?.files ?? [];
		});
	}

	getChangesForPrompt(request: IChatListItem): ChatTurnChanges | undefined {
		return request.requestSource && this.getChanges(request.requestSource, false);
	}

	getChangesForResponse(source: ChatTurnChangeSource): ChatTurnChanges | undefined {
		return this.getChanges(source, true);
	}

	private getChanges(source: ChatTurnChangeSource, sealedOnly: boolean): ChatTurnChanges | undefined {
		const changes = this.readChanges(source, sealedOnly);
		if (!changes) return undefined;
		const resource = LocalChatSessionUri.forSession(source.sessionId, source.threadId);
		const diffs = this.getChangesForRequest(resource, source.turnId)?.get() ?? [];
		return {
			...changes.statistics,
			review: changes.review,
			fileDiffs: diffs.filter(diff => !sealedOnly || diff.isFinal).map(diff => diff.presentation),
		};
	}

	private readChanges(source: ChatTurnChangeSource, sealedOnly: boolean) {
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
			statistics: {
				files: captures.reduce((count, capture) => count + capture.statistics.files, 0),
				insertions: captures.reduce((count, capture) => count + capture.statistics.additions, 0),
				deletions: captures.reduce((count, capture) => count + capture.statistics.deletions, 0),
			},
			review: () => isCurrent() ? open({ changesetSelection: { kind: 'turn', turnId: source.turnId } }) : undefined,
			files: captures.flatMap((summary): CapturedFileDiff[] => {
				const details = this.model.turnChangeDetails(summary.changeSetId);
				if (!details || details.summary.revision !== summary.revision) return [];
				return details.files.map(file => {
					const change = createSessionFileChange(summary, file);
					return {
						originalURI: change.originalUri,
						modifiedURI: change.uri,
						modifiedSnapshotURI: change.modifiedUri,
						isCreated: file.kind === 'added',
						isDeleted: file.kind === 'deleted',
						added: file.additions,
						removed: file.deletions,
						quitEarly: false,
						identical: false,
						isFinal: summary.captureState === 'sealed',
						isBusy: summary.captureState === 'open',
						presentation: {
							id: JSON.stringify([summary.changeSetId, file.path]),
							path: file.path,
							previousPath: file.previousPath,
							kind: file.kind,
							additions: file.additions,
							deletions: file.deletions,
							preview: summary.captureState === 'sealed' && !file.binary ? {
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
									|| summary.captureState === 'sealed' && (currentSummary.captureState !== 'sealed' || current.summary.revision !== summary.revision
										|| currentSummary.revision !== summary.revision)) return;
								const change = createSessionFileChange(current.summary, currentFile);
								return open({
									changesetSelection: { kind: 'id', id: current.summary.changeSetId },
									viewState: { revealData: { resource: { original: change.originalUri, modified: change.modifiedUri } } },
								});
							},
						},
					};
				});
			}),
		};
	}
}
