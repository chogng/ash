import type { Event } from '../../../../base/common/event.js';
import type { IObservable } from '../../../../base/common/observable.js';
import type { URI } from '../../../../base/common/uri.js';
import type { ISCMRepository } from './scm.js';

/** A history provider cannot serve the current workspace until its repository appears. */
export class SCMHistoryUnavailableError extends Error { }

export interface ISCMHistoryOptions {
	readonly skip?: number;
	readonly limit?: number;
	readonly historyItemRefs?: readonly string[];
}

export interface ISCMHistoryItemRef {
	readonly id: string;
	readonly name: string;
	readonly revision?: string;
	readonly category?: string;
	readonly description?: string;
	readonly color?: number;
	readonly upstream?: string;
	/** The provider excludes the current branch and branches used by other worktrees. */
	readonly canDelete?: boolean;
}

export const SCMIncomingHistoryItemId = 'scm-graph-incoming-changes';
export const SCMOutgoingHistoryItemId = 'scm-graph-outgoing-changes';

export interface ISCMHistoryItem {
	readonly id: string;
	readonly parentIds: readonly string[];
	readonly subject: string;
	readonly message: string;
	readonly displayId?: string;
	readonly timestamp?: number;
	/** Complete tooltip data is prepared with the item; displaying it never starts a read. */
	readonly tooltip?: ISCMHistoryItemDetails;
	readonly references?: readonly ISCMHistoryItemRef[];
	/** A graph summary compares two captured revisions rather than one commit with its parent. */
	readonly comparison?: { readonly revision: string; readonly baseRevision: string; };
	readonly remoteLinks?: readonly { readonly name: string; readonly uri: URI; }[];
}

export interface ISCMHistoryItemDetails {
	readonly authorName: string;
	readonly authorEmail: string;
	readonly timestamp: number;
	readonly message: string;
	readonly statistics: { readonly files: number; readonly additions: number; readonly deletions: number; };
}

export interface ISCMHistoryItemGraphNode {
	readonly id: string;
	readonly color: number;
}

export interface ISCMHistoryItemViewModel {
	readonly historyItem: ISCMHistoryItem;
	readonly inputSwimlanes: readonly ISCMHistoryItemGraphNode[];
	readonly outputSwimlanes: readonly ISCMHistoryItemGraphNode[];
	readonly kind: 'HEAD' | 'node' | 'incoming-changes' | 'outgoing-changes';
}

export interface SCMHistoryItemViewModelTreeElement {
	readonly repository: ISCMRepository;
	readonly historyItemViewModel: ISCMHistoryItemViewModel;
	readonly type: 'historyItemViewModel';
	/** A reference badge may group multiple branches or tags on the same commit. */
	readonly references?: readonly ISCMHistoryItemRef[];
}

export interface ISCMHistoryItemChange {
	readonly uri: URI;
	readonly originalUri?: URI;
	readonly modifiedUri?: URI;
	readonly path: string;
	readonly originalPath?: string;
	readonly status: string;
	/** Immutable base captured when the changed paths were queried. */
	readonly parentId?: string;
}

export interface SCMHistoryItemChangeViewModelTreeElement {
	readonly repository: ISCMRepository;
	readonly historyItemViewModel: ISCMHistoryItemViewModel;
	readonly historyItemChange: ISCMHistoryItemChange;
	readonly graphColumns: readonly ISCMHistoryItemGraphNode[];
	readonly type: 'historyItemChangeViewModel';
}

export type ISCMHistoryItemContent =
	| { readonly kind: 'text'; readonly text: string; }
	| { readonly kind: 'missing'; }
	| { readonly kind: 'binary'; readonly bytes?: Uint8Array; };

export interface ISCMHistoryItemChangeContents {
	readonly parentId: string | undefined;
	readonly original: ISCMHistoryItemContent;
	readonly modified: ISCMHistoryItemContent;
}

/** Repository-owned history capability consumed by the SCM view. */
export interface ISCMHistoryProvider {
	provideHistoryItemRefs?(historyItemRefs?: readonly string[]): Promise<readonly ISCMHistoryItemRef[]>;
	resolveHistoryItemRefsCommonAncestor?(historyItemRefs: readonly string[]): Promise<string | undefined>;

	readonly onDidChange: Event<void>;
	/** Updated decorations for cached items; their identities and commit traversal remain unchanged. */
	readonly onDidChangeHistoryItemRefs?: Event<readonly ISCMHistoryItem[]>;
	readonly historyItemRef: IObservable<ISCMHistoryItemRef | undefined>;
	readonly historyItemRemoteRef?: IObservable<ISCMHistoryItemRef | undefined>;
	readonly historyItemBaseRef?: IObservable<ISCMHistoryItemRef | undefined>;
	refresh(): void;
	provideHistoryItems(options: ISCMHistoryOptions): Promise<readonly ISCMHistoryItem[] | undefined>;
	provideHistoryItemChanges(historyItemId: string, historyItemParentId: string | undefined): Promise<readonly ISCMHistoryItemChange[] | undefined>;
	resolveHistoryItemChangeContents(historyItemId: string, change: ISCMHistoryItemChange): Promise<ISCMHistoryItemChangeContents>;
	resolveHistoryItemChatContext(historyItemId: string): Promise<string | undefined>;
	resolveHistoryItemChangeRangeChatContext(historyItemId: string, historyItemParentId: string, path: string): Promise<string | undefined>;
}

/** Keeps comparison direction and editor identity separate from one commit's own changes. */
export interface ISCMHistoryItemComparison {
	readonly baseId: string;
	readonly label: string;
}
