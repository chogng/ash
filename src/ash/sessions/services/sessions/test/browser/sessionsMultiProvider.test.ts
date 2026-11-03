import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { JSDOM } from 'jsdom';
import { BrowserStorageService } from '../../../../../workbench/services/storage/browser/storageService.js';
import { SessionsRecentWorkspacesService } from '../../browser/sessionsRecentWorkspacesService.js';
import { SessionsManagementService } from '../../browser/sessionsManagementService.js';
import { SessionsProvidersService } from '../../browser/sessionsProvidersService.js';
import { sessionIdentity, parseSessionIdentity } from '../../common/sessionIdentity.js';
import type { ISession, IActiveSessionThread, SessionWorkspaceSelection } from '../../common/session.js';
import type { ISessionsProvider } from '../../common/sessionsProvider.js';

ensureNoDisposablesAreLeakedInTestSuite();
class Provider extends Disposable implements ISessionsProvider {
	readonly order = 0;
	readonly label: string;
	private readonly catalog = this._register(new Emitter<void>());
	readonly onDidChangeCatalog = this.catalog.event;
	readonly sessionChanges = this._register(new Emitter<{ readonly sessionId: string; readonly detailChanged: boolean; }>());
	readonly onDidChangeSession = this.sessionChanges.event;
	items: ISession[] = [{ sessionId: 'same', title: 'Same ID', status: 'active', nextApprovalMode: 'manual', chats: [{ threadId: 'thread', status: 'active', origin: { type: 'root' } }], agentTree: [] }];
	readonly calls: string[] = [];
	pending: DeferredPromise<readonly ISession[]> | undefined;
	constructor(readonly id: string) { super(); this.label = id; }
	async list(): Promise<readonly ISession[]> { return this.pending?.p ?? this.items; }
	async listAgents() { return []; }
	async readCatalog(id: string) { this.calls.push(`read:${id}`); return this.items.find(session => session.sessionId === id); }
	async subscribe(session: ISession) { this.calls.push(`subscribe:${session.sessionId}`); return session; }
	async unsubscribe(id: string) { this.calls.push(`unsubscribe:${id}`); }
	currentWorkspace(): SessionWorkspaceSelection { return this.id === 'primary' ? { type: 'local', root: '/same' } : { type: 'ssh', host: 'remote', root: '/same' }; }
	async create(title: string, workspace: SessionWorkspaceSelection): Promise<IActiveSessionThread> {
		this.calls.push(`create:${workspace.type}`);
		return { session: { ...this.items[0]!, title }, threadId: 'thread' };
	}
	async setModel() { this.calls.push('model'); }
	async renameSession(session: ISession, title: string) { this.calls.push(`rename:${session.sessionId}`); return { ...session, title }; }
	async archive(session: ISession) { this.calls.push(`archive:${session.sessionId}`); return { ...session, status: 'archived' as const }; }
	async restore(session: ISession) { return { ...session, status: 'active' as const }; }
	async stop(session: ISession) { return this.archive(session); }
	async deleteSession(session: ISession) { this.calls.push(`delete:${session.sessionId}`); }
	async interrupt(session: ISession, threadId: string) { this.calls.push(`interrupt:${session.sessionId}:${threadId}`); }
}

test('equal backend Session and Thread IDs retain separate owners for selection and mutations', async () => {
	using registry = new SessionsProvidersService();
	using primary = new Provider('primary');
	using remote = new Provider('remote');
	using primaryRegistration = registry.registerProvider(primary);
	using remoteRegistration = registry.registerProvider(remote);
	using management = new SessionsManagementService(primary.id, registry);
	await management.initialize();
	const remoteId = sessionIdentity(remote.id, 'same', primary.id);
	const remoteThread = sessionIdentity(remote.id, 'thread', primary.id);
	assert.deepEqual(management.sessions.map(session => session.sessionId), ['same', remoteId]);
	await management.openThread(remoteId, remoteThread);
	await management.renameSession(remoteId, 'Remote title');
	await management.interruptThread(remoteId, remoteThread);
	assert.equal(management.active?.session.sessionId, remoteId);
	assert.equal(management.sessions[0]!.title, 'Same ID');
	assert.ok(remote.calls.includes('rename:same'));
	assert.ok(remote.calls.includes('interrupt:same:thread'));
	assert.ok(!primary.calls.some(call => call.startsWith('rename:') || call.startsWith('interrupt:')));
});

test('a remote draft retains its provider through materialization after another host is selected', async () => {
	using registry = new SessionsProvidersService();
	using primary = new Provider('primary');
	using primaryRegistration = registry.registerProvider(primary);
	using remote = new Provider('remote');
	using registration = registry.registerProvider(remote);
	using management = new SessionsManagementService(primary.id, registry);
	await management.initialize();
	const remoteDraft = management.createUntitledSession('Remote draft', undefined, remote.id);
	management.createUntitledSession('Local draft', undefined, primary.id);
	const created = await management.materializeUntitledSession(remoteDraft.untitledSessionId);
	assert.equal(created.session.sessionId, sessionIdentity(remote.id, 'same', primary.id));
	assert.deepEqual(remote.calls.filter(call => call.startsWith('create:')), ['create:ssh']);
	assert.deepEqual(primary.calls.filter(call => call.startsWith('create:')), []);
});

test('unregistering a host rejects its old identity and cannot expose an equal local Session', async () => {
	using registry = new SessionsProvidersService();
	using primary = new Provider('primary');
	using primaryRegistration = registry.registerProvider(primary);
	using remote = new Provider('remote');
	using registration = registry.registerProvider(remote);
	using management = new SessionsManagementService(primary.id, registry);
	await management.initialize();
	const remoteId = sessionIdentity(remote.id, 'same', primary.id);
	registration.dispose();
	await management.initialize();
	await assert.rejects(management.openThread(remoteId, sessionIdentity(remote.id, 'thread', primary.id)));
	assert.deepEqual(management.sessions.map(session => session.sessionId), ['same']);
	assert.ok(!primary.calls.includes(`read:${remoteId}`));
	assert.ok(!primary.calls.includes('read:same'));
});

test('a late catalog from a removed provider cannot reinsert its Sessions', async () => {
	using registry = new SessionsProvidersService();
	using primary = new Provider('primary');
	using primaryRegistration = registry.registerProvider(primary);
	using remote = new Provider('remote');
	remote.pending = new DeferredPromise<readonly ISession[]>();
	using registration = registry.registerProvider(remote);
	using management = new SessionsManagementService(primary.id, registry);
	const loading = management.initialize();
	registration.dispose();
	await remote.pending.complete(remote.items);
	await loading;
	await management.initialize();
	assert.deepEqual(management.sessions.map(session => session.sessionId), ['same']);
});

test('qualified identity round-trips opaque backend IDs and rejects noncanonical aliases', () => {
	const id = sessionIdentity('ssh:host/one', 'opaque:/会话%id', 'primary');
	assert.deepEqual(parseSessionIdentity(id, 'primary'), { providerId: 'ssh:host/one', backendSessionId: 'opaque:/会话%id' });
	assert.throws(() => parseSessionIdentity('ash-session:%72emote/same', 'primary'));
});

test('removing the default provider retires bare IDs and keeps the remaining provider qualified', async () => {
	using registry = new SessionsProvidersService();
	using primary = new Provider('primary');
	using remote = new Provider('remote');
	using primaryRegistration = registry.registerProvider(primary);
	using remoteRegistration = registry.registerProvider(remote);
	using management = new SessionsManagementService(primary.id, registry);
	await management.initialize();
	primary.pending = new DeferredPromise<readonly ISession[]>();
	const refreshing = management.refresh();
	primary.sessionChanges.fire({ sessionId: 'same', detailChanged: true });

	primaryRegistration.dispose();
	await management.initialize();
	await primary.pending.complete(primary.items);
	await refreshing;
	assert.equal(management.state, 'ready');
	const remoteId = sessionIdentity(remote.id, 'same', primary.id);
	assert.deepEqual(management.sessions.map(session => session.sessionId), [remoteId]);
	await assert.rejects(management.openThread('same', 'thread'), /unavailable: primary/);
	assert.ok(!primary.calls.includes('read:same'));
});

test('new drafts restore only a selection from their own host', () => {
	using registry = new SessionsProvidersService();
	using primary = new Provider('primary');
	using remote = new Provider('remote');
	using primaryRegistration = registry.registerProvider(primary);
	using remoteRegistration = registry.registerProvider(remote);
	const dom = new JSDOM('', { url: 'https://ash.test' });
	using browser = { [Symbol.dispose]: () => dom.window.close() };
	using storage = new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'recent-workspace-test' });
	const recent = new SessionsRecentWorkspacesService(storage);
	const localFolder = { type: 'local', root: '/local-folder' } as const;
	const remoteFolder = { type: 'ssh', host: 'remote', root: '/remote-folder' } as const;
	recent.setSelected(primary.id, localFolder);
	recent.setSelected(remote.id, remoteFolder);
	using management = new SessionsManagementService(primary.id, registry, storage);
	assert.deepEqual(management.createUntitledSession().workspace, localFolder);
	assert.deepEqual(management.createUntitledSession(undefined, undefined, remote.id).workspace, remoteFolder);
	assert.deepEqual(management.createUntitledSession(undefined, undefined, primary.id, false).workspace, primary.currentWorkspace());
	recent.setSelected(remote.id, { ...remoteFolder, host: 'another-host' });
	assert.deepEqual(management.createUntitledSession(undefined, undefined, remote.id).workspace, remote.currentWorkspace());
});
