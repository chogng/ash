import type { IChangesStats } from '../../../browser/changesStatsWidget.js';
import type { IChatListItem } from '../common/model/chatViewModel.js';
import type { TurnChangeFile } from '../../../services/chat/common/chatService.js';
import type { IObservable } from '../../../../base/common/observable.js';
import type { URI } from '../../../../base/common/uri.js';
import type { IEditSessionEntryDiff } from '../common/editing/chatEditingService.js';

/** The session owner supplies authoritative per-request comparisons without owning editor state. */
export interface IChatResponseFileChangesProvider {
	getChangesForRequest(sessionResource: URI, requestId: string): IObservable<readonly IEditSessionEntryDiff[]> | undefined;
}

export type ChatTurnChangeSource = Pick<NonNullable<IChatListItem['feedbackSource']>, 'sessionId' | 'threadId' | 'turnId'>;

export interface ChatTurnFileChange {
	readonly id: string;
	readonly path: string;
	readonly previousPath?: string;
	readonly repositoryLabel?: string;
	readonly kind?: TurnChangeFile['kind'];
	readonly additions: number;
	readonly deletions: number;
	readonly preview?: {
		readonly revision: number;
		read(signal: AbortSignal): Promise<{ readonly beforeContent: string; readonly afterContent: string; }>;
	};
	review(): void | Promise<void>;
}

export interface ChatTurnChanges extends IChangesStats {
	readonly fileDiffs: readonly ChatTurnFileChange[];
	review(): void | Promise<void>;
}

/** A conversation host projects its own captures and owns opening their comparisons. */
export interface ChatResponseFileChangesPresentation {
	getChangesForPrompt(request: IChatListItem): ChatTurnChanges | undefined;
	getChangesForResponse(source: ChatTurnChangeSource): ChatTurnChanges | undefined;
}
