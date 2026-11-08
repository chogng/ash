import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
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
import { IProjectService, type Project } from '../../../../../platform/projects/common/projectService.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { ARCHIVE_PROJECT_COMMAND } from '../../../../contrib/projects/browser/projectsActions.js';
import { ISessionsManagementService } from '../../common/sessionsManagement.js';

ensureNoDisposablesAreLeakedInTestSuite();
class Provider extends Disposable implements ISessionsProvider {
	readonly order = 0;
	readonly label: string;
	private readonly catalog = this._register(new Emitter<void>());
	readonly onDidChangeCatalog = this.catalog.event;
	readonly sessionChanges = this._register(new Emitter<{ readonly sessionId: string; readonly detailChanged: boolean; }>());
	readonly onDidChangeSession = this.sessionChanges.event;
	items: ISession[] = [{ sessionId: 'same', kind: 'code' as const, title: 'Same ID', status: 'active', nextApprovalMode: 'manual', chats: [{ threadId: 'thread', status: 'active', origin: { type: 'root' } }], agentTree: [] }];
	readonly calls: string[] = [];
	pending: DeferredPromise<readonly ISession[]> | undefined;
	listError: Error | undefined;
	constructor(readonly id: string) { super(); this.label = id; }
	async list(): Promise<readonly ISession[]> {
		if (this.listError) throw this.listError;
		return this.pending?.p ?? this.items;
	}
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

test('project archive retries after a partial catalog and only requires the primary host', async () => {
	using registry = new SessionsProvidersService();
	using primary = new Provider('primary');
	using remote = new Provider('remote');
	using primaryRegistration = registry.registerProvider(primary);
	using remoteRegistration = registry.registerProvider(remote);
	using management = new SessionsManagementService(primary.id, registry);
	let project: Project = { id: 'project', name: 'Project', description: '', archived: false, revision: 1, materials: [], sessionIds: ['same'], createdAtMs: 1, updatedAtMs: 1, sessionCount: 1 };
	const projects = {
		read: async () => project,
		archive: async () => {
			assert.equal(management.sessions.find(session => session.sessionId === 'same')?.status, 'archived');
			return project = { ...project, archived: true };
		},
	} as unknown as IProjectService;
	using services = new InstantiationService(new ServiceCollection(
		[IProjectService, projects],
		[ISessionsManagementService, management],
		[IDialogService, { confirm: async () => ({ confirmed: true }) }],
	));
	const archive = async () => services.invokeFunction(CommandsRegistry.getCommand(ARCHIVE_PROJECT_COMMAND)!, project.id, 'code');

	primary.listError = new Error('Primary host unavailable');
	await assert.rejects(archive(), /Could not finish archiving/);
	assert.equal(management.state, 'ready');
	assert.equal(management.primaryCatalogReady, false);
	assert.deepEqual(management.sessions.map(session => session.providerId), [remote.id]);
	assert.equal(project.archived, false);
	assert.equal(primary.calls.length, 0);

	primary.listError = undefined;
	remote.listError = new Error('Remote host unavailable');
	const listStarted = new DeferredPromise<void>();
	const pending = new DeferredPromise<readonly ISession[]>();
	const list = primary.list.bind(primary);
	primary.list = async () => {
		void listStarted.complete(undefined);
		return pending.p;
	};
	const staleArchive = archive();
	await listStarted.p;
	project = { ...project, revision: project.revision + 1 };
	await pending.complete(primary.items);
	await assert.rejects(staleArchive, /Could not finish archiving/);
	assert.equal(project.archived, false);
	assert.ok(!primary.calls.some(call => call.startsWith('archive:')));
	primary.list = list;
	assert.equal(await archive(), true);
	assert.equal(management.primaryCatalogReady, true);
	assert.equal(project.archived, true);
	assert.deepEqual(primary.calls.filter(call => call.startsWith('archive:')), ['archive:same']);
	assert.ok(!remote.calls.some(call => call.startsWith('archive:')));
});

test('materializing a Project draft links the durable session before resolving, even after a concurrent project update', async () => {
	using registry = new SessionsProvidersService();
	using primary = new Provider('primary');
	using registration = registry.registerProvider(primary);
	let project: Project = { id: 'project', name: 'Project', description: '', archived: false, revision: 1, materials: [], sessionIds: [], createdAtMs: 1, updatedAtMs: 1, sessionCount: 0 };
	const linked: [number, string][] = [];
	const projects = {
		onDidChange: Event.None,
		read: async () => project,
		addSession: async (snapshot: Project, sessionId: string) => {
			linked.push([snapshot.revision, sessionId]);
			if (snapshot.revision === 1) {
				project = { ...project, revision: 2, sessionIds: ['other'], sessionCount: 1 };
				throw new Error('Concurrent project update');
			}
			project = { ...project, revision: 3, sessionIds: [...project.sessionIds, sessionId], sessionCount: 2 };
			return project;
		},
	} as unknown as IProjectService;
	using management = new SessionsManagementService(primary.id, registry, undefined, undefined, undefined, projects);
	const draft = management.createUntitledSession();
	management.setUntitledSessionWorkspace(draft.untitledSessionId, { type: 'local', root: '/project' }, { projectId: project.id });
	const [first, second] = await Promise.all([
		management.materializeUntitledSession(draft.untitledSessionId),
		management.materializeUntitledSession(draft.untitledSessionId),
	]);
	assert.deepEqual(first, second);
	assert.deepEqual(primary.calls, ['create:local']);
	assert.deepEqual(linked, [[1, first.session.sessionId], [2, first.session.sessionId]]);
	assert.deepEqual(project.sessionIds, ['other', first.session.sessionId]);
});

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
