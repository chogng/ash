import type { IDisposable } from '../../../../base/common/lifecycle.js';
import type { IObservable } from '../../../../base/common/observable.js';
import type { URI } from '../../../../base/common/uri.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';

export const IInboxNotificationsService = createServiceIdentifier<IInboxNotificationsService>('sessionsInboxNotificationsService');

export const enum InboxTab {
	ReadyForYou = 'readyForYou',
	Working = 'working',
	ReadyToMerge = 'readyToMerge',
	OnHold = 'onHold',
	Done = 'done',
}

export const enum InboxNotificationPriority {
	Now = 0,
	Next = 1,
	Later = 2,
}

export const enum InboxNotificationKind {
	NeedsInput = 'needsInput',
	Completed = 'completed',
	Failed = 'failed',
	FailingCI = 'failingCI',
	PassingCI = 'passingCI',
	ReviewComments = 'reviewComments',
	PullRequestMerged = 'pullRequestMerged',
}

export type InboxPullRequestNotificationKind = InboxNotificationKind.FailingCI | InboxNotificationKind.PassingCI
	| InboxNotificationKind.ReviewComments | InboxNotificationKind.PullRequestMerged;

export function isPullRequestNotificationKind(kind: InboxNotificationKind): kind is InboxPullRequestNotificationKind {
	return kind === InboxNotificationKind.FailingCI || kind === InboxNotificationKind.PassingCI
		|| kind === InboxNotificationKind.ReviewComments || kind === InboxNotificationKind.PullRequestMerged;
}

export const enum InboxNotificationsSortMode {
	Priority = 'priority',
	Recency = 'recency',
}

export const enum InboxNotificationActionKind {
	OpenSession = 'openSession',
	MarkDone = 'markDone',
	Dismiss = 'dismiss',
}

export interface IInboxNotificationAction {
	readonly id: string;
	readonly label: string;
	readonly ariaLabel?: string;
	readonly kind: InboxNotificationActionKind;
	readonly commandId?: string;
	readonly commandArgs?: readonly unknown[];
	readonly primary?: boolean;
}

export interface IInboxNotificationItem {
	readonly id: string;
	readonly kind: InboxNotificationKind;
	readonly priority: InboxNotificationPriority;
	readonly title: string;
	readonly description: string;
	readonly timestamp: number;
	readonly sessionResource?: URI;
	readonly chatResource?: URI;
	readonly actions: readonly IInboxNotificationAction[];
}

export interface IInboxSessionRow extends IInboxNotificationItem {
	readonly tab: InboxTab;
	readonly sessionTitle: string;
	readonly workTitle?: string;
	readonly notifications: readonly IInboxNotificationItem[];
	readonly hasImages: boolean;
	readonly occurrence: string;
}

/** Live attention classification, independent of Inbox workflow choices. */
export interface IInboxSessionAttention {
	readonly tab: InboxTab.ReadyForYou | InboxTab.Working | InboxTab.ReadyToMerge;
	readonly priority: InboxNotificationPriority;
	readonly notificationIds: readonly string[];
	/** Completed before the first sidebar attention subscription, with no actionable notification. */
	readonly isHistoricalCompletion: boolean;
}

export interface IInboxNotificationsService {
	readonly _serviceBrand: undefined;
	readonly notifications: IObservable<readonly IInboxNotificationItem[]>;
	readonly sessionRows: IObservable<readonly IInboxSessionRow[]>;
	readonly sessionAttention: IObservable<ReadonlyMap<string, IInboxSessionAttention>>;
	/** Keeps session attention tracking active until the returned subscription is disposed. */
	acquireSessionAttention(): IDisposable;
	/** Counts each Session with pending notifications once. */
	readonly attentionCount: IObservable<number>;
	readonly dismissedNotifications: IObservable<readonly IInboxNotificationItem[]>;
	readonly sortMode: IObservable<InboxNotificationsSortMode>;
	readonly isLoading: IObservable<boolean>;
	setSessionOnHold(row: IInboxSessionRow, onHold: boolean): void;
	markSessionDone(row: IInboxSessionRow): void;
	dismissNotification(id: string, snapshot?: IInboxNotificationItem): void;
	setSortMode(sortMode: InboxNotificationsSortMode): void;
}

export function compareInboxNotifications(a: IInboxNotificationItem, b: IInboxNotificationItem): number {
	return a.priority - b.priority || b.timestamp - a.timestamp;
}

export function compareInboxNotificationsByRecency(a: IInboxNotificationItem, b: IInboxNotificationItem): number {
	return b.timestamp - a.timestamp || a.priority - b.priority;
}
