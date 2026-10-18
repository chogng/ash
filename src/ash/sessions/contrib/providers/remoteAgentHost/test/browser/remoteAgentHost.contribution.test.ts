import { browserEnvironment } from '../../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'mocha';
import { DeferredPromise, raceCancellationError } from '../../../../../../base/common/async.js';
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
import type { Automation, IAutomationBackendService } from '../../../../../../platform/agentHost/common/automation.js';
import { ContextKeyService } from '../../../../../../platform/contextkey/browser/contextKeyService.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { IQuickInputService, type IQuickPick, type IQuickPickItem } from '../../../../../../platform/quickinput/common/quickInput.js';
import { TestQuickInputService } from '../../../../../../platform/quickinput/test/browser/testQuickInputService.js';
import { IRemoteConnectionApi, IRemoteConnectionService, RemoteConnectionService, type RemoteConnectionDefinition } from '../../../../../../platform/remote/common/remoteConnectionService.js';
import { URI } from '../../../../../../base/common/uri.js';
import { AgentHostFileSystemProvider } from '../../../../../../platform/agentHost/common/agentHostFileSystemProvider.js';
import { FileService } from '../../../../../../platform/files/common/fileService.js';
import { IFileService, type IFileChangeEvent } from '../../../../../../platform/files/common/files.js';
import { createSshRemoteWorkspaceUri } from '../../../../../../platform/remote/common/remote.js';
import { AgentHostFileSystemService, IAgentHostFileSystemService } from '../../../../../../workbench/services/agentHost/common/agentHostFileSystemService.js';
import { IRendererHostService, type IRendererAgentHost, type IRendererAgentHostConnection, type IRendererHost } from '../../../../../../platform/renderer/common/rendererHost.js';
import { createDisconnectedRendererApi } from '../../../../../../workbench/browser/rendererApi.js';
import { CommandService } from '../../../../../../workbench/services/commands/common/commandService.js';
import { productLanguagePackCatalogs } from '../../../../../../workbench/services/localization/common/localizationCatalogs.js';
import { NotificationService } from '../../../../../../workbench/services/notification/common/notificationService.js';
import { ISessionsProvidersService, SessionsProvidersService } from '../../../../../services/sessions/browser/sessionsProvidersService.js';
import { ProviderAutomationService } from '../../../../automations/browser/providerAutomationService.js';
import { SSHAgentHostContribution } from '../../browser/sshAgentHost.contribution.js';

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
	const contexts = lifetime.add(new ContextKeyService());
	const quickInput = lifetime.add(new TestQuickInputService({ container, instantiationService: services, contextKeyService: contexts }));
	services.registerInstance(IQuickInputService, quickInput);
	const notifications = lifetime.add(new NotificationService());
	services.registerInstance(INotificationService, notifications);
	const errors: string[] = [];
	lifetime.add(notifications.model.onDidAdd(item => errors.push(String(item.message))));
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
	const renamed: string[] = [];
	const deleted: string[] = [];
	let openResult: ((target: RemoteConnectionDefinition, host: IRendererAgentHost) => Promise<IRendererAgentHost>) | undefined;
	const renderer = createDisconnectedRendererApi();
	services.registerInstance(IConfigurationService, lifetime.add(new InMemoryConfigurationService()));
	services.registerInstance(ILanguageModelsConfigurationService, {
		onDidChangeModels: Event.None, getDefaultNewChatModel: () => undefined,
		rememberSelectedModel: () => { }, isModelVisible: () => true, setModelVisible: async () => { },
	});
	const hostChanges = lifetime.add(new Emitter<void>());
	const hosts = new Map<string, IRendererAgentHostConnection>();
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
	type HostEvent = Parameters<Parameters<IRendererHost['events']['subscribe']>[0]>[0];
	const hostEvents = new Map<string, Emitter<HostEvent>>();
	const fileRequests: { host: string; operation: string; path: string; }[] = [];
	const resourceRequests: string[] = [];
	const openResources = new Set<string>();

	services.registerInstance(IRendererHostService, {
		...renderer,
		agentHosts: {
			get connections() { return [...hosts.values()]; },
			onDidChangeConnections: hostChanges.event,
			disconnect,
			reconnect: async () => { },
			connect: async (target, signal) => {
				const key = agentHostConnectionAddress(target);
				const existing = hosts.get(key);
				if (existing?.host) return existing.host;
				opened.push(target.name);
				const session: AgentSession = {
					sessionId: 'same-session', title: target.name, status: 'active',
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
				const events = lifetime.add(new Emitter<HostEvent>());
				hostEvents.set(target.name, events);
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
				const api: IRendererHost = {
					...renderer, automation,
					events: { subscribe: listener => events.event(listener) },
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
						readFile: async params => {
							fileRequests.push({ host: target.name, operation: 'read', path: params.path });
							assert.equal(params.dirId, `agent-host:${target.name}`);
							const stored = readStored(params.path);
							return { content: stored.bytes.toString('utf8'), revision: stored.revision };
						},
						readBinaryFile: async params => {
							fileRequests.push({ host: target.name, operation: 'read', path: params.path });
							assert.equal(params.dirId, `agent-host:${target.name}`);
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
							assert.equal(params.dirId, `agent-host:${target.name}`);
							return writeStored(params.path, Buffer.from(params.dataBase64, 'base64'));
						},
						writeFile: async params => {
							fileRequests.push({ host: target.name, operation: 'write', path: params.path });
							assert.equal(params.dirId, `agent-host:${target.name}`);
							return writeStored(params.path, Buffer.from(params.content));
						},
					},
					appServer: { ...renderer.appServer, getConnectionState: async () => 'ready' },
					session: {
						...renderer.session,
						subscribeCatalog: async () => ({ sessions: [session] }), unsubscribeCatalog: async () => { },
						rename: async params => { renamed.push(`${target.name}:${params.sessionId}`); return { session: { ...session, title: params.title }, agentTree: { roots: [] } }; },
					},
				};
				const host: IRendererAgentHost = {
					id: target.name, connection: target, api, ...toDisposable(() => {
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
	const contribution = lifetime.add(services.createInstance(SSHAgentHostContribution));
	const commands = lifetime.add(new CommandService(services));
	const automations = lifetime.add(services.createInstance(ProviderAutomationService));
	function picker(): IQuickPick<IQuickPickItem> {
		assert.ok(quickInput.currentQuickInput);
		return quickInput.currentQuickInput as IQuickPick<IQuickPickItem>;
	}
	async function choose(label: string): Promise<void> {
		const current = picker();
		const item = current.items.find(item => 'label' in item && item.label === label);
		assert.ok(item && !('type' in item), `Missing choice: ${label}`);
		current.activeItems = [item];
		current.selectedItems = [item];
		await current.accept();
	}
	async function connect(name: string): Promise<void> {
		const result = commands.executeCommand(manageHosts);
		const shown = new DeferredPromise<void>();
		using listener = quickInput.onShow(() => { void shown.complete(); });
		await choose('Connect a Saved SSH Host…');
		await shown.p;
		await choose(name);
		await result;
	}
	return {
		[Symbol.dispose]: () => lifetime.dispose(),
		services, commands, contribution, registry, automations, quickInput, errors,
		opened, closed, renamed, deleted, connect, choose, picker, files, fileRequests, primaryRequests, resourceRequests, openResources,
		changeFiles: (name: string, path: string) => hostEvents.get(name)!.fire({ method: 'fs/changed', params: { type: 'pathsChanged', dirId: `agent-host:${name}`, paths: [path] } }),
		deferOpen: (next: typeof openResult) => { openResult = next; },
	};
}

test('Agents host command registers independent providers and routes equal backend IDs through their own domains', async () => {
	using context = fixture();
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

test('disconnecting one Agents host unregisters its provider and retains the other host', async () => {
	using context = fixture();
	await context.connect('build-a');
	await context.connect('build-b');
	const result = context.commands.executeCommand(manageHosts);
	await context.choose('build-a');
	await result;
	assert.deepEqual(context.closed, ['build-a']);
	assert.deepEqual(context.registry.getProviders().map(provider => provider.label), ['build-b']);
	await context.automations.refresh();
	assert.deepEqual(context.automations.automations.get().map(plan => plan.name), ['build-b']);
});

test('reselecting an already connected target shares the existing scope', async () => {
	using context = fixture();
	await context.connect('build-a');
	await context.connect('build-a');
	assert.deepEqual(context.opened, ['build-a']);
	assert.equal(context.registry.getProviders().length, 1);
});

test('closing the Agents owner retires pending setup and releases its late result', async () => {
	using context = fixture();
	const entered = new DeferredPromise<void>();
	const release = new DeferredPromise<void>();
	context.deferOpen(async (_target, host) => { void entered.complete(); await release.p; return host; });
	const connecting = context.connect('build-a');
	await entered.p;
	context.contribution.dispose();
	await release.complete();
	await connecting;
	assert.deepEqual(context.closed, ['build-a']);
	assert.deepEqual(context.registry.getProviders(), []);
	assert.deepEqual(context.errors, []);
});

test('the host picker uses Chinese labels and closes on cancellation and owner disposal', async () => {
	using context = fixture();
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsMessages(chinese.locale, chinese.bundles);
	try {
		const command = context.commands.executeCommand(manageHosts);
		assert.equal(context.picker().ariaLabel, '连接宿主，或选择已连接宿主以断开连接');
		assert.equal(context.picker().items[0]!.label, '连接已保存的 SSH 宿主…');
		context.picker().hide();
		await command;
		const interrupted = context.commands.executeCommand(manageHosts);
		context.contribution.dispose();
		await interrupted;
		assert.equal(context.quickInput.currentQuickInput, undefined);
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
	await context.choose('build-a');
	await disconnect;
	await assert.rejects(context.files.readFile(first));
	assert.equal((await context.files.readFile(second)).content, updated);
	context.contribution.dispose();
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
	await context.choose('build-a');
	await disconnect;
	const observed = changes.length;
	context.changeFiles('build-a', 'retired.ts');
	assert.equal(changes.length, observed);
	context.changeFiles('build-b', 'current.ts');
	assert.deepEqual(changes.at(-1)!.resources?.map(resource => resource.toString()), [URI.joinPath(createSshRemoteWorkspaceUri(targets[1]!.host, targets[1]!.workspace), 'current.ts').toString()]);
});
