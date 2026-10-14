import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { BrowserStorageService } from '../../../../../workbench/services/storage/browser/storageService.js';
import { SessionsService } from '../../browser/sessionsService.js';
import { CustomViewService } from '../../../customView/browser/customViewService.js';
import { NullLoggerService } from '../../../../../platform/log/common/log.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
import { canceled, isCancellationError } from '../../../../../base/common/errors.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { SessionsManagementService } from '../../browser/sessionsManagementService.js';
import type { IActiveSessionThread, ISession, SessionWorkspaceSelection } from '../../common/session.js';
import type { ISessionsProvider } from '../../common/sessionsProvider.js';
import type { ChatAgent } from '../../../../../workbench/services/chat/common/chatService.js';

ensureNoDisposablesAreLeakedInTestSuite();

class Provider extends Disposable implements ISessionsProvider {
	readonly id = 'test-provider';
	readonly label = 'Test provider';
	readonly order = 0;
	readonly onDidChangeCatalog = Event.None;
	readonly onDidChangeSession = Event.None;
	items: ISession[] = [session('first'), session('second')];
	createCount = 0;
	subscribeCount = 0;
	async list(): Promise<readonly ISession[]> { return this.items; }
	async listAgents(): Promise<readonly ChatAgent[]> { return []; }
	async readCatalog(id: string): Promise<ISession | undefined> { return this.items.find(session => session.sessionId === id); }
	async subscribe(value: ISession): Promise<ISession> { this.subscribeCount++; return { ...value, agentTree: [] }; }
	async unsubscribe(): Promise<void> { }
	currentWorkspace(): SessionWorkspaceSelection { return { type: 'current' }; }
	async create(_title: string, _workspace: SessionWorkspaceSelection, _agent?: ChatAgent, _creationId?: string): Promise<IActiveSessionThread> {
		this.createCount++;
		const created = session(`created-${this.createCount}`);
		this.items.push(created);
		return { session: created, threadId: created.chats[0]!.threadId };
	}
	async setModel(): Promise<void> { }
	async archive(value: ISession): Promise<ISession> { return { ...value, status: 'archived', agentTree: undefined }; }
	async restore(value: ISession): Promise<ISession> { return { ...value, status: 'active', agentTree: undefined }; }
	async stop(value: ISession): Promise<ISession> { return this.archive(value); }
	async interrupt(): Promise<void> { }
}

function session(id: string): ISession {
	return { sessionId: id, title: id, status: 'active', nextApprovalMode: 'manual', chats: [{ threadId: `${id}-thread`, origin: { type: 'root' }, status: 'active' }] };
}

for (const reentrant of [false, true]) {
	test(`concurrent draft materialization shares one creation and retains success for retry (reentrant: ${reentrant})`, async () => {
		const provider = new Provider();
		using management = new SessionsManagementService(provider);
		await management.initialize();
		const draft = management.createUntitledSession('Send once');
		let repeated: Promise<IActiveSessionThread> | undefined;
		using listener = management.onDidChange(() => {
			if (reentrant && management.state === 'creating') repeated = management.materializeUntitledSession(draft.untitledSessionId);
		});
		const first = management.materializeUntitledSession(draft.untitledSessionId);
		const second = management.materializeUntitledSession(draft.untitledSessionId);
		assert.equal(first, second);
		const created = await first;
		assert.equal(await second, created);
		if (reentrant) assert.equal(await repeated, created);
		assert.equal(await management.materializeUntitledSession(draft.untitledSessionId), created);
		assert.deepEqual({ count: provider.createCount, state: management.state, drafts: management.untitledSessions }, { count: 1, state: 'ready', drafts: [draft] });
	});
}

test('failed draft creation remains editable and can retry with its chosen values', async () => {
	const provider = new Provider();
	const create = provider.create.bind(provider);
	let first = true;
	provider.create = async (...args) => { if (first) { first = false; throw new Error('Preparation failed'); } return create(...args); };
	using management = new SessionsManagementService(provider);
	await management.initialize();
	const draft = management.createUntitledSession('Retry');
	await assert.rejects(management.materializeUntitledSession(draft.untitledSessionId), /Preparation failed/);
	assert.equal(management.state, 'error');
	assert.equal(management.activeUntitledSession, draft);
	const chosen: ChatAgent = { name: 'Review', description: 'Review code', sourceId: 'workspace' };
	management.setUntitledSessionAgent(draft.untitledSessionId, chosen);
	const requests: (ChatAgent | undefined)[] = [];
	provider.create = async (...args) => { requests.push(args[2]); return create(...args); };
	await management.materializeUntitledSession(draft.untitledSessionId);
	assert.deepEqual({ requests, state: management.state, error: management.error }, { requests: [chosen], state: 'ready', error: undefined });
});

test('completion of one draft leaves another pending creation in creating state', async () => {
	const provider = new Provider();
	const held = new DeferredPromise<IActiveSessionThread>();
	const create = provider.create.bind(provider);
	provider.create = (...args) => args[0] === 'Held' ? held.p : create(...args);
	using management = new SessionsManagementService(provider);
	await management.initialize();
	const heldDraft = management.createUntitledSession('Held');
	const heldCreation = management.materializeUntitledSession(heldDraft.untitledSessionId);
	const fast = management.createUntitledSession('Fast');
	await management.materializeUntitledSession(fast.untitledSessionId);
	assert.equal(management.state, 'creating');
	const result = await create('Held', { type: 'current' });
	await held.complete(result);
	await heldCreation;
	assert.equal(management.state, 'ready');
});

test('ensureActiveThread graduates the selected draft instead of returning the previous Thread', async () => {
	const provider = new Provider();
	using management = new SessionsManagementService(provider);
	await management.initialize();
	const draft = management.createUntitledSession('Selected draft');
	const active = await management.ensureActiveThread();
	assert.deepEqual({ id: active.session.sessionId, selected: management.active?.threadId, draft: management.activeUntitledSession, mapping: management.materializedSessions.get().get(draft.untitledSessionId) }, {
		id: 'created-1', selected: 'created-1-thread', draft: undefined, mapping: { sessionId: 'created-1', threadId: 'created-1-thread' },
	});
});

for (const later of ['thread', 'draft'] as const) {
	test(`a delayed Thread open retains a newer explicit ${later} choice`, async () => {
		const provider = new Provider();
		const subscribed = new DeferredPromise<void>();
		const held = new DeferredPromise<ISession>();
		const subscribe = provider.subscribe.bind(provider);
		provider.subscribe = async value => {
			if (value.sessionId !== 'second') return subscribe(value);
			await subscribed.complete();
			return held.p;
		};
		using management = new SessionsManagementService(provider);
		await management.initialize();
		const opening = management.openThread('second', 'second-thread');
		await subscribed.p;
		const draft = later === 'draft' ? management.createUntitledSession('Later') : undefined;
		if (later === 'thread') management.selectThread('first', 'first-thread');
		await held.complete({ ...provider.items[1]!, agentTree: [] });
		await opening;
		assert.deepEqual({ thread: management.active?.threadId, draft: management.activeUntitledSession?.untitledSessionId }, { thread: 'first-thread', draft: draft?.untitledSessionId });
	});
}

test('a delayed new Session creation does not replace a draft opened during preparation', async () => {
	const provider = new Provider();
	const held = new DeferredPromise<IActiveSessionThread>();
	provider.create = () => held.p;
	using management = new SessionsManagementService(provider);
	await management.initialize();
	const creating = management.startNewSession();
	const draft = management.createUntitledSession('Later');
	const created = session('background');
	await held.complete({ session: created, threadId: created.chats[0]!.threadId });
	await creating;
	assert.deepEqual({ active: management.active?.threadId, draft: management.activeUntitledSession?.untitledSessionId, ids: management.sessions.map(value => value.sessionId) }, { active: 'first-thread', draft: draft.untitledSessionId, ids: ['background', 'first', 'second'] });
});

test('background graduation preserves the later draft when there was no previous durable selection', async () => {
	const provider = new Provider();
	provider.items = [];
	using management = new SessionsManagementService(provider);
	await management.initialize();
	const first = management.createUntitledSession('First');
	const created = await management.materializeUntitledSession(first.untitledSessionId);
	const later = management.createUntitledSession('Later');
	management.promoteUntitledSession(first.untitledSessionId, created);
	assert.deepEqual({ active: management.active, draft: management.activeUntitledSession, ids: management.sessions.map(value => value.sessionId) }, { active: undefined, draft: later, ids: ['created-1'] });
});

test('disposing during draft preparation cancels completion without publishing a Session', async () => {
	const provider = new Provider();
	const held = new DeferredPromise<IActiveSessionThread>();
	const started = new DeferredPromise<void>();
	provider.create = async () => { await started.complete(); return held.p; };
	const management = new SessionsManagementService(provider);
	const draft = management.createUntitledSession('Closing');
	const creating = management.materializeUntitledSession(draft.untitledSessionId);
	const rejected = assert.rejects(creating, isCancellationError);
	await started.p;
	management.dispose();
	const created = session('late');
	await held.complete({ session: created, threadId: created.chats[0]!.threadId });
	await rejected;
	assert.deepEqual(management.sessions, []);
});

test('cancelled preparation restores ready state and allows retry', async () => {
	const provider = new Provider();
	const create = provider.create.bind(provider);
	let first = true;
	provider.create = async (...args) => { if (first) { first = false; throw canceled(); } return create(...args); };
	using management = new SessionsManagementService(provider);
	const draft = management.createUntitledSession('Retry cancel');
	await assert.rejects(management.materializeUntitledSession(draft.untitledSessionId), isCancellationError);
	assert.deepEqual({ state: management.state, error: management.error, draft: management.activeUntitledSession }, { state: 'ready', error: undefined, draft });
	await management.materializeUntitledSession(draft.untitledSessionId);
	assert.equal(provider.createCount, 1);
});


test('closing a sibling while it opens preserves both visible and management selection', async () => {
	const dom = new JSDOM('', { url: 'https://ash.test' });
	try {
		const provider = new Provider();
		const held = new DeferredPromise<ISession>();
		const subscribed = new DeferredPromise<void>();
		const subscribe = provider.subscribe.bind(provider);
		provider.subscribe = async value => {
			if (value.sessionId !== 'second') return subscribe(value);
			await subscribed.complete();
			return held.p;
		};
		using management = new SessionsManagementService(provider);
		using storage = new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'pending-sibling', flushInterval: 0 });
		const visible = provider.items.map(value => ({ kind: 'session', sessionId: value.sessionId, threadId: value.chats[0]!.threadId }));
		storage.store('sessions.viewState', JSON.stringify({ version: 2, drafts: [], visible, active: 0 }), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		using customViews = new CustomViewService(new NullLoggerService(), storage);
		using view = new SessionsService(management, storage, customViews);
		await view.initialize();
		const opening = view.openThread('second', 'second-thread');
		await subscribed.p;
		view.closeVisibleSelection(view.visibleSelections[1]!);
		await held.complete({ ...provider.items[1]!, agentTree: [] });
		await opening;
		assert.equal(management.active?.threadId, 'first-thread');
		assert.deepEqual(view.visibleSelections.map(selection => selection.kind === 'session' ? selection.active.threadId : selection.session.untitledSessionId), ['first-thread']);
		assert.equal(view.activeSelection?.kind === 'session' ? view.activeSelection.active.threadId : undefined, 'first-thread');
	} finally { dom.window.close(); }
});


test('graduated draft lookup reads the canonical Session after catalog facts change', async () => {
	const provider = new Provider();
	using management = new SessionsManagementService(provider);
	await management.initialize();
	const draft = management.createUntitledSession('Graduated');
	const created = await management.materializeUntitledSession(draft.untitledSessionId);
	management.promoteUntitledSession(draft.untitledSessionId, created);
	const stored = provider.items.findIndex(value => value.sessionId === created.session.sessionId);
	provider.items[stored] = { ...created.session, title: 'Renamed by another window', agentTree: undefined, chats: [...created.session.chats, { threadId: 'peer', status: 'active', origin: { type: 'root' } }] };
	await management.openThread(created.session.sessionId, 'peer');
	const lookedUp = await management.materializeUntitledSession(draft.untitledSessionId);
	assert.deepEqual({ title: lookedUp.session.title, thread: lookedUp.threadId, creates: provider.createCount }, { title: 'Renamed by another window', thread: created.threadId, creates: 1 });
	assert.equal(lookedUp.session, management.sessions.find(value => value.sessionId === created.session.sessionId));
});
