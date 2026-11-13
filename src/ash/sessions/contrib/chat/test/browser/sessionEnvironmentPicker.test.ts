import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
import { constObservable } from '../../../../../base/common/observable.js';
import type { ISessionsProvider } from '../../../../services/sessions/common/sessionsProvider.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ActionWidgetService, IActionWidgetService } from '../../../../../platform/actionWidget/browser/actionWidget.js';
import { ActionListItemKind } from '../../../../../platform/actionWidget/browser/actionList.js';
import { IRemoteAgentHostService } from '../../../../../platform/agentHost/common/remoteAgentHostService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { BrowserContextViewService } from '../../../../../platform/contextview/browser/contextViewService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IProjectService, type Project, type ProjectMaterial } from '../../../../../platform/projects/common/projectService.js';
import { IRemoteConnectionService } from '../../../../../platform/remote/common/remoteConnectionService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import type { IChatWidgetModel } from '../../../../../workbench/contrib/chat/browser/widget/chatWidget.js';
import { IAgentConnection } from '../../../../../platform/agentHost/common/agentService.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IWorkspacesService } from '../../../../../platform/workspaces/common/workspaces.js';
import { LOCAL_AGENT_HOST_PROVIDER_ID } from '../../../../common/agentHostSessionsProvider.js';
import { ISessionsProvidersService } from '../../../../services/sessions/browser/sessionsProvidersService.js';
import { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import { SessionEnvironmentPicker } from '../../browser/sessionEnvironmentPicker.js';
import { SessionsManagementService } from '../../../../services/sessions/browser/sessionsManagementService.js';
import { SessionsProvidersService } from '../../../../services/sessions/browser/sessionsProvidersService.js';
import { BrowserStorageService } from '../../../../../workbench/services/storage/browser/storageService.js';
import { URI } from '../../../../../base/common/uri.js';
import type { SessionEnvironmentSelection, SessionWorkspaceSelection } from '../../../../services/sessions/common/session.js';

async function flush(): Promise<void> {
	await new Promise<void>(resolve => setImmediate(resolve));
}

function environmentHarness() {
	const lifetime = new DisposableStore();
	const dom = new JSDOM('<body><div id="footer"></div></body>', { url: 'https://ash.test' });
	lifetime.add(toDisposable(() => dom.window.close()));
	const document = dom.window.document;
	const services = lifetime.add(new InstantiationService());
	services.registerInstance(IContextViewService, lifetime.add(new BrowserContextViewService(document.body)));
	services.registerInstance(IConfigurationService, lifetime.add(new InMemoryConfigurationService()));
	services.registerInstance(IActionWidgetService, lifetime.add(services.createInstance(ActionWidgetService)));
	const storage = lifetime.add(new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'test', flushInterval: 0 }));
	services.registerInstance(IStorageService, storage);
	const catalog = new Map<string, Project>();
	const project = (id: string, materials: readonly ProjectMaterial[]): Project => ({ id, name: id, materials, description: '', archived: false, revision: 1, sessionIds: [], sessionCount: 0 });
	catalog.set('original-project', project('original-project', [{ kind: 'folder', name: 'repo', resource: URI.file('/repo') }]));
	catalog.set('worktree-project', project('worktree-project', [{ kind: 'folder', name: 'topic', resource: URI.file('/worktree') }]));
	let beforeList = async () => { };
	const projects = {
		onDidChange: Event.None,
		list: async () => { await beforeList(); return [...catalog.values()]; },
		read: async (id: string) => { const value = catalog.get(id); if (!value) throw new Error('Missing project'); return value; },
		create: async (id: string, _name: string, _description: string, materials: readonly ProjectMaterial[]) => {
			const value = project(id, materials); catalog.set(id, value); return value;
		},
		addSession: async (value: Project, sessionId: string) => {
			const next = { ...value, sessionIds: [...value.sessionIds, sessionId] }; catalog.set(value.id, next); return next;
		},
	} as unknown as IProjectService;
	services.registerInstance(IProjectService, projects);
	const providers = lifetime.add(new SessionsProvidersService());
	services.registerInstance(ISessionsProvidersService, providers);
	const created: SessionWorkspaceSelection[] = [];
	let authorize = async (_workspace: SessionWorkspaceSelection, _signal?: AbortSignal) => true;
	const provider = {
		id: LOCAL_AGENT_HOST_PROVIDER_ID, label: 'Local', order: 0,
		onDidChangeCatalog: Event.None, onDidChangeSession: Event.None,
		currentWorkspace: () => ({ type: 'local', root: '/repo' }),
		authorizeWorkspace: (workspace: SessionWorkspaceSelection, signal?: AbortSignal) => authorize(workspace, signal),
		getWorktrees: async () => [{ label: 'Topic Worktree', target: { type: 'local', root: '/worktree' } }],
		create: async (_title: string, workspace: SessionWorkspaceSelection) => {
			created.push(workspace);
			const id = `session-${created.length}`;
			return { session: { sessionId: id, title: id, status: 'active', kind: 'code', nextApprovalMode: 'manual', chats: [{ threadId: id, status: 'active', origin: { type: 'root' } }] }, threadId: id };
		},
	} as unknown as ISessionsProvider;
	lifetime.add(providers.registerProvider(provider));
	const management = lifetime.add(new SessionsManagementService(provider.id, providers, undefined, undefined, undefined, projects));
	services.registerInstance(ISessionsManagementService, management);
	const errors: unknown[] = [];
	services.registerInstance(INotificationService, { error: (error: unknown) => { errors.push(error); } } as unknown as INotificationService);
	services.registerInstance(IRemoteAgentHostService, { isAvailable: false, connections: [] } as unknown as IRemoteAgentHostService);
	services.registerInstance(IRemoteConnectionService, { available: false } as IRemoteConnectionService);
	services.registerInstance(ICommandService, {} as ICommandService);
	services.registerInstance(IContextKeyService, { getValue: () => 'code' } as unknown as IContextKeyService);
	services.registerInstance(IAgentConnection, {} as IAgentConnection);
	services.registerInstance(ILayoutService, { activeContainer: document.body } as ILayoutService);
	services.registerInstance(IFileDialogService, {} as IFileDialogService);
	const recent: URI[] = [];
	services.registerInstance(IWorkspacesService, {
		getRecentlyOpened: async () => ({ workspaces: [], files: [] }),
		addRecentlyOpened: async (entries: { folderUri: URI; }[]) => { recent.push(...entries.map(entry => entry.folderUri)); },
	} as unknown as IWorkspacesService);
	const draft = management.createUntitledSession(undefined, { type: 'local', root: '/repo' });
	const model = { untitledSessionId: draft.untitledSessionId, inputState: { phase: 'ready' }, onDidChange: Event.None };
	let persist = async () => { };
	const picker = lifetime.add(services.createInstance(SessionEnvironmentPicker, model as unknown as IChatWidgetModel, () => persist()));
	picker.render(document.querySelector<HTMLElement>('#footer')!);
	const button = (name: string) => {
		const element = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.getAttribute('aria-label') === name || button.textContent === name);
		assert.ok(element, `Missing button: ${name}`); return element;
	};
	const select = async (name: string) => {
		picker.showPicker(); await flush(); button(name).click(); await flush();
	};
	const newDraft = (workspace: SessionWorkspaceSelection = { type: 'current' }) => {
		const draft = management.createUntitledSession(undefined, workspace);
		model.untitledSessionId = draft.untitledSessionId;
		picker.setVisible(true);
		return draft;
	};
	const save = (environment: SessionEnvironmentSelection, projectId?: unknown, providerId = provider.id) => {
		storage.store(environment.id, JSON.stringify({ providerId, environment, projectId }), StorageScope.PROFILE, StorageTarget.MACHINE);
	};
	return {
		[Symbol.dispose]: () => lifetime.dispose(),
		management, providers, provider, catalog, storage, model, picker, created, errors, recent, document, button, select, newDraft, save,
		set beforeList(value: typeof beforeList) { beforeList = value; },
		set authorize(value: typeof authorize) { authorize = value; },
		set persist(value: typeof persist) { persist = value; },
	};
}

const worktreeEnvironment: SessionEnvironmentSelection = {
	id: 'sessions.environment.profile.worktree', name: 'Saved Worktree', folders: [{ type: 'local', root: '/worktree' }], hasVariables: false,
};

test('A saved Worktree Project reference survives a fresh draft and first materialization', async () => {
	using fixture = environmentHarness();
	fixture.save(worktreeEnvironment, 'original-project');
	const blank = fixture.newDraft();
	await fixture.select(worktreeEnvironment.name);
	assert.equal(fixture.management.activeUntitledSession!.projectId, 'original-project');
	assert.deepEqual(fixture.recent.map(resource => resource.fsPath), ['/worktree']);
	const active = await fixture.management.materializeUntitledSession(blank.untitledSessionId);
	assert.deepEqual(fixture.created, [{ type: 'local', root: '/worktree' }]);
	assert.deepEqual(fixture.catalog.get('original-project')!.sessionIds, [active.session.sessionId]);
	assert.deepEqual(fixture.catalog.get('worktree-project')!.sessionIds, []);
	assert.deepEqual(fixture.errors, []);
});

test('Legacy environment records still resolve ordinary folders without inferring a parent repository', async () => {
	using fixture = environmentHarness();
	fixture.save(worktreeEnvironment);
	fixture.newDraft();
	await fixture.select(worktreeEnvironment.name);
	assert.equal(fixture.management.activeUntitledSession!.projectId, 'worktree-project');
	assert.deepEqual(fixture.management.activeUntitledSession!.workspace, { type: 'local', root: '/worktree' });
	assert.deepEqual(fixture.errors, []);
});

for (const invalid of ['missing', 'archived', 'malformed'] as const) {
	test(`A ${invalid} saved Project reference cannot silently select another Project`, async () => {
		using fixture = environmentHarness();
		if (invalid === 'missing') fixture.catalog.delete('original-project');
		if (invalid === 'archived') fixture.catalog.set('original-project', { ...fixture.catalog.get('original-project')!, archived: true });
		fixture.save(worktreeEnvironment, invalid === 'malformed' ? {} : 'original-project');
		const blank = fixture.newDraft();
		if (invalid === 'malformed') {
			fixture.picker.showPicker(); await flush();
			assert.equal([...fixture.document.querySelectorAll('button')].some(button => button.textContent === worktreeEnvironment.name), false);
		} else {
			await fixture.select(worktreeEnvironment.name);
			assert.equal(fixture.errors.length, 1);
			assert.match(String(fixture.errors[0]), /This project is unavailable/u);
		}
		assert.equal(fixture.management.activeUntitledSession, blank);
		assert.equal(fixture.catalog.size, invalid === 'missing' ? 1 : 2);
	});
}

test('Remote environments keep their execution target and ignore local Project metadata', async () => {
	using fixture = environmentHarness();
	const provider = { ...fixture.provider, id: 'ssh:fixture', currentWorkspace: () => ({ type: 'ssh', host: 'fixture', root: '/remote' }) } as ISessionsProvider;
	using registration = fixture.providers.registerProvider(provider);
	const environment: SessionEnvironmentSelection = { ...worktreeEnvironment, folders: [{ type: 'ssh', host: 'fixture', root: '/remote' }] };
	fixture.save(environment, 'missing-local-project', provider.id);
	const blank = fixture.newDraft();
	await fixture.select(environment.name);
	assert.equal(fixture.management.activeUntitledSession!.projectId, undefined);
	assert.equal(fixture.management.activeUntitledSession!.providerId, provider.id);
	assert.deepEqual(fixture.management.activeUntitledSession!.workspace, environment.folders[0]);
	await fixture.management.materializeUntitledSession(blank.untitledSessionId);
	assert.deepEqual(fixture.created, environment.folders);
	assert.deepEqual(fixture.errors, []);
});

for (const interruption of ['authorization', 'navigation', 'persistence', 'hidden'] as const) {
	test(`Saved environment selection yields to ${interruption} before changing the draft`, async () => {
		using fixture = environmentHarness();
		fixture.save(worktreeEnvironment, 'original-project');
		const blank = fixture.newDraft();
		const pending = new DeferredPromise<void>();
		if (interruption === 'authorization') fixture.authorize = async () => false;
		else if (interruption === 'persistence') fixture.persist = () => pending.p;
		else fixture.beforeList = () => pending.p;
		await fixture.select(worktreeEnvironment.name);
		if (interruption === 'navigation') fixture.newDraft();
		if (interruption === 'hidden') fixture.picker.setVisible(false);
		if (interruption === 'persistence') fixture.newDraft();
		await pending.complete(undefined);
		await flush();
		assert.equal(fixture.management.untitledSessions.find(draft => draft.untitledSessionId === blank.untitledSessionId), blank);
		assert.deepEqual(fixture.errors, []);
		assert.deepEqual(fixture.created, []);
	});
}

test('Selecting the same saved environment again does not create another Project or change its identity', async () => {
	using fixture = environmentHarness();
	fixture.save(worktreeEnvironment, 'original-project');
	fixture.newDraft();
	await fixture.select(worktreeEnvironment.name);
	await fixture.select(worktreeEnvironment.name);
	assert.equal(fixture.management.activeUntitledSession!.projectId, 'original-project');
	assert.equal(fixture.catalog.size, 2);
	assert.deepEqual(fixture.errors, []);
});

test('Environment discovery yields to an existing or newer workspace menu and can be retried', async () => {
	using lifetime = new DisposableStore();
	const dom = new JSDOM('<body><div id="footer"></div><button id="workspace">Workspace</button></body>');
	lifetime.add(toDisposable(() => dom.window.close()));
	const document = dom.window.document;
	const footer = document.querySelector<HTMLElement>('#footer')!;
	const workspace = document.querySelector<HTMLButtonElement>('#workspace')!;
	const services = lifetime.add(new InstantiationService());
	services.registerInstance(IContextViewService, lifetime.add(new BrowserContextViewService(document.body)));
	services.registerInstance(IConfigurationService, lifetime.add(new InMemoryConfigurationService()));
	const menus = lifetime.add(services.createInstance(ActionWidgetService));
	services.registerInstance(IActionWidgetService, menus);
	const discovery = new DeferredPromise<string[]>();
	let discoveries = 0;
	services.registerInstance(IRemoteAgentHostService, {
		isAvailable: true,
		connections: [],
		listWSLDistros: () => { discoveries++; return discovery.p; },
	} as unknown as IRemoteAgentHostService);
	services.registerInstance(IRemoteConnectionService, { available: false } as IRemoteConnectionService);
	const commands: unknown[][] = [];
	services.registerInstance(ICommandService, {
		async executeCommand(...args: unknown[]) { commands.push(args); return false; },
	} as unknown as ICommandService);
	services.registerInstance(INotificationService, { error: (error: unknown) => assert.fail(String(error)) } as unknown as INotificationService);
	services.registerInstance(IStorageService, { keys: () => [] } as unknown as IStorageService);
	services.registerInstance(IProjectService, {} as IProjectService);
	services.registerInstance(IContextKeyService, {} as IContextKeyService);
	services.registerInstance(IAgentConnection, {} as IAgentConnection);
	services.registerInstance(ILayoutService, {} as ILayoutService);
	services.registerInstance(IFileDialogService, {} as IFileDialogService);
	services.registerInstance(IWorkspacesService, {} as IWorkspacesService);
	const draft = { untitledSessionId: 'draft', providerId: LOCAL_AGENT_HOST_PROVIDER_ID, workspace: { type: 'current' } };
	services.registerInstance(ISessionsManagementService, {
		untitledSessions: [draft], onDidChange: Event.None,
	} as unknown as ISessionsManagementService);
	const providers: ISessionsProvider[] = [];
	services.registerInstance(ISessionsProvidersService, {
		onDidChangeProviders: Event.None, getProviders: () => providers, getProvider: () => undefined,
	} as unknown as ISessionsProvidersService);
	const model = { untitledSessionId: draft.untitledSessionId, inputState: { phase: 'ready' }, onDidChange: Event.None };
	const picker = lifetime.add(services.createInstance(SessionEnvironmentPicker, model as unknown as IChatWidgetModel, async () => { }));
	const rendered = picker.render(footer);
	const trigger = footer.querySelector<HTMLButtonElement>('button')!;
	const openWorkspace = () => {
		workspace.focus();
		menus.show('testWorkspace', false, [{ kind: ActionListItemKind.Action, label: 'Open Folder', item: 'folder' }], {
			onHide: () => { }, onSelect: () => { },
		}, workspace);
	};

	openWorkspace();
	trigger.click();
	assert.equal(discoveries, 0);
	assert.equal(trigger.getAttribute('aria-expanded'), 'false');
	menus.hide();

	trigger.click();
	assert.equal(discoveries, 1);
	openWorkspace();
	await discovery.complete(['Ubuntu']);
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.equal(trigger.getAttribute('aria-expanded'), 'false');
	assert.ok(document.querySelector('[aria-label="Open Folder"]'));
	menus.hide();

	providers.push({
		id: 'ssh:devbox', label: 'devbox', connectionStatus: constObservable('connected'),
		currentWorkspace: () => ({ type: 'ssh', host: 'devbox', root: '/workspace' }),
	} as ISessionsProvider);
	trigger.focus();
	trigger.click();
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.equal(discoveries, 2);
	assert.equal(trigger.getAttribute('aria-expanded'), 'true');
	assert.equal(document.querySelector('[aria-label="WSL: Ubuntu"]')?.getAttribute('aria-description'), 'Connect to the Ubuntu WSL distribution.');
	assert.ok(document.querySelector('[aria-label="Cloud"]:disabled'));
	assert.ok(document.querySelector('[aria-label="New Environment"]'));
	assert.equal(document.querySelector('[aria-label="Add Remote…"]'), null);
	const remote = document.querySelector<HTMLElement>('[aria-label="Remote"]');
	assert.ok(remote);
	const host = document.querySelector<HTMLElement>('[aria-label="devbox"]');
	assert.ok(host);
	assert.equal(host.getAttribute('aria-description'), 'Run on devbox. · Connected');
	assert.equal(host.getAttribute('title'), 'Run on devbox.');
	assert.equal(host.closest('[role="menu"]'), remote.closest('[role="menu"]'));
	assert.ok(host.compareDocumentPosition(remote) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
	assert.equal(remote.getAttribute('aria-haspopup'), 'menu');
	remote.focus();
	remote.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
	assert.equal(remote.getAttribute('aria-expanded'), 'true');
	assert.ok(document.querySelector('[aria-label="Cloud"]'));
	assert.ok(document.querySelector('[aria-label="SSH"]'));
	const tunnel = document.querySelector<HTMLButtonElement>('[aria-label="Ash Tunnel"]');
	assert.ok(tunnel);
	assert.equal(tunnel.getAttribute('aria-description'), 'Connect using an authenticated Ash Tunnel URL.');
	assert.equal(tunnel.getAttribute('title'), 'Connect using an authenticated Ash Tunnel URL.');
	assert.equal(document.activeElement, tunnel);

	tunnel.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
	assert.equal(remote.getAttribute('aria-expanded'), 'false');
	assert.equal(trigger.getAttribute('aria-expanded'), 'true');
	assert.equal(document.activeElement, remote);

	remote.click();
	assert.equal(remote.getAttribute('aria-expanded'), 'true');
	const reopenedTunnel = document.querySelector<HTMLButtonElement>('[aria-label="Ash Tunnel"]');
	assert.ok(reopenedTunnel);
	reopenedTunnel.click();
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.deepEqual(commands, [['sessions.action.newRemoteEnvironment', 'tunnel']]);
	assert.equal(trigger.getAttribute('aria-expanded'), 'false');

	trigger.focus();
	trigger.click();
	await new Promise<void>(resolve => setImmediate(resolve));
	menus.hide();
	assert.equal(trigger.getAttribute('aria-expanded'), 'false');
	assert.equal(document.activeElement, trigger);
	rendered.dispose();
	assert.equal(rendered.element.isConnected, false);
	picker.showPicker();
	assert.equal(menus.isVisible, false);
});
