import assert from "node:assert/strict";
import { test } from "mocha";
import { isCancellationError } from "../../../../../base/common/errors.js";
import type { AgentTreeNodeProjection, ModelUsageSummary, ServerNotification, Session as SessionDto, SessionThreadProjection } from "../../../../../../../.build/protocol/typescript/index.js";
import { IAppServerApi, type AppServerConnectionState, IServerEventApi } from "../../../../../platform/agentHost/common/appServerApi.js";
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ISessionApi, ITurnApi, IModelApi } from "../../../../../platform/sessions/common/sessionApi.js";
import { createDisconnectedRendererApi } from '../../../../../platform/agentHost/browser/rendererApi.js';
import { SessionsManagementService } from "../../browser/sessionsManagementService.js";
import { AppServerSessionsProvider } from "../../../../contrib/providers/agentHost/browser/appServerSessionsProvider.js";
import type { IUntitledChatSession, ModelRef, SessionExecutionTarget, SessionWorkspaceSelection } from "../../common/session.js";

ensureNoDisposablesAreLeakedInTestSuite();

test('the App Server provider requires the window connection service when created', () => {
	const fake = sessionHost([]);
	using services = new InstantiationService();
	assert.throws(() => services.createInstance(AppServerSessionsProvider, fake.host), /AppServerApi/);
});

for (const dependency of [IAppServerApi, ISessionApi, IModelApi, ITurnApi, IServerEventApi]) {
	test(`the Session provider rejects missing ${dependency.description} at creation`, () => {
		assert.throws(() => createProvider(sessionHost([]), dependency), { message: `Unknown service: ${dependency.description}` });
	});
}

for (const reconnect of [false, true]) {
	test(`disposing during catalog subscription only releases its own connection (reconnect: ${reconnect})`, async () => {
		const fake = sessionHost([]);
		let resolveCatalog!: (value: { sessions: SessionDto[]; }) => void;
		fake.host.session.subscribeCatalog = () => new Promise(resolve => { resolveCatalog = resolve; });
		let released = 0;
		fake.host.session.unsubscribeCatalog = async () => { released++; };
		const provider = createProvider(fake);
		const loading = provider.list();
		const rejected = assert.rejects(loading, isCancellationError);
		provider.dispose();
		if (reconnect) fake.setConnectionState('ready');
		resolveCatalog({ sessions: [] });
		await rejected;
		assert.equal(released, reconnect ? 0 : 1);
	});

	test(`disposing during Session subscription only releases its own connection (reconnect: ${reconnect})`, async () => {
		const fake = sessionHost([session('session-1', 'thread-1')]);
		let resolveSession!: (value: Awaited<ReturnType<ISessionApi['subscribe']>>) => void;
		const snapshot = await fake.host.session.subscribe({ sessionId: 'session-1' });
		fake.host.session.subscribe = () => new Promise(resolve => { resolveSession = resolve; });
		const released: string[] = [];
		fake.host.session.unsubscribe = async ({ sessionId }) => { released.push(sessionId); };
		const provider = createProvider(fake);
		const loading = provider.subscribe((await provider.list())[0]!);
		const rejected = assert.rejects(loading, isCancellationError);
		provider.dispose();
		if (reconnect) fake.setConnectionState('ready');
		resolveSession(snapshot);
		await rejected;
		assert.deepEqual(released, reconnect ? [] : ['session-1']);
	});
}

test('catalog discovery does not depend on reading the global default model', async () => {
	const fake = sessionHost([]);
	let modelReads = 0;
	fake.host.model.readModel = async () => { modelReads++; throw new Error('Model unavailable'); };
	let released = 0;
	fake.host.session.unsubscribeCatalog = async () => { released++; };
	const provider = createProvider(fake);
	try { assert.deepEqual(await provider.list(), []); }
	finally { provider.dispose(); }
	assert.deepEqual({ modelReads, released }, { modelReads: 0, released: 1 });
});

test('list and subscription retain each root model independently of child and global models', async () => {
	const rootModel = { provider: 'provider', model: 'root-a' };
	const childModel = { provider: 'provider', model: 'child-b' };
	const defaultModel = { provider: 'provider', model: 'default-c' };
	const otherModel = { provider: 'other-provider', model: 'other-root' };
	const root = session('session-1', 'thread-1');
	const fake = sessionHost([
		{ ...root, model: rootModel, threads: [...root.threads, { ...root.threads[0]!, threadId: 'child', parentThreadId: 'thread-1' }] },
		{ ...session('session-2', 'thread-2'), model: otherModel },
	]);
	let modelReads = 0;
	fake.host.model.readModel = async () => { modelReads++; return defaultModel; };
	const subscribe = fake.host.session.subscribe;
	fake.host.session.subscribe = async params => {
		const result = await subscribe(params);
		return {
			...result,
			threadProjections: result.threadProjections.map(detail => ({
				...detail,
				thread: {
					...detail.thread,
					turns: [{
						turnId: 'turn', status: 'completed', mode: 'agent', kind: 'coding', toolMode: 'direct', approvalMode: 'manual',
						usage: emptyUsage(), items: [], model: detail.thread.threadId === 'child' ? childModel : rootModel,
					}],
				},
			})),
		};
	};
	using provider = createProvider(fake);
	const listed = await provider.list();
	const opened = await provider.subscribe(listed[0]!);
	assert.deepEqual({ listed: listed.map(value => value.model), opened: opened.model, modelReads }, { listed: [rootModel, otherModel], opened: rootModel, modelReads: 0 });
});

for (const absent of [undefined, null]) {
	test(`catalog model absence (${absent}) clears the previous model without applying a default`, async () => {
		const fake = sessionHost([{ ...session('session-1', 'thread-1'), model: { provider: 'provider', model: 'old' } }]);
		fake.host.model.readModel = async () => ({ provider: 'provider', model: 'default' });
		using provider = createProvider(fake);
		const previous = (await provider.list())[0]!;
		fake.sessions[0] = { ...fake.sessions[0]!, model: absent };
		const catalog = await provider.readCatalog('session-1', previous);
		const opened = await provider.subscribe(previous);
		const listed = await provider.list();
		assert.deepEqual([catalog?.model, opened.model, listed[0]?.model], [absent, absent, absent]);
	});
}

for (const selected of [undefined, { provider: 'provider', model: 'manual' }]) {
	test(`only creating a known new Session applies its chosen or default model (${selected?.model ?? 'default'})`, async () => {
		const fake = sessionHost([]);
		const defaultModel = { provider: 'provider', model: 'default' };
		let modelReads = 0;
		fake.host.model.readModel = async () => { modelReads++; return defaultModel; };
		fake.host.session.create = async () => {
			const value = session('created', 'created-thread');
			fake.sessions.push(value);
			return { session: value, agentTree: { roots: [] } };
		};
		fake.host.session.createThread = async () => ({ session: fake.sessions[0]!, threadId: 'created-thread' });
		using provider = createProvider(fake);
		const active = await provider.create('New', { type: 'current' }, selected);
		const persisted = await provider.readCatalog('created', active.session);
		assert.deepEqual({ created: active.session.model, persisted: persisted?.model, modelReads }, { created: selected ?? defaultModel, persisted: undefined, modelReads: selected ? 0 : 1 });
	});
}

for (const selected of [true, false]) {
	test(`model-only catalog changes update the Session without reloading details (selected: ${selected})`, async () => {
		const initialModel = { provider: 'provider', model: 'old' };
		const nextModel = { provider: 'provider', model: 'new' };
		const fake = sessionHost([session('session-1', 'thread-1'), { ...session('session-2', 'thread-2'), model: initialModel }]);
		using service = createManagement(fake);
		await service.initialize();
		if (selected) service.selectThread('session-2', 'thread-2');
		await waitFor(() => service.active?.session.agentTree !== undefined);
		const subscriptions = fake.subscribeCount;
		let changes = 0;
		using listener = service.onDidChange(() => { changes++; });
		fake.sessions[1] = { ...fake.sessions[1]!, model: nextModel };
		fake.emit({ method: 'session/changed', params: { sessionId: 'session-2', agentTreeChanged: false } });
		await waitFor(() => fake.readCatalogCount === 1);
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.deepEqual({ model: service.sessions[1]?.model, active: service.active?.threadId, subscriptions: fake.subscribeCount, changes }, { model: nextModel, active: selected ? 'thread-2' : 'thread-1', subscriptions, changes: 1 });
	});
}

for (const selected of [true, false]) {
	test(`management-only catalog changes propagate without loading details (selected: ${selected})`, async () => {
		const fake = sessionHost([session('session-1', 'thread-1'), session('session-2', 'thread-2')]);
		using service = createManagement(fake);
		await service.initialize();
		if (selected) service.selectThread('session-2', 'thread-2');
		await waitFor(() => service.active?.session.agentTree !== undefined);
		const subscriptions = fake.subscribeCount;
		let changes = 0;
		using listener = service.onDidChange(() => { changes++; });
		const manager = { status: 'working' as const, statusChangedAtUnixMs: 12, activity: { type: 'operation' as const, text: 'Running a tool' }, summary: 'Background work' };
		fake.sessions[1] = { ...fake.sessions[1]!, manager, threads: fake.sessions[1]!.threads.map(thread => ({ ...thread, manager })) };
		fake.emit({ method: 'session/changed', params: { sessionId: 'session-2', agentTreeChanged: false } });
		await waitFor(() => fake.readCatalogCount === 1);
		await new Promise<void>(resolve => setImmediate(resolve));

		const updated = service.sessions[1]!;
		assert.deepEqual(updated, { ...updated, management: manager, chats: updated.chats.map(chat => ({ ...chat, management: manager })) });
		assert.deepEqual({ subscriptions: fake.subscribeCount, changes, active: service.active?.threadId, execution: updated.chats[0]?.executionStatus }, { subscriptions, changes: 1, active: selected ? 'thread-2' : 'thread-1', execution: 'idle' });
	});
}

for (const target of [{ type: 'local' as const, root: '/new' }, { type: 'ssh' as const, host: 'new-host', root: '/old' }, null]) {
	test(`workspace-only catalog changes update the selected Session (${target?.type ?? 'none'})`, async () => {
		const fake = sessionHost([{ ...session('session-1', 'thread-1'), executionTarget: { type: 'local', root: '/old' } }]);
		using service = createManagement(fake);
		await service.initialize();
		await waitFor(() => service.active?.session.agentTree !== undefined);
		const subscriptions = fake.subscribeCount;
		fake.sessions[0] = { ...fake.sessions[0]!, executionTarget: target };
		fake.emit({ method: 'session/changed', params: { sessionId: 'session-1', agentTreeChanged: false } });
		await waitFor(() => fake.readCatalogCount === 1);
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.deepEqual({ workspace: service.active?.session.workspace, subscriptions: fake.subscribeCount }, { workspace: target ? { authorityId: target.type === 'ssh' ? target.host : 'local', root: target.root } : null, subscriptions });
	});
}

test('a default model write preserves durable catalog models and the active facade', async () => {
	const first = { provider: 'provider', model: 'first' };
	const second = { provider: 'provider', model: 'second' };
	const fake = sessionHost([{ ...session('session-1', 'thread-1'), model: first }, { ...session('session-2', 'thread-2'), model: second }]);
	const written: ModelRef[] = [];
	fake.host.model.setModel = async ({ model }) => { written.push(model); };
	using service = createManagement(fake);
	await service.initialize();
	await waitFor(() => service.active?.session.agentTree !== undefined);
	const active = service.active;
	const selected = { provider: 'provider', model: 'default' };
	await service.setModel(selected);
	assert.deepEqual({ models: service.sessions.map(value => value.model), written }, { models: [first, second], written: [selected] });
	assert.equal(service.active, active);
});

test('matching durable Session models do not suppress a default model write', async () => {
	const model = { provider: 'provider', model: 'same' };
	const fake = sessionHost([{ ...session('session-1', 'thread-1'), model }]);
	fake.host.model.readModel = async () => model;
	const written: ModelRef[] = [];
	fake.host.model.setModel = async request => { written.push(request.model); };
	using service = createManagement(fake);
	await service.setModel(model);
	assert.deepEqual(written, [model]);
});

test('reconnection restores background details as well as the selected Session', async () => {
	const fake = sessionHost([session('session-1', 'thread-1'), session('session-2', 'thread-2'), session('session-3', 'thread-3')]);
	using service = createManagement(fake);
	await service.initialize();
	await waitFor(() => service.sessions[0]?.agentTree !== undefined);
	service.selectThread('session-2', 'thread-2');
	await waitFor(() => service.sessions[1]?.agentTree !== undefined);
	fake.setConnectionState('crashed');
	fake.setConnectionState('ready');
	await waitFor(() => fake.subscribeCount === 4 && service.sessions[0]?.agentTree !== undefined && service.sessions[1]?.agentTree !== undefined);
	assert.deepEqual({ active: service.active?.threadId, unopened: service.sessions[2]?.agentTree, catalogSubscriptions: fake.catalogSubscriptionCount }, { active: 'thread-2', unopened: undefined, catalogSubscriptions: 2 });
});

test('a refresh from an old connection cannot revert a newer catalog or suppress later changes', async () => {
	const oldModel = { provider: 'provider', model: 'old' };
	const restoredModel = { provider: 'provider', model: 'restored' };
	const oldManagement = { status: 'working' as const, statusChangedAtUnixMs: 10 };
	const restoredManagement = { status: 'stopped' as const, statusChangedAtUnixMs: 20 };
	const originalSession = session('session-1', 'thread-1');
	const fake = sessionHost([{ ...originalSession, model: oldModel, manager: oldManagement, threads: originalSession.threads.map(thread => ({ ...thread, manager: oldManagement })) }]);
	fake.host.model.readModel = async () => ({ provider: 'provider', model: 'default' });
	using service = createManagement(fake);
	await service.initialize();
	await waitFor(() => service.active?.session.agentTree !== undefined);
	let release!: (result: { session: SessionDto; }) => void;
	const original = fake.host.session.readCatalog;
	fake.host.session.readCatalog = () => new Promise(resolve => { release = resolve; });
	fake.emit({ method: 'session/changed', params: { sessionId: 'session-1', agentTreeChanged: false } });
	await waitFor(() => release !== undefined);
	fake.setConnectionState('crashed');
	fake.sessions[0] = { ...fake.sessions[0]!, title: 'Restored', model: restoredModel, manager: restoredManagement, threads: fake.sessions[0]!.threads.map(thread => ({ ...thread, manager: restoredManagement })) };
	fake.setConnectionState('ready');
	await waitFor(() => service.active?.session.title === 'Restored' && service.active.session.agentTree !== undefined);
	release({ session: { ...fake.sessions[0]!, title: 'Stale', model: oldModel, manager: oldManagement, threads: fake.sessions[0]!.threads.map(thread => ({ ...thread, manager: oldManagement })) } });
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.deepEqual({ title: service.active?.session.title, model: service.active?.session.model, management: service.active?.session.management, branch: service.active?.session.chats[0]?.management }, { title: 'Restored', model: restoredModel, management: restoredManagement, branch: restoredManagement });
	fake.host.session.readCatalog = original;
	fake.sessions[0] = { ...fake.sessions[0]!, title: 'Changed again', model: undefined };
	fake.emit({ method: 'session/changed', params: { sessionId: 'session-1', agentTreeChanged: false } });
	await waitFor(() => service.active?.session.title === 'Changed again');
	assert.deepEqual({ title: service.active?.session.title, model: service.active?.session.model }, { title: 'Changed again', model: undefined });
	assert.equal(service.state, 'ready');
});

test('reconnection restores catalog and loaded details while retaining selection and drafts', async () => {
	const fake = sessionHost([session('session-1', 'thread-1'), session('session-2', 'thread-2')]);
	using service = createManagement(fake);
	await service.initialize();
	service.selectThread('session-2', 'thread-2');
	await waitFor(() => fake.subscribeCount === 2 && service.active?.session.agentTree !== undefined);
	const draft = service.createUntitledSession('Keep this draft');
	service.setUntitledSessionModel(draft.untitledSessionId, { provider: 'provider', model: 'chosen' });
	service.selectThread('session-2', 'thread-2');
	const savedDraft = service.untitledSessions[0];

	fake.setConnectionState('crashed');
	fake.sessions.splice(0, 1, session('session-3', 'thread-3'));
	fake.sessions[1] = { ...fake.sessions[1]!, title: 'Renamed while disconnected' };
	fake.setConnectionState('starting');
	fake.setConnectionState('initializing');
	assert.equal(fake.catalogSubscriptionCount, 1);
	fake.setConnectionState('ready');
	await waitFor(() => service.state === 'ready' && service.active?.session.agentTree !== undefined && fake.catalogSubscriptionCount === 2);

	assert.deepEqual({
		sessions: service.sessions.map(({ sessionId, title }) => ({ sessionId, title })),
		active: service.active?.threadId,
		draft: service.untitledSessions[0],
		catalogSubscribed: fake.catalogSubscribed,
		subscriptions: fake.subscribeCount,
	}, {
		sessions: [{ sessionId: 'session-3', title: 'Session session-3' }, { sessionId: 'session-2', title: 'Renamed while disconnected' }],
		active: 'thread-2', draft: savedDraft, catalogSubscribed: true, subscriptions: 3,
	});
	fake.sessions.push(session('session-4', 'thread-4'));
	fake.emit({ method: 'session/changed', params: { sessionId: 'session-4', agentTreeChanged: false } });
	await waitFor(() => service.sessions.length === 3);
	assert.equal(service.active?.threadId, 'thread-2');
	service.dispose();
	assert.equal(fake.connectionListeners.size, 0);
});

test('reconnection preserves the active untitled Session and its manually selected model', async () => {
	const fake = sessionHost([session('session-1', 'thread-1')]);
	using service = createManagement(fake);
	await service.initialize();
	const draft = service.createUntitledSession('Unsent');
	service.setUntitledSessionModel(draft.untitledSessionId, { provider: 'provider', model: 'chosen' });
	const selected = service.activeUntitledSession;
	fake.setConnectionState('crashed');
	fake.sessions.unshift(session('session-2', 'thread-2'));
	fake.setConnectionState('ready');
	await waitFor(() => service.state === 'ready' && service.sessions.length === 2);
	assert.equal(service.activeUntitledSession, selected);
});

test('a catalog result from an old connection cannot replace the restored catalog', async () => {
	const fake = sessionHost([]);
	let release!: (result: { sessions: SessionDto[]; }) => void;
	const original = fake.host.session.subscribeCatalog;
	let first = true;
	fake.host.session.subscribeCatalog = () => {
		if (!first) return original();
		first = false;
		return new Promise(resolve => { release = resolve; });
	};
	using service = createManagement(fake);
	const initial = service.initialize();
	fake.setConnectionState('crashed');
	const restoredModel = { provider: 'provider', model: 'restored' };
	fake.sessions.push({ ...session('fresh', 'fresh-thread'), model: restoredModel });
	fake.setConnectionState('ready');
	await waitFor(() => service.active?.threadId === 'fresh-thread' && service.active.session.agentTree !== undefined);
	release({ sessions: [{ ...session('stale', 'stale-thread'), model: { provider: 'provider', model: 'stale' } }] });
	await initial;
	assert.deepEqual({ ids: service.sessions.map(session => session.sessionId), model: service.active?.session.model, state: service.state, error: service.error }, { ids: ['fresh'], model: restoredModel, state: 'ready', error: undefined });
});

for (const outcome of ['success', 'failure']) {
	test(`late detail loading cannot overwrite or release a newer connection subscription (${outcome})`, async () => {
		const fake = sessionHost([session('session-1', 'thread-1')]);
		const original = fake.host.session.subscribe;
		let release!: () => void;
		let fail!: (error: Error) => void;
		let started!: () => void;
		const held = new Promise<void>((resolve, reject) => { release = resolve; fail = reject; });
		const requested = new Promise<void>(resolve => { started = resolve; });
		let first = true;
		fake.host.session.subscribe = async params => {
			const result = await original(params);
			if (first) {
				first = false;
				started();
				await held;
			}
			return result;
		};
		using service = createManagement(fake);
		await service.initialize();
		await requested;
		fake.setConnectionState('crashed');
		fake.sessions[0] = { ...fake.sessions[0]!, title: 'Fresh detail' };
		fake.setConnectionState('ready');
		await waitFor(() => service.active?.session.title === 'Fresh detail' && service.active.session.agentTree !== undefined);
		const current = service.sessions[0];
		if (outcome === 'failure') fail(new Error('Old connection failed after recovery'));
		else release();
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.equal(service.sessions[0], current);
		assert.equal(fake.subscribeCount, 2);
		assert.equal(service.error, undefined);
	});
}

test('a failed catalog restoration retries on the next ready connection', async () => {
	const fake = sessionHost([session('session-1', 'thread-1')]);
	using service = createManagement(fake);
	await service.initialize();
	const original = fake.host.session.subscribeCatalog;
	fake.host.session.subscribeCatalog = async () => { throw new Error('Catalog unavailable'); };
	fake.setConnectionState('crashed');
	fake.setConnectionState('ready');
	await waitFor(() => service.state === 'error');
	assert.equal(service.error, 'Catalog unavailable');
	fake.host.session.subscribeCatalog = original;
	fake.setConnectionState('crashed');
	fake.setConnectionState('ready');
	await waitFor(() => service.state === 'ready' && service.active?.session.agentTree !== undefined);
	assert.equal(fake.catalogSubscriptionCount, 2);
	assert.equal(service.error, undefined);
});

function createProvider(fake: ReturnType<typeof sessionHost>, omitted?: unknown): AppServerSessionsProvider {
	using services = new InstantiationService();
	if (omitted !== IAppServerApi) { services.registerInstance(IAppServerApi, fake.appServer); }
	if (omitted !== ISessionApi) { services.registerInstance(ISessionApi, fake.host.session); }
	if (omitted !== IModelApi) { services.registerInstance(IModelApi, fake.host.model); }
	if (omitted !== ITurnApi) { services.registerInstance(ITurnApi, fake.host.turn); }
	if (omitted !== IServerEventApi) { services.registerInstance(IServerEventApi, fake.host.events); }
	return services.createInstance(AppServerSessionsProvider, { workspace: fake.host.workspace, selectWorkspace: fake.host.selectWorkspace });
}

function createManagement(fake: ReturnType<typeof sessionHost>): SessionsManagementService {
	return new SessionsManagementService(createProvider(fake));
}

test("management initializes the catalog from provider-owned Session mapping", async () => {
	const fake = sessionHost([session("session-1", "thread-1"), session("session-2", "thread-2")]);
	using service = createManagement(fake);

	await service.initialize();

	assert.equal(service.sessions.length, 2);
	assert.equal(service.active?.session.sessionId, "session-1");
	assert.equal(service.active?.threadId, "thread-1");
	assert.equal(service.sessions[0]?.chats[0]?.origin.type, "root");
	assert.equal(fake.subscribeCount, 1);
	assert.equal(fake.catalogSubscriptionCount, 1);
	assert.equal(service.sessions[1]?.agentTree, undefined);
});

test("an untitled Session keeps its selected directory when the Agents window changes workspace", async () => {
	let selected = { type: 'local' as const, root: '/work/first' };
	const fake = sessionHost([], undefined, () => selected);
	const created: unknown[] = [];
	fake.host.session.create = async params => {
		created.push(params.executionTarget);
		const value = session(`session-${created.length}`, `thread-${created.length}`);
		fake.sessions.push(value);
		return { session: value, agentTree: { roots: [] } };
	};
	fake.host.session.createThread = async params => ({ session: fake.sessions.find(candidate => candidate.sessionId === params.sessionId)!, threadId: `thread-${created.length}` });
	using service = createManagement(fake);
	const first = service.createUntitledSession();
	selected = { type: 'local', root: '/work/second' };
	const second = service.createUntitledSession();
	await service.materializeUntitledSession(first.untitledSessionId);
	await service.materializeUntitledSession(second.untitledSessionId);
	assert.deepEqual(created, [
		{ type: 'local', root: '/work/first' },
		{ type: 'local', root: '/work/second' },
	]);
});

test('restoring an untitled identity keeps its workspace, model and Agent without creating a backend Session', () => {
	const fake = sessionHost([]);
	using service = createManagement(fake);
	const draft: IUntitledChatSession = {
		untitledSessionId: 'saved-draft', title: 'Saved task', model: { provider: 'provider', model: 'model' }, modelSelectionKind: 'manual',
		agent: { name: 'worker', description: 'Implementation', sourceId: 'workspace-agent' }, workspace: { type: 'ssh', host: 'build', root: '/work/project' },
	};
	service.restoreUntitledSession(draft);
	service.selectUntitledSession(draft.untitledSessionId);
	assert.deepEqual({ active: service.activeUntitledSession, sessions: service.sessions, backend: fake.sessions }, { active: draft, sessions: [], backend: [] });
});

test("a multi-root Workspace sends the selected folder as the execution target", async () => {
	const folders = [
		{ label: 'first', target: { type: 'local' as const, root: '/work/first' } },
		{ label: 'second', target: { type: 'ssh' as const, host: 'build', root: '/work/second' } },
	];
	const fake = sessionHost([], undefined, () => ({ type: 'multiple', folders }));
	let receivedFolders: unknown;
	fake.host.selectWorkspace = async choices => { receivedFolders = choices; return choices[1]!.target; };
	let executionTarget: unknown;
	fake.host.session.create = async params => {
		executionTarget = params.executionTarget;
		const value = { ...session('created', 'thread'), executionTarget: params.executionTarget };
		fake.sessions.push(value);
		return { session: value, agentTree: { roots: [] } };
	};
	fake.host.session.createThread = async () => ({ session: fake.sessions[0]!, threadId: 'thread' });
	using service = createManagement(fake);
	const draft = service.createUntitledSession();
	const active = await service.materializeUntitledSession(draft.untitledSessionId);
	assert.deepEqual(receivedFolders, folders);
	assert.deepEqual(executionTarget, folders[1]!.target);
	assert.deepEqual(active.session.workspace, { authorityId: 'build', root: '/work/second' });
});

test("closing the multi-root folder picker leaves the draft ready", async () => {
	const fake = sessionHost([], undefined, () => ({ type: 'multiple', folders: [{ label: 'first', target: { type: 'local', root: '/work/first' } }] }));
	let created = false;
	fake.host.session.create = async () => { created = true; throw new Error('unexpected'); };
	using service = createManagement(fake);
	const draft = service.createUntitledSession();
	await assert.rejects(service.materializeUntitledSession(draft.untitledSessionId), isCancellationError);
	assert.equal(created, false);
	assert.equal(service.state, 'ready');
});

test("Session list becomes ready while the opened conversation is still loading", async () => {
	const fake = sessionHost([session("session-1", "thread-1"), session("session-2", "thread-2")]);
	let release!: () => void;
	const held = new Promise<void>(resolve => { release = resolve; });
	const subscribe = fake.host.session.subscribe.bind(fake.host.session);
	fake.host.session.subscribe = async params => {
		await held;
		return subscribe(params);
	};
	using service = createManagement(fake);

	await service.initialize();
	assert.equal(service.state, "ready");
	assert.equal(service.sessions.length, 2);
	assert.equal(fake.subscribeCount, 0);

	release();
	await waitFor(() => service.active?.session.agentTree !== undefined);
});

test("opening a background-created conversation reads and subscribes it without reloading the window", async () => {
	const fake = sessionHost([]);
	using service = createManagement(fake);
	await service.initialize();
	fake.sessions.push(session("automation-session", "automation-thread"));

	await service.openThread("automation-session", "automation-thread");

	assert.equal(service.active?.threadId, "automation-thread");
	assert.equal(service.sessions.length, 1);
	assert.equal(fake.subscribeCount, 1);
	assert.equal(fake.listCount, 0);
	assert.equal(fake.readCatalogCount, 1);
});

test("session/changed adds a conversation created by another client without changing selection", async () => {
	const fake = sessionHost([session("session-1", "thread-1")]);
	using service = createManagement(fake);
	await service.initialize();
	fake.sessions.push(session("automation-session", "automation-thread"));
	fake.emit({ method: "session/changed", params: { sessionId: "automation-session", agentTreeChanged: false } });
	await waitFor(() => service.sessions.length === 2);

	assert.equal(service.sessions[0]?.sessionId, "automation-session");
	assert.equal(service.active?.threadId, "thread-1");
	assert.equal(fake.subscribeCount, 1);
});

test("selecting a catalog-only Session loads its details on demand", async () => {
	const fake = sessionHost([session("session-1", "thread-1"), session("session-2", "thread-2")]);
	using service = createManagement(fake);
	await service.initialize();

	service.selectThread("session-2", "thread-2");
	await waitFor(() => fake.subscribeCount === 2 && service.sessions[1]?.agentTree !== undefined);

	assert.equal(service.active?.threadId, "thread-2");
});

test("catalog invalidation during detail loading keeps the selected Session hydrated", async () => {
	const fake = sessionHost([session("session-1", "thread-1"), session("session-2", "thread-2")]);
	using service = createManagement(fake);
	await service.initialize();

	service.selectThread("session-2", "thread-2");
	fake.sessions[1] = { ...fake.sessions[1]!, title: "Updated while opening" };
	fake.emit({ method: "session/changed", params: { sessionId: "session-2", agentTreeChanged: false } });
	await waitFor(() => service.sessions[1]?.title === "Updated while opening" && service.sessions[1]?.agentTree !== undefined);

	assert.equal(service.active?.threadId, "thread-2");
});

test("catalog invalidation refreshes a background Session without loading its conversation", async () => {
	const fake = sessionHost([session("session-1", "thread-1"), session("session-2", "thread-2")]);
	using service = createManagement(fake);
	await service.initialize();
	fake.sessions[1] = { ...fake.sessions[1]!, title: "Renamed in background", threads: [{ ...fake.sessions[1]!.threads[0]!, title: "Renamed Thread" }] };

	fake.emit({ method: "session/changed", params: { sessionId: "session-2", agentTreeChanged: false } });
	await waitFor(() => service.sessions[1]?.title === "Renamed in background");

	assert.equal(fake.subscribeCount, 1);
	assert.equal(service.sessions[1]?.chats[0]?.title, "Renamed Thread");
});

test("session/deleted removes an unselected Session from the catalog", async () => {
	const fake = sessionHost([session("session-1", "thread-1"), session("session-2", "thread-2")]);
	using service = createManagement(fake);
	await service.initialize();
	fake.sessions.splice(1, 1);

	fake.emit({ method: "session/deleted", params: { sessionId: "session-2" } });
	await waitFor(() => service.sessions.length === 1);

	assert.equal(service.sessions[0]?.sessionId, "session-1");
});

test("deleting the selected Session opens the next catalog Session", async () => {
	const fake = sessionHost([session("session-1", "thread-1"), session("session-2", "thread-2")]);
	using service = createManagement(fake);
	await service.initialize();
	fake.sessions.splice(0, 1);

	fake.emit({ method: "session/deleted", params: { sessionId: "session-1" } });
	await waitFor(() => service.active?.threadId === "thread-2" && service.active.session.agentTree !== undefined);

	assert.equal(fake.subscribeCount, 2);
});

test("session/changed invalidates the frontend Session without inventing a Session sequence", async () => {
	const fake = sessionHost([session("session-1", "thread-1")]);
	using service = createManagement(fake);
	await service.initialize();
	const subscriptions = fake.subscribeCount;

	fake.sessions[0] = { ...fake.sessions[0]!, title: "Renamed" };
	fake.emit({ method: "session/changed", params: { sessionId: "session-1", agentTreeChanged: false } });
	await waitFor(() => service.sessions[0]?.title === "Renamed");

	assert.equal(fake.subscribeCount, subscriptions);
	assert.equal(fake.readCatalogCount, 1);
	assert.equal(service.sessions[0]?.title, "Renamed");
});

test("ordinary Thread events leave the opened conversation and rendered list intact", async () => {
	const fake = sessionHost([session("session-1", "thread-1")]);
	using service = createManagement(fake);
	await service.initialize();
	await waitFor(() => service.active?.session.agentTree !== undefined);
	const original = service.sessions[0];
	const subscriptions = fake.subscribeCount;
	let renders = 0;
	using listener = service.onDidChange(() => { renders += 1; });

	fake.emit({ method: "session/changed", params: { sessionId: "session-1", agentTreeChanged: false } });
	await waitFor(() => fake.readCatalogCount === 1);
	await Promise.resolve();

	assert.equal(fake.listCount, 0);
	assert.equal(fake.subscribeCount, subscriptions);
	assert.equal(service.sessions[0], original);
	assert.equal(renders, 0);
});

test("a new Thread in the opened Session refreshes its subscription", async () => {
	const fake = sessionHost([session("session-1", "thread-1")]);
	using service = createManagement(fake);
	await service.initialize();
	await waitFor(() => service.active?.session.agentTree !== undefined);
	const subscriptions = fake.subscribeCount;
	const current = fake.sessions[0]!;
	fake.sessions[0] = { ...current, threads: [...current.threads, { ...current.threads[0]!, threadId: "thread-2" }] };

	fake.emit({ method: "session/changed", params: { sessionId: "session-1", agentTreeChanged: false } });
	await waitFor(() => fake.subscribeCount === subscriptions + 1 && service.sessions[0]?.chats.length === 2);

	assert.equal(fake.listCount, 0);
});

test("the backend marks Agent tree changes for the opened Session", async () => {
	const fake = sessionHost([session("session-1", "thread-1")]);
	using service = createManagement(fake);
	await service.initialize();
	const subscriptions = fake.subscribeCount;

	fake.emit({ method: "session/changed", params: { sessionId: "session-1", agentTreeChanged: true } });
	await waitFor(() => fake.subscribeCount === subscriptions + 1);

	assert.equal(service.sessions[0]?.sessionId, "session-1");
	assert.equal(service.sessions[0]?.chats[0]?.threadId, "thread-1");
});

test("archive sends only the Session grouping identity", async () => {
	const fake = sessionHost([session("session-1", "thread-1"), session("session-2", "thread-2")]);
	using service = createManagement(fake);
	await service.initialize();

	await service.archiveSession("session-1");

	assert.deepEqual(fake.archiveRequests, [{ commandId: fake.archiveRequests[0]?.commandId, sessionId: "session-1" }]);
	assert.equal(service.sessions.find(candidate => candidate.sessionId === "session-1")?.status, "archived");
	assert.equal(service.active?.session.sessionId, "session-2");
});

test("interrupt reads the current Thread sequence before sending the command", async () => {
	const tree = agentNode();
	const fake = sessionHost([session("session-1", "thread-1")], tree);
	using service = createManagement(fake);
	await service.initialize();

	await service.interruptThread("session-1", "thread-1");

	assert.deepEqual(fake.interruptRequests.map(({ sessionId, threadId, turnId, expectedSequence }) => ({ sessionId, threadId, turnId, expectedSequence })), [{
		sessionId: "session-1",
		threadId: "thread-1",
		turnId: "turn-1",
		expectedSequence: 7,
	}]);
});

function session(sessionId: string, threadId: string): SessionDto {
	return {
		sessionId,
		title: `Session ${sessionId}`,
		status: "active",
		manager: { status: "idle", statusChangedAtUnixMs: 0 },
		threads: [{
			threadId,
			title: `Thread ${threadId}`,
			createdAtUnixMs: 0,
			completedTurnDurationMs: 0,
			usage: emptyUsage(),
			status: "active",
		}],
	};
}

function emptyUsage(): ModelUsageSummary {
	const total = { reported: 0, complete: true };
	return { modelInvocations: 0, inputTokens: total, outputTokens: total, cachedInputTokens: total, cacheWriteInputTokens: total, reasoningTokens: total };
}

function agentNode(): AgentTreeNodeProjection {
	const total = { reported: 0, complete: true };
	return {
		threadId: "thread-1",
		threadSequence: 7,
		title: "Main",
		executionStatus: "running",
		currentTurnId: "turn-1",
		usage: {
			modelInvocations: 0,
			inputTokens: total,
			outputTokens: total,
			cachedInputTokens: total,
			cacheWriteInputTokens: total,
			reasoningTokens: total,
		},
		children: [],
	};
}

function sessionHost(initial: SessionDto[], tree?: AgentTreeNodeProjection, workspace: () => SessionWorkspaceSelection = () => ({ type: 'current' })) {
	const connectionListeners = new Set<(state: AppServerConnectionState) => void>();
	let connectionState: AppServerConnectionState = 'ready';
	let connectionGeneration = 1;
	let catalogSubscribed = false;
	const appServer: IAppServerApi = {
		get connectionGeneration() { return connectionGeneration; },
		getConnectionState: async () => connectionState,
		getSlashCommands: async () => [],
		onConnectionState: listener => { connectionListeners.add(listener); return { dispose: () => { connectionListeners.delete(listener); } }; },
	};
	const listeners = new Set<(event: ServerNotification) => void>();
	const sessions = [...initial];
	const agentTree = { roots: tree ? [tree] : [] };
	const archiveRequests: Parameters<ISessionApi["archive"]>[0][] = [];
	const interruptRequests: Parameters<ITurnApi["interrupt"]>[0][] = [];
	let subscribeCount = 0;
	let catalogSubscriptionCount = 0;
	let listCount = 0;
	let readCatalogCount = 0;
	const api: ISessionApi = {
		async create() { throw new Error("Not used"); },
		async listAgents() { return { agents: [] }; },
		async read({ sessionId }) { return { session: sessions.find(candidate => candidate.sessionId === sessionId)!, agentTree }; },
		async readCatalog({ sessionId }) { readCatalogCount += 1; return { session: sessions.find(candidate => candidate.sessionId === sessionId) ?? null }; },
		async list() { listCount += 1; return { sessions }; },
		async subscribeCatalog() { catalogSubscriptionCount += 1; catalogSubscribed = true; return { sessions }; },
		async unsubscribeCatalog() { catalogSubscribed = false; },
		async subscribe({ sessionId }) {
			subscribeCount += 1;
			const value = sessions.find(candidate => candidate.sessionId === sessionId)!;
			return {
				session: value,
				threadProjections: value.threads.map(thread => threadProjection(sessionId, thread.threadId)),
				agentTree,
			};
		},
		async unsubscribe() { },
		async createThread() { throw new Error("Not used"); },
		async forkThread() { throw new Error("Not used"); },
		async archive(params) {
			archiveRequests.push(params);
			const index = sessions.findIndex(candidate => candidate.sessionId === params.sessionId);
			sessions[index] = { ...sessions[index]!, status: "archived" };
			return { session: sessions[index]!, agentTree };
		},
		async stop() { throw new Error("Not used"); },
	};
	const turn: ITurnApi = {
		enqueue: async () => { throw new Error("Queue is unavailable in this fixture"); },
		listQueued: async () => ({ messages: [] }),
		async consultAdvisor() { throw new Error("Not used"); },
		async start() { throw new Error("Not used"); },
		async compact() { throw new Error("Not used"); },
		async steer() { throw new Error("Not used"); },
		async interrupt(params) {
			interruptRequests.push(params);
			return { threadId: params.threadId, sequence: params.expectedSequence + 1, turnId: params.turnId };
		},
		async resolveInteraction() { throw new Error("Not used"); },
	};
	const events: IServerEventApi = {
		subscribe(listener) {
			listeners.add(listener);
			return { dispose: () => listeners.delete(listener) };
		},
	};
	return {
		appServer,
		connectionListeners,
		get catalogSubscribed() { return catalogSubscribed; },
		setConnectionState(state: AppServerConnectionState): void {
			connectionState = state;
			if (state === 'ready') { connectionGeneration++; }
			if (state !== 'ready') catalogSubscribed = false;
			for (const listener of connectionListeners) listener(state);
		},
		host: { session: api, model: { ...createDisconnectedRendererApi().model, readModel: async (): Promise<ModelRef | null> => null }, turn, events, workspace, selectWorkspace: async (_folders: readonly { readonly label: string; readonly target: SessionExecutionTarget; }[]): Promise<SessionExecutionTarget | undefined> => undefined },
		sessions,
		archiveRequests,
		interruptRequests,
		get subscribeCount() { return subscribeCount; },
		get catalogSubscriptionCount() { return catalogSubscriptionCount; },
		get listCount() { return listCount; },
		get readCatalogCount() { return readCatalogCount; },
		emit(event: ServerNotification) { for (const listener of listeners) listener(event); },
	};
}

function threadProjection(sessionId: string, threadId: string): SessionThreadProjection {
	return {
		thread: {
			advisor: { type: "default" },
			agentId: "agent-1",
			origin: { type: "root" },
			referenceCost: { knownAmounts: [], complete: true },
			sessionId,
			threadId,
			title: `Thread ${threadId}`,
			status: "active",
			sequence: 1,
			usage: {
				modelInvocations: 0,
				inputTokens: { reported: 0, complete: true },
				outputTokens: { reported: 0, complete: true },
				cachedInputTokens: { reported: 0, complete: true },
				cacheWriteInputTokens: { reported: 0, complete: true },
				reasoningTokens: { reported: 0, complete: true },
			},
			turns: [],
		},
		transcript: { sessionId, threadId, durableSequence: 1, revision: 0, entries: [] },
		updates: [],
	};
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let index = 0; index < 50; index += 1) {
		if (predicate()) return;
		await new Promise(resolve => setTimeout(resolve, 0));
	}
	throw new Error("Condition was not met");
}
