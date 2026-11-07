import { JSDOM } from 'jsdom';
import { IStorageService } from '../../../../../../platform/storage/common/storage.js';
import { BrowserStorageService } from '../../../../../../workbench/services/storage/browser/storageService.js';
import { getWindows } from '../../../../../../base/browser/window.js';
import { ILayoutService } from '../../../../../../platform/layout/browser/layoutService.js';
import { MenuId, MenusRegistry, isMenuItem } from '../../../../../../platform/actions/common/actions.js';
import { Menus } from '../../../../../browser/menus.js';
import { registerTestWorkbenchHostServices } from '../../../../../../workbench/test/common/workbenchHostTestServices.js';
import { IRemoteAgentHostService } from '../../../../../../platform/agentHost/common/remoteAgentHostService.js';
import { IAgentConnection } from '../../../../../../platform/agentHost/common/agentService.js';
import type { FileInvalidation } from '../../../../../../platform/files/common/fileApi.js';
import { SessionFileSystemContribution } from '../../../agentHost/browser/sessionFileSystemContribution.js';
import { ISessionProviderScopeService } from '../../../../../browser/agentHost/sessionProviderScopeService.js';
import { projectSession } from '../../../../../services/sessions/common/sessionIdentity.js';
import { sessionWorkspaceUri } from '../../../../../common/sessionWorkspace.js';
import { WSLAgentHostContribution } from '../../browser/wslAgentHost.contribution.js';
import { TunnelAgentHostContribution } from '../../browser/tunnelAgentHost.contribution.js';
import { RemoteAgentHostContribution } from '../../browser/remoteAgentHostContribution.js';
import { ISessionsManagementService } from '../../../../../services/sessions/common/sessionsManagement.js';
import type { ISession } from '../../../../../services/sessions/common/session.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { remoteAgentHostRoot, type RemoteAgentHostConnection } from '../../../../../../platform/agentHost/common/remoteAgentHostService.js';
import { browserEnvironment } from '../../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'mocha';
import { DeferredPromise, raceCancellationError, timeout } from '../../../../../../base/common/async.js';
import { canceled } from '../../../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { resetNlsResolver, setNlsMessages } from '../../../../../../nls.js';
import { AgentHostConnectionsService } from '../../../../../../platform/agentHost/browser/agentHostConnectionsService.js';
import { IAgentHostConnectionsService, agentHostConnectionAddress } from '../../../../../../platform/agentHost/common/agentHostConnectionsService.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { ILanguageModelsConfigurationService } from '../../../../../../workbench/contrib/chat/common/languageModelsConfiguration.js';
import type { ResourceMetadataResult } from '../../../../../../platform/agentHost/common/appServerApi.js';
import type { AgentSession } from '../../../../../../platform/agentHost/common/agent.js';
import type { Automation, IAutomationBackendService } from '../../../../../../platform/automations/common/automation.js';
import { ContextKeyService } from '../../../../../../platform/contextkey/browser/contextKeyService.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../../../platform/quickinput/common/quickInput.js';
import { TestQuickInputService } from '../../../../../../platform/quickinput/test/browser/testQuickInputService.js';
import { IRemoteConnectionApi, IRemoteConnectionService, RemoteConnectionService, type RemoteConnectionDefinition } from '../../../../../../platform/remote/common/remoteConnectionService.js';
import { URI } from '../../../../../../base/common/uri.js';
import { AgentHostFileSystemProvider } from '../../../../../../platform/agentHost/common/agentHostFileSystemProvider.js';
import { FileService } from '../../../../../../platform/files/common/fileService.js';
import { IFileService, type IFileChangeEvent } from '../../../../../../platform/files/common/files.js';
import { createSshRemoteWorkspaceUri } from '../../../../../../platform/remote/common/remote.js';
import { AgentHostFileSystemService, IAgentHostFileSystemService } from '../../../../../../workbench/services/agentHost/common/agentHostFileSystemService.js';
import { type IWorkbenchHost } from '../../../../../../workbench/browser/rendererApi.js';
import { type IRemoteAgentHostProtocolClient, type IRemoteAgentHostConnectionInfo } from '../../../../../../platform/agentHost/common/remoteAgentHostService.js';
import { createDisconnectedRendererApi } from '../../../../../../workbench/browser/rendererApi.js';
import { CommandService } from '../../../../../../workbench/services/commands/common/commandService.js';
import { productLanguagePackCatalogs } from '../../../../../../workbench/services/localization/common/localizationCatalogs.js';
import { TestNotificationService } from '../../../../../../workbench/services/notification/test/common/testNotificationService.js';
import { ISessionsProvidersService, SessionsProvidersService } from '../../../../../services/sessions/browser/sessionsProvidersService.js';
import { ProviderAutomationService } from '../../../../automations/browser/providerAutomationService.js';
import { SSHAgentHostContribution } from '../../browser/sshAgentHost.contribution.js';

// Initialize the shared browser test window before tracking fixture-owned disposables.
getWindows();
ensureNoDisposablesAreLeakedInTestSuite();

const manageHosts = 'sessions.action.manageAgentHosts';
const targets: readonly RemoteConnectionDefinition[] = [
	{ name: 'build-a', host: 'server-a', workspace: '/srv/project' },
	{ name: 'build-b', host: 'server-b', workspace: '/srv/project' },
];

function fixture(remoteConnections: readonly RemoteConnectionDefinition[] = targets) {
	const lifetime = new DisposableStore();
	const services = lifetime.add(new InstantiationService());
	const container = browserEnvironment.window.document.createElement('div');
	browserEnvironment.window.document.body.append(container);
	lifetime.add(toDisposable(() => container.remove()));
	services.registerInstance(ILayoutService, { activeContainer: container } as Partial<ILayoutService> as ILayoutService);
	// jsdom has no native dialog top layer. Exercise the real dialog's DOM and cancel lifecycle.
	const dialogPrototype = browserEnvironment.window.HTMLDialogElement.prototype;
	const elementPrototype = browserEnvironment.window.HTMLElement.prototype;
	Object.defineProperty(elementPrototype, 'scrollTo', { configurable: true, value() { } });
	Object.defineProperties(dialogPrototype, {
		showModal: { configurable: true, value(this: HTMLDialogElement) { this.open = true; } },
		close: { configurable: true, value(this: HTMLDialogElement) { this.open = false; } },
	});
	lifetime.add(toDisposable(() => {
		Reflect.deleteProperty(dialogPrototype, 'showModal');
		Reflect.deleteProperty(dialogPrototype, 'close');
		Reflect.deleteProperty(elementPrototype, 'scrollTo');
	}));
	const storageWindow = new JSDOM('', { url: 'https://ash.test' }).window;
	lifetime.add(toDisposable(() => storageWindow.close()));
	services.registerInstance(IStorageService, lifetime.add(new BrowserStorageService({ ownerWindow: storageWindow as unknown as Window, workspaceId: 'remote-hosts', flushInterval: 0 })));
	const contexts = lifetime.add(new ContextKeyService());
	const quickInput = lifetime.add(new TestQuickInputService({ container, instantiationService: services, contextKeyService: contexts }));
	services.registerInstance(IQuickInputService, quickInput);
	const notifications = lifetime.add(new TestNotificationService());
	services.registerInstance(INotificationService, notifications);
	const errors: string[] = [];
	lifetime.add(notifications.model.onDidAdd(item => errors.push(String(item.message))));
	const catalogChanges = lifetime.add(new Emitter<void>());
	let canonicalSessions: readonly ISession[] = [];
	services.registerInstance(ISessionsManagementService, { get sessions() { return canonicalSessions; }, onDidChange: catalogChanges.event } as ISessionsManagementService);
	const registry = lifetime.add(new SessionsProvidersService());
	services.registerInstance(ISessionsProvidersService, registry);
	services.registerInstance(IRemoteConnectionApi, {
		available: true, list: async () => remoteConnections,
		save: async value => value, update: async (_name, value) => value,
		remove: async () => undefined, connect: async () => { throw new Error('Additional hosts must not open another window'); },
	});
	services.registerInstance(IRemoteConnectionService, lifetime.add(services.createInstance(RemoteConnectionService)));
	const opened: string[] = [];
	const closed: string[] = [];
	const reconnected: string[] = [];
	const renamed: string[] = [];
	const deleted: string[] = [];
	let openResult: ((target: RemoteAgentHostConnection, host: IRemoteAgentHostProtocolClient) => Promise<IRemoteAgentHostProtocolClient>) | undefined;
	const renderer = createDisconnectedRendererApi();
	let readCapabilities: typeof renderer.agentCapabilities.read | undefined;
	let containerSessions = false;
	const sessionDirectoryRequests: unknown[] = [];
	services.registerInstance(IConfigurationService, lifetime.add(new InMemoryConfigurationService()));
	services.registerInstance(ILanguageModelsConfigurationService, {
		onDidChangeModels: Event.None, getDefaultNewChatModel: () => undefined,
		rememberSelectedModel: () => { }, removeProviderPreferences: async () => { },
		isModelVisible: () => true, setModelVisible: async () => { },
	});
	const hostChanges = lifetime.add(new Emitter<void>());
	const hosts = new Map<string, IRemoteAgentHostConnectionInfo>();
	const disconnect = (id: string): void => {
		const entry = [...hosts.entries()].find(([, value]) => value.id === id);
		if (entry) entry[1].host?.dispose();
	};
	const files = lifetime.add(new FileService());
	services.registerInstance(IFileService, files);
	const primaryRequests: string[] = [];
	const primary = lifetime.add(new AgentHostFileSystemProvider({
		api: {
			...renderer.fs,
			resolvePath: async resource => { primaryRequests.push(resource.toString()); throw new Error('Unexpected primary file fallback'); },
		},
		resourceApi: renderer.resource,
		directories: () => [{ uri: URI.file('/primary'), target: { type: 'environment', dirId: 'primary' } }],
	}));
	services.registerInstance(IAgentHostFileSystemService, lifetime.add(services.createInstance(AgentHostFileSystemService, primary, undefined)));
	services.registerInstance(ISessionProviderScopeService, { getScope: () => { throw new Error('A remote provider already owns its filesystem routes'); } } as unknown as ISessionProviderScopeService);
	lifetime.add(services.createInstance(SessionFileSystemContribution, 'local-agent-host'));
	const hostFileChanges = new Map<string, Emitter<FileInvalidation>>();
	const fileRequests: { host: string; operation: string; path: string; }[] = [];
	const resourceRequests: string[] = [];
	const openResources = new Set<string>();

	registerTestWorkbenchHostServices(services, {
		...renderer,
		agentHosts: {
			isAvailable: true,
			get connections() { return [...hosts.values()]; },
			onDidChangeConnections: hostChanges.event,
			disconnect,
			reconnect: async id => {
				reconnected.push(id);
				const entry = [...hosts.entries()].find(([, value]) => value.id === id);
				assert.ok(entry);
				hosts.set(entry[0], { ...entry[1], state: 'ready' });
				hostChanges.fire();
			},
			listWSLDistros: async () => [],
			connect: async (target, signal) => {
				const key = agentHostConnectionAddress(target);
				const existing = hosts.get(key);
				if (existing?.host) return existing.host;
				opened.push(target.name);
				const session: AgentSession = {
					sessionId: 'same-session', kind: 'code' as const, title: target.name, status: 'active',
					executionTarget: containerSessions ? { type: 'provider', providerId: 'ash.dev-containers', workspace: '/Source', root: '/workspace', hostAuthority: remoteAgentHostRoot(target, target.name).authority } : undefined,
					manager: { status: 'idle', statusChangedAtUnixMs: 0 }, threads: [],
				};
				const plan: Automation = {
					id: 'same-automation', revision: 1, status: 'enabled', createdAt: 1, updatedAt: 1, nextRunAt: null,
					definition: { title: target.name, prompt: 'Review', directory: '/srv/project', session: { type: 'new' }, schedule: { type: 'interval', anchor: 1, minutes: 60 } },
				};
				const automation: IAutomationBackendService = {
					onDidChange: Event.None,
					list: async () => [plan], runs: async () => [], preview: async () => [],
					delete: async id => { deleted.push(`${target.name}:${id}`); },
					save: async () => { throw new Error('Unexpected save'); },
					run: async () => { throw new Error('Unexpected run'); },
					getRun: async () => { throw new Error('Unexpected run read'); },
					stop: async () => { throw new Error('Unexpected stop'); },
					readResult: async () => { throw new Error('Unexpected result'); },
				};
				const fileChanges = lifetime.add(new Emitter<FileInvalidation>());
				hostFileChanges.set(target.name, fileChanges);
				const resources = new Map<string, { bytes: Buffer; metadata: ResourceMetadataResult; }>();
				let nextResource = 0;
				let nextRevision = 1;
				const disk = new Map<string, { bytes: Buffer; revision: string; }>();
				const readStored = (path: string): { bytes: Buffer; revision: string; } => {
					let stored = disk.get(path);
					if (!stored) {
						stored = { bytes: Buffer.from(`${target.name}:${path}`), revision: 'r1' };
						disk.set(path, stored);
					}
					return stored;
				};
				const writeStored = (path: string, bytes: Buffer) => {
					const revision = `r${++nextRevision}`;
					disk.set(path, { bytes: Buffer.from(bytes), revision });
					return { metadata: { fileType: 'file' as const, sizeBytes: bytes.byteLength, readonly: false, modifiedAtMillis: null }, revision };
				};
				const api: IWorkbenchHost = {
					...renderer, automation,
					resource: {
						connectionGeneration: 0,
						metadata: async ({ resourceId }) => {
							const resource = resources.get(resourceId);
							assert.ok(resource, 'resource belongs to this host connection');
							return resource.metadata;
						},
						read: async ({ resourceId, offset, maxBytes }) => {
							const resource = resources.get(resourceId);
							assert.ok(resource, 'resource belongs to this host connection');
							const bytes = resource.bytes.subarray(offset, offset + maxBytes);
							resourceRequests.push(`${target.name}:read:${resourceId}`);
							return { resourceId, offset, dataBase64: bytes.toString('base64'), decodedLength: bytes.byteLength, eof: offset + bytes.byteLength === resource.bytes.byteLength };
						},
						release: async ({ resourceId }) => {
							assert.equal(resources.delete(resourceId), true, 'release the allocating host connection resource');
							resourceRequests.push(`${target.name}:release:${resourceId}`);
							openResources.delete(`${target.name}:${resourceId}`);
						},
					},
					fs: {
						...renderer.fs,
						onDidChangeFiles: fileChanges.event,
						readFile: async params => {
							fileRequests.push({ host: target.name, operation: 'read', path: params.path });
							if (params.sessionDirectory) sessionDirectoryRequests.push({ host: target.name, ...params.sessionDirectory });
							else assert.equal(params.dirId, `agent-host:${target.name}`);
							const stored = readStored(params.path);
							return { content: stored.bytes.toString('utf8'), revision: stored.revision };
						},
						readBinaryFile: async params => {
							fileRequests.push({ host: target.name, operation: 'read', path: params.path });
							if (params.sessionDirectory) sessionDirectoryRequests.push({ host: target.name, ...params.sessionDirectory });
							else assert.equal(params.dirId, `agent-host:${target.name}`);
							const stored = readStored(params.path);
							const bytes = Buffer.from(stored.bytes);
							// Hosts deliberately reuse opaque IDs; only their allocating connection can consume them.
							const resourceId = `resource-${++nextResource}`;
							const metadata = { resourceId, mimeType: 'text/plain', size: bytes.byteLength, sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
							resources.set(resourceId, { bytes, metadata });
							openResources.add(`${target.name}:${resourceId}`);
							resourceRequests.push(`${target.name}:open:${resourceId}`);
							return { resource: metadata, revision: stored.revision };
						},
						writeBinaryFile: async params => {
							fileRequests.push({ host: target.name, operation: 'write', path: params.path });
							if (params.sessionDirectory) sessionDirectoryRequests.push({ host: target.name, ...params.sessionDirectory });
							else assert.equal(params.dirId, `agent-host:${target.name}`);
							return writeStored(params.path, Buffer.from(params.dataBase64, 'base64'));
						},
						writeFile: async params => {
							fileRequests.push({ host: target.name, operation: 'write', path: params.path });
							if (params.sessionDirectory) sessionDirectoryRequests.push({ host: target.name, ...params.sessionDirectory });
							else assert.equal(params.dirId, `agent-host:${target.name}`);
							return writeStored(params.path, Buffer.from(params.content));
						},
					},
					appServer: { ...renderer.appServer, getConnectionState: async () => 'ready' },
					agentCapabilities: readCapabilities
						? { ...renderer.agentCapabilities, isAvailable: true, read: readCapabilities }
						: renderer.agentCapabilities,
					session: {
						...renderer.session,
						subscribeCatalog: async () => ({ sessions: [session] }), unsubscribeCatalog: async () => { },
						rename: async params => { renamed.push(`${target.name}:${params.sessionId}`); return { session: { ...session, title: params.title }, agentTree: { roots: [] } }; },
					},
				};
				const host: IRemoteAgentHostProtocolClient = {
					id: target.name, connection: target, api, directory: { uri: remoteAgentHostRoot(target, target.name), target: { type: 'environment', dirId: `agent-host:${target.name}` } }, ...toDisposable(() => {
						closed.push(target.name);
						if (hosts.get(key)?.host === host) { hosts.delete(key); hostChanges.fire(); }
					})
				};
				try {
					await raceCancellationError(openResult ? openResult(target, host) : Promise.resolve(host), signal);
					if (signal.aborted) throw canceled();
					hosts.set(key, { id: host.id, connection: target, state: 'ready', host });
					hostChanges.fire();
					return host;
				} catch (error) { host.dispose(); throw error; }
			},
		},
	});
	services.registerInstance(IAgentHostConnectionsService, lifetime.add(services.createInstance(AgentHostConnectionsService)));
	const commands = lifetime.add(new CommandService(services));
	services.registerInstance(ICommandService, commands);
	const scopeOwner = lifetime.add(services.createInstance(RemoteAgentHostContribution));
	const contribution = lifetime.add(services.createInstance(SSHAgentHostContribution));
	lifetime.add(services.createInstance(WSLAgentHostContribution));
	lifetime.add(services.createInstance(TunnelAgentHostContribution));
	const automations = lifetime.add(services.createInstance(ProviderAutomationService));
	function dialog(): HTMLDialogElement {
		const current = container.querySelector('dialog[open]');
		assert.ok(current);
		return current as HTMLDialogElement;
	}
	function closeDialog(): void {
		dialog().dispatchEvent(new browserEnvironment.window.Event('cancel', { cancelable: true }));
	}
	async function choose(label: string): Promise<void> {
		for (let i = 0; i < 100; i++) {
			const button = [...dialog().querySelectorAll('button')].find(button => button.getAttribute('aria-label') === label);
			if (button) {
				button.click();
				for (let j = 0; j < 100 && dialog().querySelector('tbody[aria-busy="true"]'); j++) await timeout(0);
				assert.equal(dialog().querySelector('tbody[aria-busy="true"]'), null);
				closeDialog();
				return;
			}
			await timeout(0);
		}
		assert.fail(`Missing action: ${label}`);
	}
	async function connect(name: string): Promise<void> {
		const result = commands.executeCommand(manageHosts);
		await choose(`Connect: ${name}`);
		await result;
	}
	return {
		[Symbol.dispose]: () => lifetime.dispose(),
		services, commands, contribution, scopeOwner, registry, automations, container, errors, notifications,
		readCapabilities: (read: typeof readCapabilities) => { readCapabilities = read; },
		opened, closed, renamed, deleted, reconnected, connect, choose, dialog, closeDialog, sessionDirectoryRequests,
		crash: (name: string) => {
			const entry = [...hosts.entries()].find(([, value]) => value.connection.name === name);
			assert.ok(entry);
			hosts.set(entry[0], { ...entry[1], state: 'crashed' });
			hostChanges.fire();
			return entry[1].id;
		},
		containerSessions: () => { containerSessions = true; },
		connectTarget: (target: RemoteAgentHostConnection) => (services.get(IAgentConnection) as IWorkbenchHost).agentHosts!.connect(target, new AbortController().signal), files, fileRequests, primaryRequests, resourceRequests, openResources,
		publishSessions: (sessions: readonly ISession[]) => { canonicalSessions = sessions; catalogChanges.fire(); },
		changeFiles: (name: string, path: string) => hostFileChanges.get(name)!.fire({ type: 'pathsChanged', dirId: `agent-host:${name}`, paths: [path] }),
		deferOpen: (next: typeof openResult) => { openResult = next; },
	};
}

test('remote Windows sandbox setup notice refreshes against the connected execution host', async () => {
	using context = fixture();
	let ready = false;
	let reads = 0;
	context.readCapabilities(async () => {
		reads++;
		return {
			localProcessSandboxConfigured: true,
			directoryGrantsReadable: false,
			sandboxBackends: ['mxc', 'windows'],
			sandboxPolicy: { profile: 'workspace', fileSystem: 'directoryWrite', network: 'denied', hostRead: 'host', managedConstraints: false, pathRuleCount: 0 },
			sandboxDiagnostics: [
				{ backend: 'mxc', network: 'denied', readiness: { type: 'unsupported', reason: 'Missing OS capability' } },
				{ backend: 'windows', network: 'denied', readiness: ready ? { type: 'ready' } : { type: 'unavailable', reason: 'Setup required' } },
			],
		};
	});
	const notices: { readonly message: unknown; readonly actions?: { readonly primary?: readonly { readonly id: string; run(): unknown; }[]; }; }[] = [];
	using listener = context.notifications.model.onDidAdd(notice => notices.push(notice));
	await context.connect('build-a');
	assert.match(String(notices[0]?.message), /build-a.*administrator setup/);
	const refresh = notices[0]?.actions?.primary?.find(action => action.id === 'sessions.remoteSandbox.refresh');
	assert.ok(refresh);
	await refresh.run();
	assert.equal(reads, 2);
	assert.equal(notices.length, 1);
	ready = true;
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsMessages(chinese.locale, chinese.bundles);
	try {
		await refresh.run();
		assert.equal(reads, 3);
		assert.equal(String(notices[1]?.message), 'build-a 上的命令沙箱已就绪。');
	} finally { resetNlsResolver(); }
});

test('remote provider scopes bind their own connection while borrowing window connection management', async () => {
	using context = fixture();
	const windowHost = (context.services.get(IAgentConnection) as IWorkbenchHost);
	await context.connect('build-a');
	const provider = context.registry.getProviders()[0]!;
	const scope = provider.instantiationService!;
	const connection = scope.get(IAgentConnection);
	assert.equal(connection, windowHost.agentHosts!.connections[0]!.host!.api);
	assert.notEqual(connection, windowHost);
	assert.equal(scope.get(IRemoteAgentHostService), context.services.get(IRemoteAgentHostService), 'window connection management remains with the parent scope');
	const sessions = await provider.list();
	await provider.renameSession(sessions[0]!, 'Remote task');
	assert.deepEqual(context.renamed, ['build-a:same-session']);
	context.scopeOwner.dispose();
	assert.equal(context.registry.getProviders().length, 0);
	assert.deepEqual(context.closed, ['build-a']);
});

test('Agents host command registers independent providers and routes equal backend IDs through their own domains', async () => {
	using context = fixture();
	const hasManageHosts = (menu: MenuId) => MenusRegistry.getMenuItems(menu)
		.some(item => isMenuItem(item) && item.command.id === manageHosts);
	assert.equal(hasManageHosts(MenuId.CommandPalette), true);
	assert.equal(hasManageHosts(Menus.SessionsViewFilter), false);
	await context.connect('build-a');
	await context.connect('build-b');
	const [first, second] = context.registry.getProviders();
	assert.ok(first && second);
	assert.notEqual(first.id, second.id);
	const [a, b] = await Promise.all([first.list(), second.list()]);
	assert.equal(a[0]!.sessionId, b[0]!.sessionId);
	await second.renameSession(b[0]!, 'Renamed B');
	assert.deepEqual(context.renamed, ['build-b:same-session']);
	await context.automations.refresh();
	const plans = context.automations.automations.get();
	assert.equal(plans.length, 2);
	assert.notEqual(plans[0]!.id, plans[1]!.id);
	await context.automations.deleteAutomation(plans.find(plan => plan.target.providerId === second.id)!.id);
	assert.deepEqual(context.deleted, ['build-b:same-automation']);
	assert.deepEqual(context.errors, []);
});

test('SSH, WSL and Tunnel scopes mount identical container roots on their source host and retire removed Session routes', async () => {
	using context = fixture();
	context.containerSessions();
	await context.connectTarget(targets[0]!);
	await context.connectTarget({ type: 'wsl', name: 'Ubuntu', distro: 'Ubuntu', workspace: '/srv/project' });
	await context.connectTarget({ type: 'tunnel', name: 'Tunnel', endpoint: 'http://127.0.0.1:5174/', workspace: '/srv/project' });
	const sessions: ISession[] = [];
	for (const provider of context.registry.getProviders()) {
		const listed = await provider.list();
		sessions.push(projectSession(listed[0]!, provider.id, provider.label, 'local-agent-host'));
	}
	context.publishSessions(sessions);
	const roots = sessions.map(session => sessionWorkspaceUri(session.workspace!));
	assert.equal(new Set(roots.map(root => root.authority)).size, 3);
	for (const [index, root] of roots.entries()) {
		assert.equal((await context.files.readFile(URI.joinPath(root, 'main.ts'))).content, `${['build-a', 'Ubuntu', 'Tunnel'][index]}:main.ts`);
	}
	assert.deepEqual(context.sessionDirectoryRequests, [
		{ host: 'build-a', sessionId: 'same-session', path: '/workspace' },
		{ host: 'Ubuntu', sessionId: 'same-session', path: '/workspace' },
		{ host: 'Tunnel', sessionId: 'same-session', path: '/workspace' },
	]);
	context.publishSessions(sessions.slice(1));
	await assert.rejects(context.files.readFile(URI.joinPath(roots[0]!, 'main.ts')));
	assert.equal((await context.files.readFile(URI.joinPath(roots[1]!, 'main.ts'))).content, 'Ubuntu:main.ts');
	context.scopeOwner.dispose();
	await assert.rejects(context.files.readFile(URI.joinPath(roots[1]!, 'main.ts')));
	assert.deepEqual(context.primaryRequests, []);
});

test('WSL command reports unavailable hosts in Chinese without creating an SSH scope', async () => {
	using context = fixture();
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsMessages(chinese.locale, chinese.bundles);
	try {
		await context.commands.executeCommand('sessions.action.connectWSLAgentHost');
		assert.deepEqual(context.errors, ['没有可用的 WSL 2 分发版。WSL 连接需要 Windows，并在分发版中安装 Ash Remote 运行时。']);
		assert.deepEqual(context.opened, []);
	} finally { resetNlsResolver(); }
});

test('disconnecting one Agents host unregisters its provider and retains the other host', async () => {
	using context = fixture();
	await context.connect('build-a');
	await context.connect('build-b');
	const result = context.commands.executeCommand(manageHosts);
	await context.choose('Disconnect: build-a');
	await result;
	assert.deepEqual(context.closed, ['build-a']);
	assert.deepEqual(context.registry.getProviders().map(provider => provider.label), ['build-b']);
	await context.automations.refresh();
	assert.deepEqual(context.automations.automations.get().map(plan => plan.name), ['build-b']);
});

test('the remote environments dialog shows connection status and reconnects the exact retained provider', async () => {
	using context = fixture();
	await context.connect('build-a');
	await context.connect('build-b');
	const first = context.registry.getProviders().find(provider => provider.label === 'build-a');
	const command = context.commands.executeCommand(manageHosts);
	const id = context.crash('build-a');
	const rows = [...context.dialog().querySelectorAll('tbody tr')];
	assert.equal(rows.find(row => row.querySelector('th')?.firstChild?.textContent === 'build-a')?.querySelector('td')?.textContent, 'Disconnected');
	assert.equal(rows.find(row => row.querySelector('th')?.firstChild?.textContent === 'build-b')?.querySelector('td')?.textContent, 'Connected');
	assert.equal(context.dialog().querySelector('[aria-label="Reconnect: build-b"]'), null);
	await context.choose('Reconnect: build-a');
	await command;
	assert.deepEqual(context.reconnected, [id]);
	assert.deepEqual(context.closed, []);
	assert.equal(context.registry.getProviders().find(provider => provider.label === 'build-a'), first);
});

test('an active saved target has only one management row', async () => {
	using context = fixture();
	await context.connect('build-a');
	const result = context.commands.executeCommand(manageHosts);
	await timeout(0);
	const rows = [...context.dialog().querySelectorAll('tbody tr')];
	assert.equal(rows.filter(row => row.querySelector('th')?.firstChild?.textContent === 'build-a').length, 1);
	assert.equal(context.dialog().querySelector('[aria-label="Connect: build-a"]'), null);
	context.closeDialog();
	await result;
	assert.deepEqual(context.opened, ['build-a']);
	assert.equal(context.registry.getProviders().length, 1);
});

test('closing the Agents owner retires pending setup and releases its late result', async () => {
	using context = fixture();
	const entered = new DeferredPromise<void>();
	const release = new DeferredPromise<void>();
	context.deferOpen(async (_target, host) => { void entered.complete(); await release.p; return host; });
	const connecting = context.commands.executeCommand(manageHosts);
	let connectButton: HTMLButtonElement | null = null;
	while (!(connectButton = context.dialog().querySelector('[aria-label="Connect: build-a"]'))) await timeout(0);
	connectButton.click();
	await entered.p;
	context.contribution.dispose();
	await release.complete();
	await connecting;
	assert.deepEqual(context.closed, ['build-a']);
	assert.deepEqual(context.registry.getProviders(), []);
	assert.deepEqual(context.errors, []);
});

test('the remote environments dialog uses Chinese labels and closes on cancellation and owner disposal', async () => {
	using context = fixture();
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsMessages(chinese.locale, chinese.bundles);
	try {
		const command = context.commands.executeCommand(manageHosts);
		assert.equal(context.dialog().querySelector('h2')?.textContent, '远程环境');
		context.closeDialog();
		await command;
		const interrupted = context.commands.executeCommand(manageHosts);
		context.contribution.dispose();
		await interrupted;
		assert.equal(context.container.querySelector('dialog'), null);
		assert.deepEqual(context.opened, []);
	} finally { resetNlsResolver(); }
});


test('connected Agents hosts route identical file paths through their own filesystems and retire disconnected routes', async () => {
	using context = fixture();
	await context.connect('build-a');
	await context.connect('build-b');
	const first = URI.joinPath(createSshRemoteWorkspaceUri(targets[0]!.host, targets[0]!.workspace), 'main.ts');
	const second = URI.joinPath(createSshRemoteWorkspaceUri(targets[1]!.host, targets[1]!.workspace), 'main.ts');
	assert.equal((await context.files.readFile(first)).content, 'build-a:main.ts');
	assert.equal((await context.files.readFile(second)).content, 'build-b:main.ts');
	const updated = 'changed 中文😀';
	const written = await context.files.writeFile({ resource: second, content: updated });
	assert.equal(written.stat.sizeBytes, Buffer.byteLength(updated));
	assert.equal(written.revision, 'r2');
	assert.deepEqual(context.resourceRequests, [
		'build-a:open:resource-1', 'build-a:read:resource-1', 'build-a:release:resource-1',
		'build-b:open:resource-1', 'build-b:read:resource-1', 'build-b:release:resource-1',
	]);
	assert.equal(context.openResources.size, 0);
	assert.deepEqual(context.fileRequests, [
		{ host: 'build-a', operation: 'read', path: 'main.ts' },
		{ host: 'build-b', operation: 'read', path: 'main.ts' },
		{ host: 'build-b', operation: 'write', path: 'main.ts' },
	]);
	assert.equal((await context.files.readFile(second)).content, updated);
	assert.equal((await context.files.readFile(first)).content, 'build-a:main.ts');
	const disconnect = context.commands.executeCommand(manageHosts);
	await context.choose('Disconnect: build-a');
	await disconnect;
	await assert.rejects(context.files.readFile(first));
	assert.equal((await context.files.readFile(second)).content, updated);
	context.scopeOwner.dispose();
	await assert.rejects(context.files.readFile(second));
	assert.deepEqual(context.primaryRequests, []);
	assert.equal(context.openResources.size, 0);
});

test('Agents scopes on the same authority keep distinct roots and choose the longest matching root', async () => {
	const nested = { name: 'build-nested', host: targets[0]!.host, workspace: '/srv/project/nested' };
	using context = fixture([...targets, nested]);
	await context.connect('build-a');
	await context.connect('build-nested');
	const outerFile = URI.joinPath(createSshRemoteWorkspaceUri(targets[0]!.host, targets[0]!.workspace), 'main.ts');
	const nestedFile = URI.joinPath(createSshRemoteWorkspaceUri(nested.host, nested.workspace), 'main.ts');
	assert.equal((await context.files.readFile(outerFile)).content, 'build-a:main.ts');
	assert.equal((await context.files.readFile(nestedFile)).content, 'build-nested:main.ts');
	assert.deepEqual(context.fileRequests, [
		{ host: 'build-a', operation: 'read', path: 'main.ts' },
		{ host: 'build-nested', operation: 'read', path: 'main.ts' },
	]);
	assert.deepEqual(context.errors, []);
});

test('Agents file changes preserve their originating authority and stop after scope disconnect', async () => {
	using context = fixture();
	await context.connect('build-a');
	await context.connect('build-b');
	const changes: IFileChangeEvent[] = [];
	using listener = context.files.onDidChangeFiles(change => changes.push(change));
	context.changeFiles('build-a', 'main.ts');
	context.changeFiles('build-b', 'main.ts');
	assert.deepEqual(changes.map(change => change.resources?.map(resource => resource.toString())), [
		[URI.joinPath(createSshRemoteWorkspaceUri(targets[0]!.host, targets[0]!.workspace), 'main.ts').toString()],
		[URI.joinPath(createSshRemoteWorkspaceUri(targets[1]!.host, targets[1]!.workspace), 'main.ts').toString()],
	]);
	const disconnect = context.commands.executeCommand(manageHosts);
	await context.choose('Disconnect: build-a');
	await disconnect;
	const observed = changes.length;
	context.changeFiles('build-a', 'retired.ts');
	assert.equal(changes.length, observed);
	context.changeFiles('build-b', 'current.ts');
	assert.deepEqual(changes.at(-1)!.resources?.map(resource => resource.toString()), [URI.joinPath(createSshRemoteWorkspaceUri(targets[1]!.host, targets[1]!.workspace), 'current.ts').toString()]);
});
