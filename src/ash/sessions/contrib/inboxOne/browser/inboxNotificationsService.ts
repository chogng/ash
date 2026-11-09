import { addDisposableListener, getWindow } from '../../../../base/browser/dom.js';
import { equals } from '../../../../base/common/arrays.js';
import { combinedDisposable, Disposable, MutableDisposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, derived, observableFromEvent, observableSignalFromEvent, observableValue, type IObservable } from '../../../../base/common/observable.js';
import type { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { compareInboxNotifications, compareInboxNotificationsByRecency, InboxNotificationActionKind, InboxNotificationKind, InboxNotificationPriority, InboxNotificationsSortMode, InboxTab, isPullRequestNotificationKind, type IInboxNotificationAction, type IInboxNotificationItem, type IInboxNotificationsService, type IInboxSessionAttention, type IInboxSessionRow, type InboxPullRequestNotificationKind } from '../../../../workbench/contrib/sessions/common/inboxNotificationsService.js';
import { sessionResource } from '../../../browser/chatHistoryModel.js';
import { sessionManagementLabel } from '../../../browser/sessionManagementLabels.js';
import { IAgentWorkbenchLayoutService } from '../../../browser/workbench.js';
import { SessionsWorkspaceModeContext } from '../../../common/contextkeys.js';
import { linkKey } from '../../../common/sessionLinks.js';
import type { SessionRecencyEntry } from '../../../services/sessions/browser/sessionsRecencyHistory.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { IChatListCatalog } from '../../chat/browser/chatListModel.js';
import { IGitHubService } from '../../github/browser/githubService.js';
import type { IResolvedSessionPullRequest } from '../../github/common/types.js';

const dismissedKey = 'sessions.inboxNotifications.dismissedIds';
const dismissedLimit = 1000;
const workflowKey = 'sessions.inboxNotifications.workflow';
const attentionStartTimeKey = 'sessions.inboxNotifications.attentionStartTime';

type InboxMode = 'chat' | 'code';
type InboxWorkflow = { readonly hold?: true; readonly done?: string; };

function isSessionOwned(request: IResolvedSessionPullRequest): boolean {
	return !request.recordedReference || request.recordedReference.isArtifact === true;
}

const priorities = {
	[InboxNotificationKind.NeedsInput]: InboxNotificationPriority.Now,
	[InboxNotificationKind.Failed]: InboxNotificationPriority.Next,
	[InboxNotificationKind.Completed]: InboxNotificationPriority.Later,
	[InboxNotificationKind.FailingCI]: InboxNotificationPriority.Now,
	[InboxNotificationKind.PassingCI]: InboxNotificationPriority.Next,
	[InboxNotificationKind.ReviewComments]: InboxNotificationPriority.Now,
	[InboxNotificationKind.PullRequestMerged]: InboxNotificationPriority.Next,
};

const descriptions = {
	[InboxNotificationKind.NeedsInput]: localize({ bundle: 'ash.sessions', key: 'sessions.inbox.needsInput' }, 'Needs your input'),
	[InboxNotificationKind.Failed]: localize({ bundle: 'ash.sessions', key: 'sessions.inbox.failed' }, 'Failed'),
	[InboxNotificationKind.Completed]: localize({ bundle: 'ash.sessions', key: 'sessions.inbox.unread' }, 'Unread reply'),
	[InboxNotificationKind.FailingCI]: localize({ bundle: 'ash.sessions', key: 'sessions.inbox.failingCI' }, 'CI checks failed'),
	[InboxNotificationKind.PassingCI]: localize({ bundle: 'ash.sessions', key: 'sessions.inbox.readyToMerge' }, 'Ready to merge'),
	[InboxNotificationKind.ReviewComments]: localize({ bundle: 'ash.sessions', key: 'sessions.inbox.reviewComments' }, 'Unresolved Copilot comments'),
	[InboxNotificationKind.PullRequestMerged]: localize({ bundle: 'ash.sessions', key: 'sessions.inbox.pullRequestMerged' }, 'Pull request merged'),
};

const actions: readonly IInboxNotificationAction[] = [{
	id: 'openSession',
	kind: InboxNotificationActionKind.OpenSession,
	label: localize({ bundle: 'ash.sessions', key: 'sessions.inbox.openConversation' }, 'Open Conversation'),
	primary: true,
}, {
	id: 'dismiss',
	kind: InboxNotificationActionKind.Dismiss,
	label: localize({ bundle: 'ash.sessions', key: 'sessions.inbox.dismiss' }, 'Dismiss Notification'),
}];
const markDoneAction: IInboxNotificationAction = {
	id: 'markDone',
	kind: InboxNotificationActionKind.MarkDone,
	label: localize({ bundle: 'ash.sessions', key: 'sessions.inbox.markDone' }, 'Mark Session Done'),
};

/** Projects Thread read state and GitHub associations into the window's Inbox. */
export class InboxNotificationsService extends Disposable implements IInboxNotificationsService {
	declare readonly _serviceBrand: undefined;

	private readonly mode: IObservable<InboxMode>;
	private readonly dismissedIds: IObservable<ReadonlySet<string>>;
	private readonly workflow: IObservable<ReadonlyMap<string, InboxWorkflow>>;
	private readonly dismissedSnapshots = observableValue<ReadonlyMap<string, { readonly item: IInboxNotificationItem; readonly mode: InboxMode; }>>(this, new Map());
	private readonly sort = observableValue<InboxNotificationsSortMode>(this, InboxNotificationsSortMode.Priority);
	private readonly attentionConsumers = observableValue(this, 0);
	readonly notifications: IObservable<readonly IInboxNotificationItem[]>;
	readonly sessionRows: IObservable<readonly IInboxSessionRow[]>;
	readonly sessionAttention: IObservable<ReadonlyMap<string, IInboxSessionAttention>>;
	readonly attentionCount: IObservable<number>;
	readonly dismissedNotifications: IObservable<readonly IInboxNotificationItem[]>;
	readonly sortMode: IObservable<InboxNotificationsSortMode> = this.sort;
	readonly isLoading: IObservable<boolean>;

	constructor(
		@IAgentWorkbenchLayoutService layout: IAgentWorkbenchLayoutService,
		@ISessionsManagementService catalog: ISessionsManagementService,
		@ISessionsService sessions: ISessionsService,
		@IChatListCatalog chatCatalog: IChatListCatalog,
		@IContextKeyService contextKeys: IContextKeyService,
		@IStorageService private readonly storage: IStorageService,
		@IGitHubService github: IGitHubService,
	) {
		super();
		const document = layout.mainContainer.ownerDocument;
		const window = getWindow(document);
		const codeVisible = observableFromEvent(this, layout.onDidChangePartVisibility, () => layout.isPartVisible('sessions'));
		const sidebarVisible = observableFromEvent(this, layout.onDidChangePartVisibility, () => layout.isPartVisible('sidebar'));
		const modeKey = new Set([SessionsWorkspaceModeContext.key]);
		const mode = this.mode = observableFromEvent(this, listener => contextKeys.onDidChangeContext(event => {
			if (event.affectsSome(modeKey)) listener(event);
		}), () => contextKeys.getValue<InboxMode>(SessionsWorkspaceModeContext.key) ?? 'chat');
		const focused = observableFromEvent(this, listener => combinedDisposable(
			addDisposableListener(window, 'focus', listener),
			addDisposableListener(window, 'blur', listener),
			addDisposableListener(document, 'visibilitychange', listener),
		), () => !document.hidden && document.hasFocus());
		const changed = observableSignalFromEvent(this, sessions.onDidChange);
		const live = observableValue(this, true);
		const presenting = derived(reader => live.read(reader) && sidebarVisible.read(reader));
		const tracking = derived(reader => live.read(reader) && (presenting.read(reader) || this.attentionConsumers.read(reader) > 0));
		const chatEntries = derived(reader => mode.read(reader) === 'chat'
			? chatCatalog.sources.flatMap(source => source.snapshot.read(reader).entries).filter(entry => entry.sessionId !== undefined)
			: []);
		const foreground = derived<SessionRecencyEntry | undefined>(reader => {
			if (!focused.read(reader)) return;
			if (mode.read(reader) === 'code') {
				if (!codeVisible.read(reader)) return;
				const selection = sessions.getSelection(reader).activeSelection;
				if (selection?.kind === 'session') return { sessionId: selection.active.session.sessionId, threadId: selection.active.threadId };
			} else {
				const selected = chatEntries.read(reader).find(entry => entry.selectedThreadId !== undefined);
				if (selected?.sessionId && selected.selectedThreadId) return { sessionId: selected.sessionId, threadId: selected.selectedThreadId };
			}
		});
		this._register(autorun(reader => {
			if (!presenting.read(reader)) return;
			changed.read(reader);
			const entry = foreground.read(reader);
			if (entry) sessions.markVisibleThreadViewed(entry);
		}));
		const visibleSessions = derived(reader => {
			changed.read(reader);
			const workspace = mode.read(reader);
			const chatSessions = new Set(chatEntries.read(reader).map(entry => entry.sessionId));
			return catalog.sessions.filter(session => session.kind === workspace && session.status === 'active'
				&& (workspace === 'code' || chatSessions.has(session.sessionId)));
		});
		const githubChanged = observableSignalFromEvent(this, github.onDidChange);
		const prWatch = this._register(new MutableDisposable<IDisposable>());
		let watched: string[] = [];
		this._register(autorun(reader => {
			const ids = tracking.read(reader) ? visibleSessions.read(reader).map(session => session.sessionId).sort() : [];
			if (equals(watched, ids)) return;
			watched = ids;
			prWatch.value = ids.length ? github.watchSessionPullRequests(ids) : undefined;
		}));
		const threadNotifications = derived(reader => {
			const active = foreground.read(reader);
			const items: IInboxNotificationItem[] = [];
			for (const session of visibleSessions.read(reader)) {
				const threads = session.chats.filter(thread => thread.status === 'active' && thread.origin.type !== 'agentSpawn');
				let resource: URI | undefined;
				for (const thread of threads) {
					const entry = { sessionId: session.sessionId, threadId: thread.threadId };
					// Aggregate status cannot identify which of several conversations needs attention.
					const management = thread.management ?? (threads.length === 1 ? session.management : undefined);
					const activity = management?.status;
					const terminal = activity === 'completed' || activity === 'readyForReview' || activity === 'failed';
					const timestamp = management && (terminal || activity === 'needsInput') ? management.statusChangedAtUnixMs : thread.updatedAt?.getTime() ?? 0;
					const seen = active?.sessionId === entry.sessionId && active.threadId === entry.threadId
						|| timestamp <= (sessions.getLastViewedAt(entry, reader) ?? 0);
					const execution = thread.executionStatus;
					const busy = activity === 'working' || execution === 'queued' || execution === 'running' || execution === 'waiting';
					let kind: InboxNotificationKind;
					if (activity === 'needsInput') kind = InboxNotificationKind.NeedsInput;
					else if (seen || busy) continue;
					else if (activity === 'failed' || execution === 'failed') kind = InboxNotificationKind.Failed;
					else if (activity === 'completed' || activity === 'readyForReview' || execution === 'completed') kind = InboxNotificationKind.Completed;
					else continue;
					const chatResource = sessionResource('thread', entry.sessionId, entry.threadId);
					items.push({
						// A later reply or input request is a separate occurrence of attention.
						id: JSON.stringify([chatResource.toString(), kind, timestamp]),
						kind,
						priority: priorities[kind],
						title: thread.title?.trim() || session.title.trim() || localize('sessions.list.untitled', 'Untitled Session'),
						description: descriptions[kind],
						timestamp,
						sessionResource: resource ??= sessionResource('session', session.sessionId),
						chatResource,
						actions,
					});
				}
			}
			return items;
		});
		this.dismissedIds = observableFromEvent(this, listener => storage.onDidChangeValue(event => {
			if (event.scope === StorageScope.APPLICATION && event.key === dismissedKey) listener(event);
		}), () => this.readDismissedIds());
		const comparator = derived(reader => this.sortMode.read(reader) === InboxNotificationsSortMode.Recency
			? compareInboxNotificationsByRecency
			: compareInboxNotifications);
		this.notifications = derived(reader => {
			if (!presenting.read(reader)) return [];
			return sessionEntries.read(reader).flatMap(entry => entry.notifications).sort(comparator.read(reader));
		});
		this.workflow = observableFromEvent(this, listener => storage.onDidChangeValue(event => {
			if (event.scope === StorageScope.APPLICATION && event.key === workflowKey) listener(event);
		}), () => this.readWorkflow());
		const sessionEntries = derived(reader => {
			githubChanged.read(reader);
			const grouped = new Map<string, IInboxNotificationItem[]>();
			for (const item of threadNotifications.read(reader)) {
				const key = item.sessionResource?.toString();
				if (!key) continue;
				const group = grouped.get(key);
				if (group) group.push(item);
				else grouped.set(key, [item]);
			}
			const dismissed = this.dismissedIds.read(reader);
			const entries = visibleSessions.read(reader).flatMap(session => {
				const resource = sessionResource('session', session.sessionId);
				const threads = session.chats.filter(thread => thread.status === 'active' && thread.origin.type !== 'agentSpawn');
				const root = threads.find(thread => thread.origin.type === 'root') ?? threads[0];
				if (!root) return [];
				const working = session.management?.status === 'working' || threads.some(thread => thread.management?.status === 'working'
					|| thread.executionStatus === 'queued' || thread.executionStatus === 'running' || thread.executionStatus === 'waiting');
				const updatedAt = Math.max(...threads.map(thread => thread.updatedAt?.getTime() ?? thread.management?.statusChangedAtUnixMs ?? 0));
				return [{ session, resource, threads, root, working, updatedAt, requests: github.getSessionPullRequests(session.sessionId) }];
			});
			const attribution = new Map<string, { readonly sessionId: string; readonly owned: boolean; readonly updatedAt: number; }>();
			for (const { session, working, updatedAt, requests } of entries) {
				if (working) continue;
				for (const request of requests) {
					const key = linkKey(request.uri.toString());
					const owned = isSessionOwned(request);
					const current = attribution.get(key);
					// Prefer the originating Session when other Sessions reference the same PR.
					if (!current || (owned && !current.owned) || (owned === current.owned
						&& (updatedAt > current.updatedAt || (updatedAt === current.updatedAt && session.sessionId < current.sessionId)))) {
						attribution.set(key, { sessionId: session.sessionId, owned, updatedAt });
					}
				}
			}
			return entries.map(({ session, resource, threads, root, working, updatedAt, requests }) => {
				const threadItems = grouped.get(resource.toString()) ?? [];
				const attributed = (request: IResolvedSessionPullRequest) => attribution.get(linkKey(request.uri.toString()))?.sessionId === session.sessionId;
				const candidates = new Map<InboxPullRequestNotificationKind, Map<string, { revision: string | number; timestamp: number | undefined; }>>();
				const add = (kind: InboxPullRequestNotificationKind, request: IResolvedSessionPullRequest, revision: string | number, timestamp: number | undefined): void => {
					let group = candidates.get(kind);
					if (!group) candidates.set(kind, group = new Map());
					group.set(linkKey(request.uri.toString()), { revision, timestamp });
				};
				const openOwned = requests.filter(request => isSessionOwned(request) && request.state !== 'closed' && request.state !== 'merged');
				let mergeConflict = false;
				for (const request of requests) {
					// A merged PR leaves each owning Session with its own cleanup notification.
					if (!working && request.state === 'merged' && isSessionOwned(request)) {
						add(InboxNotificationKind.PullRequestMerged, request, request.mergedAt ?? 'merged', request.mergedAt ?? updatedAt);
					}
					if (!attributed(request) || (request.state !== 'open' && request.state !== 'draft')) continue;
					mergeConflict ||= request.status.hasMergeConflicts === true;
					if (request.status.hasFailingChecks) add(InboxNotificationKind.FailingCI, request, request.headCommit ?? 'head', request.latestCheckAtUnixMs);
					if (request.copilotReview) {
						add(InboxNotificationKind.ReviewComments, request, request.copilotReview.revision, request.copilotReview.timestamp ?? updatedAt);
					}
				}
				if (!working && !mergeConflict && openOwned.length && openOwned.every(request => request.state === 'open'
					&& request.checksPassed && request.headCommit && attributed(request))) {
					for (const request of openOwned) add(InboxNotificationKind.PassingCI, request, request.headCommit!, request.latestCheckAtUnixMs);
				}
				const chatResource = sessionResource('thread', session.sessionId, root.threadId);
				// A PR alert already opens this conversation. Keep unread replies in other Threads.
				const source = candidates.size ? threadItems.filter(item => item.kind !== InboxNotificationKind.Completed
					|| item.chatResource?.toString() !== chatResource.toString()) : threadItems;
				for (const [kind, group] of candidates) {
					const timestamps = [...group.values()].flatMap(({ timestamp }) => timestamp === undefined ? [] : [timestamp]);
					source.push({
						id: JSON.stringify([resource.toString(), kind, [...group].map(([key, event]) => JSON.stringify([key, event.revision])).sort()]),
						kind, priority: priorities[kind], description: descriptions[kind],
						title: session.title.trim() || localize('sessions.list.untitled', 'Untitled Session'),
						timestamp: timestamps.length ? Math.max(...timestamps) : updatedAt,
						sessionResource: resource,
						chatResource,
						actions,
					});
				}
				const notifications = source.filter(item => !dismissed.has(item.id)).sort(compareInboxNotifications);
				const actionable = mergeConflict || notifications.some(item => item.kind !== InboxNotificationKind.Completed && item.kind !== InboxNotificationKind.PassingCI);
				const tab: IInboxSessionAttention['tab'] = actionable ? InboxTab.ReadyForYou : working ? InboxTab.Working
					: notifications.some(item => item.kind === InboxNotificationKind.PassingCI) ? InboxTab.ReadyToMerge : InboxTab.ReadyForYou;
				return { session, resource, source, notifications, threads, root, working, tab, mergeConflict };
			});
		});
		const attentionStartTime = observableFromEvent(this, listener => storage.onDidChangeValue(event => {
			if (event.scope === StorageScope.PROFILE && event.key === attentionStartTimeKey) listener(event);
		}), () => storage.getNumber(attentionStartTimeKey, StorageScope.PROFILE));
		this.sessionAttention = derived(reader => {
			const attention = new Map<string, IInboxSessionAttention>();
			if (!tracking.read(reader)) return attention;
			const cutoff = attentionStartTime.read(reader);
			for (const { session, source, notifications, threads, working, tab, mergeConflict } of sessionEntries.read(reader)) {
				const needsInput = session.management?.status === 'needsInput' || threads.some(thread => thread.management?.status === 'needsInput');
				// Use status transition times, so a later rename does not make a completion new.
				const completionTimes = [session.management, ...threads.map(thread => thread.management)]
					.flatMap(management => management?.status === 'completed' || management?.status === 'readyForReview' ? [management.statusChangedAtUnixMs] : []);
				for (const thread of threads) {
					if (!thread.management && thread.executionStatus === 'completed' && thread.updatedAt) completionTimes.push(thread.updatedAt.getTime());
				}
				const completedAt = completionTimes.reduce((latest, time) => Math.max(latest, time), 0);
				attention.set(session.sessionId, {
					tab,
					priority: Math.min(notifications[0]?.priority ?? InboxNotificationPriority.Later,
						mergeConflict ? InboxNotificationPriority.Next : InboxNotificationPriority.Later),
					notificationIds: source.map(item => item.id).sort(),
					isHistoricalCompletion: !working && !needsInput && !mergeConflict
						&& cutoff !== undefined && completedAt > 0 && completedAt < cutoff
						&& !notifications.some(item => item.kind !== InboxNotificationKind.Completed && item.kind !== InboxNotificationKind.PullRequestMerged)
						&& !source.some(item => item.kind === InboxNotificationKind.NeedsInput || item.kind === InboxNotificationKind.Failed),
				});
			}
			return attention;
		});
		this.sessionRows = derived(reader => {
			if (!presenting.read(reader)) return [];
			const workflow = this.workflow.read(reader);
			const rows: IInboxSessionRow[] = [];
			for (const { session, resource, source, notifications, threads, root, working, tab: attentionTab } of sessionEntries.read(reader)) {
				const id = resource.toString();
				const preference = workflow.get(id);
				const completed = [session.management, ...threads.map(thread => thread.management)].some(management =>
					management?.status === 'completed' || management?.status === 'readyForReview' || management?.status === 'failed')
					|| threads.some(thread => thread.executionStatus === 'completed' || thread.executionStatus === 'failed');
				if (!preference?.hold && !notifications.length && !working && !completed) continue;
				// Viewing or dismissing a Thread must not reopen the Session's Done occurrence.
				const occurrence = JSON.stringify([
					session.management?.status, session.management?.statusChangedAtUnixMs,
					threads.map(thread => [thread.threadId, thread.management?.status, thread.executionStatus,
					thread.management?.statusChangedAtUnixMs ?? thread.updatedAt?.getTime()]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
					...source.filter(item => isPullRequestNotificationKind(item.kind)).map(item => item.id).sort(),
				]);
				const tab = preference?.hold ? InboxTab.OnHold
					: preference?.done === occurrence ? InboxTab.Done
						: notifications.length ? attentionTab : working ? InboxTab.Working : InboxTab.Done;
				const lead = notifications[0];
				const sessionTitle = session.title.trim() || localize('sessions.list.untitled', 'Untitled Session');
				rows.push({
					id, tab, occurrence, notifications, sessionTitle,
					title: sessionTitle,
					kind: lead?.kind ?? InboxNotificationKind.Completed,
					description: lead?.description ?? sessionManagementLabel(root.management ?? session.management) ?? '',
					priority: lead?.priority ?? InboxNotificationPriority.Later,
					timestamp: lead?.timestamp ?? root.management?.statusChangedAtUnixMs ?? root.updatedAt?.getTime() ?? 0,
					sessionResource: resource,
					chatResource: lead?.chatResource ?? sessionResource('thread', session.sessionId, root.threadId),
					actions: tab === InboxTab.ReadyForYou || tab === InboxTab.ReadyToMerge ? [actions[0], markDoneAction] : [actions[0]],
					hasImages: false,
				});
			}
			return rows.sort(comparator.read(reader));
		});
		this.attentionCount = derived(reader => this.sessionRows.read(reader)
			.filter(row => row.tab === InboxTab.ReadyForYou || row.tab === InboxTab.ReadyToMerge).length);
		this.dismissedNotifications = derived(reader => {
			if (!presenting.read(reader)) return [];
			const dismissed = this.dismissedIds.read(reader);
			const workspace = mode.read(reader);
			const items = new Map<string, IInboxNotificationItem>();
			for (const [id, snapshot] of this.dismissedSnapshots.read(reader)) {
				if (dismissed.has(id) && snapshot.mode === workspace) items.set(id, snapshot.item);
			}
			for (const { source } of sessionEntries.read(reader)) {
				for (const item of source) {
					if (dismissed.has(item.id)) items.set(item.id, item);
				}
			}
			return [...items.values()].sort(comparator.read(reader));
		});
		const catalogState = observableFromEvent(this, catalog.onDidChange, () => catalog.state);
		this.isLoading = derived(reader => tracking.read(reader) && (catalogState.read(reader) === 'loading'
			|| (mode.read(reader) === 'chat' && chatCatalog.sources.some(source => source.snapshot.read(reader).loading === true))));
		this._register(autorun(reader => {
			if (this.attentionConsumers.read(reader) > 0) this.sessionAttention.read(reader);
		}));
		this._register(toDisposable(() => live.set(false, undefined)));
	}

	acquireSessionAttention(): IDisposable {
		if (this.isDisposed) return Disposable.None;
		if (this.attentionConsumers.get() === 0 && !Number.isFinite(this.storage.getNumber(attentionStartTimeKey, StorageScope.PROFILE))) {
			this.storage.store(attentionStartTimeKey, Date.now(), StorageScope.PROFILE, StorageTarget.MACHINE);
		}
		this.attentionConsumers.set(this.attentionConsumers.get() + 1, undefined);
		return toDisposable(() => {
			if (!this.isDisposed) this.attentionConsumers.set(this.attentionConsumers.get() - 1, undefined);
		});
	}

	dismissNotification(id: string, snapshot?: IInboxNotificationItem): void {
		const dismissed = this.dismissedIds.get();
		if (dismissed.has(id)) return;
		const item = this.notifications.get().find(item => item.id === id) ?? (snapshot?.id === id ? snapshot : undefined);
		if (!item) return;
		const ids = [...dismissed, id].slice(-dismissedLimit);
		const snapshots = new Map(this.dismissedSnapshots.get());
		snapshots.set(id, { item, mode: this.mode.get() });
		const retained = new Set(ids);
		for (const key of snapshots.keys()) {
			if (!retained.has(key)) snapshots.delete(key);
		}
		this.dismissedSnapshots.set(snapshots, undefined);
		this.storage.store(dismissedKey, JSON.stringify(ids), StorageScope.APPLICATION, StorageTarget.MACHINE);
	}

	setSortMode(sortMode: InboxNotificationsSortMode): void {
		this.sort.set(sortMode, undefined);
	}

	setSessionOnHold(row: IInboxSessionRow, onHold: boolean): void {
		if (!this.sessionRows.get().some(current => current.id === row.id)) return;
		this.updateWorkflow(row.id, { ...this.workflow.get().get(row.id), hold: onHold ? true : undefined });
	}

	markSessionDone(row: IInboxSessionRow): void {
		if (!this.sessionRows.get().some(current => current.id === row.id && current.occurrence === row.occurrence)) return;
		this.updateWorkflow(row.id, { done: row.occurrence });
	}

	private updateWorkflow(id: string, preference: InboxWorkflow): void {
		const workflow = new Map(this.workflow.get());
		workflow.delete(id);
		if (preference.done || preference.hold) workflow.set(id, preference);
		this.storage.store(workflowKey, JSON.stringify([...workflow].slice(-dismissedLimit)), StorageScope.APPLICATION, StorageTarget.MACHINE);
	}

	private readWorkflow(): ReadonlyMap<string, InboxWorkflow> {
		const workflow = new Map<string, InboxWorkflow>();
		try {
			const value: unknown = JSON.parse(this.storage.get(workflowKey, StorageScope.APPLICATION, '[]'));
			if (!Array.isArray(value)) return workflow;
			for (const entry of value.slice(-dismissedLimit)) {
				if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || typeof entry[1] !== 'object' || !entry[1]) continue;
				const [id, preference] = entry;
				const hold = preference.hold === true ? true : undefined;
				const done = typeof preference.done === 'string' ? preference.done : undefined;
				if (hold || done) workflow.set(id, { hold, done });
			}
		} catch {
			// Invalid persisted data must not suppress current notifications.
		}
		return workflow;
	}

	private readDismissedIds(): ReadonlySet<string> {
		try {
			const value: unknown = JSON.parse(this.storage.get(dismissedKey, StorageScope.APPLICATION, '[]'));
			if (Array.isArray(value)) return new Set(value.filter((id): id is string => typeof id === 'string').slice(-dismissedLimit));
		} catch {
			// Invalid persisted data must not hide any current notifications.
		}
		return new Set();
	}
}
