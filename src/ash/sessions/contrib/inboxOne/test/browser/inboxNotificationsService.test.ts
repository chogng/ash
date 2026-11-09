import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { suite, test } from 'mocha';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IStorageService, StorageScope } from '../../../../../platform/storage/common/storage.js';
import { InboxNotificationKind, InboxNotificationPriority, InboxNotificationsSortMode, InboxTab } from '../../../../../workbench/contrib/sessions/common/inboxNotificationsService.js';
import { BrowserStorageService } from '../../../../../workbench/services/storage/browser/storageService.js';
import { IAgentWorkbenchLayoutService, type SessionsPartVisibilityChangeEvent } from '../../../../browser/workbench.js';
import { ISessionsService } from '../../../../services/sessions/browser/sessionsService.js';
import type { ISession } from '../../../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import { IChatListCatalog } from '../../../chat/browser/chatListModel.js';
import { IGitHubService } from '../../../github/browser/githubService.js';
import type { IResolvedSessionPullRequest } from '../../../github/common/types.js';
import { InboxNotificationsService } from '../../browser/inboxNotificationsService.js';

const attentionStartTimeKey = 'sessions.inboxNotifications.attentionStartTime';

suite('Inbox session attention', () => {
	test('first subscriber starts tracking and last release disconnects the catalog', () => {
		using fixture = new AttentionFixture();
		fixture.setSessions([createSession('input', 'needsInput', 1), createSession('running', 'working', 2)]);
		const service = fixture.createService();
		assert.equal(service.sessionAttention.get().size, 0);
		assert.equal(fixture.changed.hasListeners(), false);
		assert.equal(fixture.storage.getNumber(attentionStartTimeKey, StorageScope.PROFILE), undefined);

		using first = service.acquireSessionAttention();
		using second = service.acquireSessionAttention();
		assert.deepEqual(service.notifications.get(), []);
		assert.deepEqual(service.sessionRows.get(), []);
		assert.equal(service.attentionCount.get(), 0);
		const inputId = service.sessionAttention.get().get('input')!.notificationIds[0];
		assert.ok(inputId);
		assert.deepEqual([...service.sessionAttention.get()], [
			['input', { tab: InboxTab.ReadyForYou, priority: InboxNotificationPriority.Now, notificationIds: [inputId], isHistoricalCompletion: false }],
			['running', { tab: InboxTab.Working, priority: InboxNotificationPriority.Later, notificationIds: [], isHistoricalCompletion: false }],
		]);
		assert.equal(fixture.changed.hasListeners(), true);
		first.dispose();
		first.dispose();
		assert.equal(fixture.changed.hasListeners(), true);
		fixture.setSidebarVisible(true);
		assert.equal(service.notifications.get()[0]?.id, inputId);
		assert.equal(service.attentionCount.get(), 1);
		const row = service.sessionRows.get().find(row => row.sessionTitle === 'input')!;
		const previousAttention = service.sessionAttention.get().get('input');
		service.setSessionOnHold(row, true);
		assert.deepEqual(service.sessionAttention.get().get('input'), previousAttention);
		service.setSessionOnHold(row, false);
		service.markSessionDone(row);
		assert.deepEqual(service.sessionAttention.get().get('input'), previousAttention);
		service.dismissNotification(inputId);
		assert.deepEqual(service.sessionAttention.get().get('input')?.notificationIds, [inputId]);

		fixture.setSidebarVisible(false);
		assert.deepEqual(service.sessionRows.get(), []);
		assert.equal(service.sessionAttention.get().size, 2);
		assert.equal(fixture.changed.hasListeners(), true);
		fixture.setSessions([createSession('running', 'completed', 3)]);
		assert.equal(service.sessionAttention.get().get('running')?.tab, InboxTab.ReadyForYou);

		second.dispose();
		assert.equal(service.sessionAttention.get().size, 0);
		assert.equal(service.attentionCount.get(), 0);
		assert.equal(fixture.changed.hasListeners(), false);
		using next = service.acquireSessionAttention();
		service.dispose();
		assert.equal(fixture.changed.hasListeners(), false);
		assert.equal(service.sessionAttention.get().size, 0);
	});

	test('classifies late history with the first profile cutoff across reacquisition', () => {
		using fixture = new AttentionFixture();
		const initial = fixture.createService();
		using demand = initial.acquireSessionAttention();
		const cutoff = fixture.storage.getNumber(attentionStartTimeKey, StorageScope.PROFILE)!;
		const old = createSession('old', 'completed', cutoff - 1);
		const boundary = createSession('boundary', 'completed', cutoff);
		const input = createSession('input', 'needsInput', cutoff - 2);
		fixture.setSessions([old, boundary, input]);
		assert.deepEqual(historical(initial), ['old']);
		demand.dispose();
		initial.dispose();

		fixture.setSessions([
			{ ...old, chats: [{ ...old.chats[0], updatedAt: new Date(cutoff + 1) }] },
			boundary, input, createSession('new', 'completed', cutoff + 1),
		]);
		const restored = fixture.createService();
		using restoredDemand = restored.acquireSessionAttention();
		assert.equal(fixture.storage.getNumber(attentionStartTimeKey, StorageScope.PROFILE), cutoff);
		assert.deepEqual(historical(restored), ['old']);
		fixture.setSessions([createSession('old', 'working', cutoff + 2)]);
		assert.deepEqual(historical(restored), []);
		assert.equal(restored.sessionAttention.get().get('old')?.tab, InboxTab.Working);
	});

	test('passing CI requires every owned PR and yields to review and Thread attention', () => {
		using fixture = new AttentionFixture();
		fixture.setSessions([createSession('code', 'completed', 1)]);
		const service = fixture.createService();
		using demand = service.acquireSessionAttention();
		const attention = () => service.sessionAttention.get().get('code')!;
		const passing = (number: number): IResolvedSessionPullRequest => ({
			uri: URI.parse(`https://github.com/owner/repo/pull/${number}`), owner: 'owner', repo: 'repo',
			number, title: 'PR', state: 'open', headCommit: 'head', checksPassed: true, status: {}, icon: { id: 'git-pull-request' },
		});
		const first = passing(1);
		const second = passing(2);
		assert.deepEqual(fixture.watched, ['code']);
		assert.equal(fixture.githubChanged.hasListeners(), true);
		assert.equal(attention().isHistoricalCompletion, true);
		for (const request of [
			{ ...second, checksPassed: undefined },
			{ ...second, checksPassed: false, status: { hasFailingChecks: true } },
			{ ...second, state: 'draft' as const },
			{ ...second, copilotReview: { revision: 'review' } },
			{ ...second, status: { hasMergeConflicts: true } },
		]) {
			fixture.setPullRequests([first, request]);
			assert.equal(attention().tab, InboxTab.ReadyForYou);
		}
		fixture.setPullRequests([first, { ...second, state: 'closed' }]);
		assert.equal(attention().tab, InboxTab.ReadyToMerge);
		assert.equal(attention().priority, InboxNotificationPriority.Next);
		assert.equal(attention().isHistoricalCompletion, false);
		fixture.setSidebarVisible(true);
		const ready = service.notifications.get().find(item => item.kind === InboxNotificationKind.PassingCI)!;
		assert.ok(ready.chatResource);
		assert.ok(attention().notificationIds.includes(ready.id));
		assert.equal(service.attentionCount.get(), 1);
		service.dismissNotification(ready.id);
		assert.equal(attention().tab, InboxTab.ReadyForYou);
		assert.ok(attention().notificationIds.includes(ready.id));
		fixture.setPullRequests([{ ...first, headCommit: 'new-head' }]);
		assert.equal(attention().tab, InboxTab.ReadyToMerge);
		fixture.setSessions([createSession('code', 'needsInput', 2)]);
		assert.equal(attention().tab, InboxTab.ReadyForYou);
		assert.equal(attention().priority, InboxNotificationPriority.Now);
		fixture.setSessions([createSession('code', 'working', 3)]);
		assert.equal(attention().tab, InboxTab.Working);
		fixture.setSidebarVisible(false);
		demand.dispose();
		assert.deepEqual(fixture.watched, []);
		assert.equal(fixture.githubChanged.hasListeners(), false);
	});

	test('deduplicates PR alerts by owner and keeps a merged alert for each owning Session', () => {
		using fixture = new AttentionFixture();
		const owner = createSession('owner', 'completed', 100);
		const linked = createSession('linked', 'completed', 200);
		const otherOwner = createSession('other', 'completed', 99);
		fixture.setSessions([linked, owner, otherOwner]);
		const service = fixture.createService();
		using demand = service.acquireSessionAttention();
		fixture.setSidebarVisible(true);
		const failed = createPullRequest(7, { status: { hasFailingChecks: true }, copilotReview: { revision: 'review', timestamp: 250 } });
		const reference = {
			...failed, uri: URI.parse('https://github.com/OWNER/REPO/pull/7'), recordedReference: {
				repository: { host: 'github.com', owner: 'owner', name: 'repo' }, number: 7,
			}
		};
		fixture.setPullRequests([failed], 'owner');
		fixture.setPullRequests([failed], 'other');
		fixture.setPullRequests([reference, createPullRequest(8, { status: { hasFailingChecks: true }, state: 'draft' })], 'linked');
		const prs = () => service.notifications.get().filter(item => item.kind !== InboxNotificationKind.Completed);
		const expected = [
			['owner', InboxNotificationKind.ReviewComments, InboxNotificationPriority.Now],
			['linked', InboxNotificationKind.FailingCI, InboxNotificationPriority.Now],
			['owner', InboxNotificationKind.FailingCI, InboxNotificationPriority.Now],
		];
		const snapshot = () => prs().map(item => [item.title, item.kind, item.priority]);
		assert.deepEqual(snapshot(), expected);
		assert.deepEqual(service.notifications.get().filter(item => item.kind === InboxNotificationKind.Completed).map(item => item.title), ['other']);
		const ids = prs().map(item => item.id);
		fixture.setSessions([otherOwner, owner, linked]);
		assert.deepEqual(prs().map(item => item.id), ids);
		fixture.setSessions([linked, createSession('owner', 'working', 300)]);
		assert.deepEqual(snapshot(), [
			['linked', InboxNotificationKind.ReviewComments, InboxNotificationPriority.Now],
			['linked', InboxNotificationKind.FailingCI, InboxNotificationPriority.Now],
		]);
		assert.ok(prs()[1].id.includes('/pull/7') && prs()[1].id.includes('/pull/8'));

		fixture.setSessions([owner, otherOwner, linked]);
		const merged = { ...failed, state: 'merged' as const, mergedAt: 300 };
		fixture.setPullRequests([merged], 'owner');
		fixture.setPullRequests([merged], 'other');
		fixture.setPullRequests([{ ...reference, state: 'merged', mergedAt: 300 }], 'linked');
		assert.deepEqual(snapshot().sort(), [
			['other', InboxNotificationKind.PullRequestMerged, InboxNotificationPriority.Next],
			['owner', InboxNotificationKind.PullRequestMerged, InboxNotificationPriority.Next],
		]);
		assert.equal(service.sessionAttention.get().get('owner')?.isHistoricalCompletion, true);
	});

	test('dismissal follows the PR head, review revision and merge occurrence', () => {
		using fixture = new AttentionFixture();
		fixture.setSessions([createSession('code', 'completed', 100)]);
		const service = fixture.createService();
		using demand = service.acquireSessionAttention();
		fixture.setSidebarVisible(true);
		const failed = createPullRequest(7, { status: { hasFailingChecks: true }, copilotReview: { revision: 'first', timestamp: 120 } });
		const items = (kind: InboxNotificationKind) => service.notifications.get().filter(item => item.kind === kind);
		fixture.setPullRequests([failed]);
		for (const kind of [InboxNotificationKind.FailingCI, InboxNotificationKind.ReviewComments]) service.dismissNotification(items(kind)[0].id);
		fixture.setSessions([createSession('code', 'completed', 200)]);
		fixture.setPullRequests([{ ...failed, title: 'Renamed', latestCheckAtUnixMs: 205, copilotReview: { revision: 'first', timestamp: 120 } }]);
		assert.equal(items(InboxNotificationKind.FailingCI).length + items(InboxNotificationKind.ReviewComments).length, 0);
		fixture.setPullRequests([{ ...failed, headCommit: 'new-head', copilotReview: { revision: 'reply', timestamp: 240 } }]);
		assert.equal(items(InboxNotificationKind.FailingCI).length, 1);
		assert.equal(items(InboxNotificationKind.ReviewComments).length, 1);

		const merged = { ...failed, state: 'merged' as const, mergedAt: 300 };
		fixture.setPullRequests([merged, createPullRequest(8, { checksPassed: true })]);
		assert.equal(service.sessionAttention.get().get('code')?.tab, InboxTab.ReadyForYou);
		service.dismissNotification(items(InboxNotificationKind.PullRequestMerged)[0].id);
		fixture.setSessions([createSession('code', 'completed', 400)]);
		assert.equal(items(InboxNotificationKind.PullRequestMerged).length, 0);
		assert.equal(service.sessionAttention.get().get('code')?.tab, InboxTab.ReadyToMerge);
	});

	test('sorts CI alerts by check time and falls back only when the alert has no check time', () => {
		using fixture = new AttentionFixture();
		fixture.setSessions([
			createSession('old failure', 'completed', 900),
			createSession('untimed failure', 'completed', 250),
			createSession('new failure', 'completed', 100),
			createSession('old success', 'completed', 800),
			createSession('new success', 'completed', 50),
		]);
		const service = fixture.createService();
		fixture.setSidebarVisible(true);
		const failed = { status: { hasFailingChecks: true } };
		fixture.setPullRequests([createPullRequest(1, { ...failed, latestCheckAtUnixMs: 200 })], 'old failure');
		fixture.setPullRequests([createPullRequest(2, failed)], 'untimed failure');
		fixture.setPullRequests([createPullRequest(3, { ...failed, latestCheckAtUnixMs: 300 })], 'new failure');
		fixture.setPullRequests([
			createPullRequest(4, { checksPassed: true, latestCheckAtUnixMs: 270 }),
			createPullRequest(5, { checksPassed: true }),
		], 'old success');
		fixture.setPullRequests([createPullRequest(6, { checksPassed: true, latestCheckAtUnixMs: 320 })], 'new success');
		const rows = () => service.notifications.get().map(item => [item.title, item.timestamp]);
		assert.deepEqual(rows(), [
			['new failure', 300], ['untimed failure', 250], ['old failure', 200], ['new success', 320], ['old success', 270],
		]);
		service.setSortMode(InboxNotificationsSortMode.Recency);
		assert.deepEqual(rows(), [
			['new success', 320], ['new failure', 300], ['old success', 270], ['untimed failure', 250], ['old failure', 200],
		]);
	});
});

function historical(service: InboxNotificationsService): string[] {
	return [...service.sessionAttention.get()].filter(([, value]) => value.isHistoricalCompletion).map(([id]) => id);
}

function createSession(id: string, status: NonNullable<ISession['management']>['status'], timestamp: number): ISession {
	return {
		sessionId: id, title: id, kind: 'code', status: 'active', nextApprovalMode: 'manual',
		chats: [{ threadId: id, origin: { type: 'root' }, status: 'active', management: { status, statusChangedAtUnixMs: timestamp } }],
	};
}

function createPullRequest(number: number, overrides: Partial<IResolvedSessionPullRequest> = {}): IResolvedSessionPullRequest {
	return {
		uri: URI.parse(`https://github.com/owner/repo/pull/${number}`), owner: 'owner', repo: 'repo',
		number, title: 'PR', state: 'open', headCommit: 'head', status: {}, icon: { id: 'git-pull-request' },
		...overrides,
	};
}

class AttentionFixture extends Disposable {
	private readonly services = this._register(new InstantiationService());
	private readonly visibility = this._register(new Emitter<SessionsPartVisibilityChangeEvent>());
	readonly changed = this._register(new Emitter<void>());
	readonly githubChanged = this._register(new Emitter<void>());
	readonly storage: BrowserStorageService;
	watched: readonly string[] = [];
	private readonly pullRequests = new Map<string, readonly IResolvedSessionPullRequest[]>();
	private sessions: readonly ISession[] = [];
	private sidebarVisible = false;

	constructor() {
		super();
		const dom = new JSDOM('', { url: 'https://ash.test' });
		this._register(toDisposable(() => dom.window.close()));
		this.storage = this._register(new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'inbox-attention' }));
		this.services.registerInstance(IStorageService, this.storage);
		this.services.registerInstance(IAgentWorkbenchLayoutService, {
			mainContainer: dom.window.document.body,
			isPartVisible: (part: string) => part === 'sidebar' && this.sidebarVisible,
			onDidChangePartVisibility: this.visibility.event,
		} as unknown as IAgentWorkbenchLayoutService);
		this.services.registerInstance(IContextKeyService, {
			getValue: () => 'code', onDidChangeContext: Event.None,
		} as unknown as IContextKeyService);
		this.services.registerInstance(IChatListCatalog, { sources: [] });
		this.services.registerInstance(IGitHubService, {
			onDidChange: this.githubChanged.event,
			getSessionPullRequests: (sessionId: string) => this.pullRequests.get(sessionId) ?? [],
			watchSessionPullRequests: (ids: readonly string[]) => {
				this.watched = ids;
				return toDisposable(() => { if (this.watched === ids) this.watched = []; });
			},
		} as unknown as IGitHubService);
		const fixture = this;
		this.services.registerInstance(ISessionsManagementService, {
			get sessions() { return fixture.sessions; }, state: 'ready', onDidChange: this.changed.event,
		} as unknown as ISessionsManagementService);
		this.services.registerInstance(ISessionsService, {
			onDidChange: this.changed.event, getLastViewedAt: () => undefined, markVisibleThreadViewed() { },
		} as unknown as ISessionsService);
	}

	setSessions(sessions: readonly ISession[]): void {
		this.sessions = sessions;
		this.changed.fire();
	}

	setSidebarVisible(visible: boolean): void {
		this.sidebarVisible = visible;
		this.visibility.fire({ partId: 'sidebar', visible });
	}

	setPullRequests(pullRequests: readonly IResolvedSessionPullRequest[], sessionId = 'code'): void {
		this.pullRequests.set(sessionId, pullRequests);
		this.githubChanged.fire();
	}

	createService(): InboxNotificationsService {
		return this._register(this.services.createInstance(InboxNotificationsService));
	}
}
