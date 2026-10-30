import { TestWorkspaceTrustManagementService } from '../../../../test/common/workbenchTestServices.js';
import { IWorkspaceTrustManagementService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { createEmptyTestLanguagePacks } from '../../../localization/test/common/localizationTestUtils.js';
import { ILanguagePackService } from '../../../../../platform/languagePacks/common/languagePacks.js';
import { IExtensionApi } from '../../../../../platform/extensions/common/extensionApi.js';
import { ExtensionResourceLoaderService } from '../../../../../platform/extensionResourceLoader/browser/extensionResourceLoaderService.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { Emitter } from '../../../../../base/common/event.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import type { AppServerConnectionState } from '../../../../../platform/agentHost/common/appServerApi.js';
import { WebWorkerExtensionHost } from '../../browser/webWorkerExtensionHost.js';
import { type BrowserExtensionHostRequest } from '../../common/extensionHostProtocol.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IAppServerApi } from '../../../../../platform/agentHost/common/appServerApi.js';
import { normalizeExtensionHostSnapshot } from '../../../../../platform/agentHost/browser/extensionHostProtocol.js';
import { type ExtensionHostFleetSnapshot, type ExtensionHostInvocationRequest, type IExtensionHostApi, type JsonValue } from '../../../../../platform/agentHost/common/extensionHostApi.js';

import { createExtensionBackendApi } from '../../../../../platform/agentHost/browser/extensionBackendApi.js';
import type { AppServerProtocolClient } from '../../../../../platform/agentHost/browser/appServerProtocolClient.js';

test('extension backend routes decode parameters before using the protocol connection', async () => {
	const requests: unknown[] = [];
	const connection = { request: async (definition: unknown, params: unknown) => { requests.push({ definition, params }); return null; } } as unknown as AppServerProtocolClient;
	const backend = createExtensionBackendApi(connection);
	const signal = new AbortController().signal;
	await assert.rejects(backend.request('not/a/method', {}, signal), /Unknown extension backend route/);
	await assert.rejects(backend.request('git/status', 'not an object', signal));
	assert.deepEqual(requests, []);
	assert.equal(await backend.request('git/status', { repositoryId: null }, signal), null);
	assert.deepEqual(requests, [{ definition: { method: 'git/status' }, params: { repositoryId: null } }]);
	const cancelled = new AbortController();
	cancelled.abort();
	await assert.rejects(backend.request('git/status', { repositoryId: null }, cancelled.signal));
	assert.equal(requests.length, 1);
});

class WorkspaceTrust extends TestWorkspaceTrustManagementService {
	readonly invalidations = this._register(new Emitter<void>());
	override readonly onDidChangeTrustedFolders = this.invalidations.event;
}

class RemoteHost extends Disposable implements IExtensionHostApi {
	constructor() {
		super();
		this.instantiation.registerInstance(IWorkspaceTrustManagementService, this.trust);
		this.instantiation.registerInstance(ILanguagePackService, createEmptyTestLanguagePacks());
		this.instantiation.registerInstance(IExtensionApi, { list: async () => ({ generation: 1, extensions: [], diagnostics: [] }), resources: new ExtensionResourceLoaderService(async () => new Uint8Array()) });
	}
	readonly trust = this._register(new WorkspaceTrust());
	readonly instantiation = this._register(new InstantiationService());
	private readonly changes = this._register(new Emitter<number>());
	private readonly connection = this._register(new Emitter<AppServerConnectionState>());
	readonly activation = new DeferredPromise<ExtensionHostFleetSnapshot>();
	readonly read = new DeferredPromise<ExtensionHostFleetSnapshot>();
	readonly readStarted = new DeferredPromise<void>();
	registerClientHandler(): { dispose(): void; } { throw new Error('Client calls are outside this fixture'); }
	start(): Promise<ExtensionHostFleetSnapshot> { throw new Error('Startup is outside this fixture'); }
	isAvailable(): Promise<boolean> { return Promise.resolve(true); }
	getConnectionState(): Promise<AppServerConnectionState> { return Promise.resolve('ready'); }
	list(): Promise<ExtensionHostFleetSnapshot> { void this.readStarted.complete(); return this.read.p; }
	reconcile(): Promise<ExtensionHostFleetSnapshot> { return Promise.resolve(snapshot(1, 'dormant')); }
	activateByEvent(): Promise<ExtensionHostFleetSnapshot> { return this.activation.p; }
	invoke(_request: ExtensionHostInvocationRequest, _signal: AbortSignal): Promise<JsonValue> { throw new Error('Provider calls are outside this fixture'); }
	onDidChange(listener: (generation: number) => void) { return this.changes.event(listener); }
	onConnectionState(listener: (state: AppServerConnectionState) => void) { return this.connection.event(listener); }
	notify(): void { this.changes.fire(2); }
	disconnect(): void { this.connection.fire('stopped'); }
}

function snapshot(generation: number, lifecycle: 'dormant' | 'ready'): ExtensionHostFleetSnapshot {
	return normalizeExtensionHostSnapshot({
		generation, extensions: [{
			id: 'lazy', version: '1', packageDigest: `sha256:${'a'.repeat(64)}`, runtimeApiVersion: 1,
			activationGeneration: 7, incarnation: lifecycle === 'ready' ? 1 : null, lifecycle,
			failure: null, stderr: '', outputEvents: [],
			...(lifecycle === 'dormant' ? { activation: { events: ['onCommand:lazy.run'], commands: [{ command: 'lazy.run', title: 'Run' }] } } : {}),
			registrations: lifecycle === 'ready' ? [{ kind: 'command', registrationId: 'callback', command: 'lazy.run', title: 'Run' }] : [],
		}]
	});
}

function browser(remote: RemoteHost): WebWorkerExtensionHost {
	return new WebWorkerExtensionHost({
		list: async () => ({ generation: 1, extensions: [], diagnostics: [] }),
		resources: new ExtensionResourceLoaderService(async () => { throw new Error('Bundled resources are outside this fixture'); }),
	}, remote, remote.instantiation, remote.trust);
}

const request = { extensionId: 'lazy', activationGeneration: 7, event: { type: 'command' as const, command: 'lazy.run' } };

test('workspace trust gates built-in browser activation and retires old command registrations', async () => {
	const originalWorker = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
	const activated: string[] = [];
	const terminated: string[] = [];
	class WorkerFixture extends EventTarget {
		private id = '';
		postMessage(message: BrowserExtensionHostRequest): void {
			if (message.type === 'activate') { this.id = message.extensionId; activated.push(this.id); }
			queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', {
				data: {
					id: message.id, success: true, result: message.type === 'activate'
						? [{ kind: 'command', registrationId: 'callback', command: `${this.id}.run`, title: 'Run' }] : null,
				}
			})));
		}
		terminate(): void { terminated.push(this.id); }
	}
	Object.defineProperty(globalThis, 'Worker', { configurable: true, value: WorkerFixture });
	try {
		using remote = new RemoteHost();
		await remote.trust.setWorkspaceTrust(false);
		remote.reconcile = remote.list = async () => ({ generation: 1, extensions: [] });
		remote.registerClientHandler = () => Disposable.None;
		const declarations = [undefined, false, true, 'limited', 'true'];
		const extensions: IExtensionApi = {
			list: async () => ({
				generation: 1, diagnostics: [], extensions: declarations.map((supported, index) => ({
					id: `builtin.${index}`, name: String(index), publisher: 'builtin', displayName: String(index), version: '1', sourceKind: 'builtIn',
					manifestJson: JSON.stringify({ browser: 'main.js', capabilities: { untrustedWorkspaces: { supported } } }),
					manifestSha256: `sha256:${'a'.repeat(64)}`, packageSha256: `sha256:${'b'.repeat(64)}`,
				}))
			}),
			resources: new ExtensionResourceLoaderService(async () => new Uint8Array()),
		};
		using api = remote.instantiation.createInstance(WebWorkerExtensionHost, extensions, remote);
		const registration = api.registerClientHandler(async () => ({ result: 'initialization', initialization: { workspaceFolders: [], workspaceName: null, workspaceFile: null, configurationValues: {}, configurationData: null } }));
		using handler = toDisposable(() => registration.dispose());
		assert.deepEqual((await api.reconcile('refresh')).extensions.map(runtime => runtime.id), ['builtin.2', 'builtin.3']);
		assert.deepEqual(activated, ['builtin.2', 'builtin.3']);
		await remote.trust.setWorkspaceTrust(true);
		const trusted = await api.list();
		assert.equal(trusted.extensions.length, 5);
		const previous = trusted.extensions.find(runtime => runtime.id === 'builtin.0')!;
		remote.trust.invalidations.fire();
		assert.deepEqual((await api.list()).extensions.map(runtime => runtime.id), ['builtin.2', 'builtin.3']);
		await api.reconcile('refresh');
		assert.equal((await api.list()).extensions.length, 5, 'An unchanged trust refresh restores required Workers');
		await remote.trust.setWorkspaceTrust(false);
		assert.deepEqual((await api.list()).extensions.map(runtime => runtime.id), ['builtin.2', 'builtin.3']);
		assert.deepEqual(terminated.sort(), ['builtin.0', 'builtin.0', 'builtin.1', 'builtin.1', 'builtin.4', 'builtin.4']);
		await assert.rejects(api.invoke({ extensionId: previous.id, activationGeneration: previous.activationGeneration, incarnation: previous.incarnation!, registrationId: 'callback', operation: 'execute', payload: {}, deadlineUnixMillis: Date.now() + 5_000 }, new AbortController().signal), /retired activation/);
		assert.equal(activated.filter(id => id === 'builtin.2').length, 1, 'Restricted Mode retains a healthy opted-in Worker');
	} finally {
		if (originalWorker) Object.defineProperty(globalThis, 'Worker', originalWorker);
		else Reflect.deleteProperty(globalThis, 'Worker');
	}
});

test('invalid client results reject the Worker call instead of stranding its pending request', async () => {
	const originalWorker = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
	let worker!: WorkerFixture;
	const replied = new DeferredPromise<{ success: boolean; error?: string; }>();
	class WorkerFixture extends EventTarget {
		constructor() { super(); worker = this; }
		postMessage(message: BrowserExtensionHostRequest | { type: 'commandResult'; success: boolean; error?: string; }): void {
			if (message.type === 'commandResult') { void replied.complete(message); return; }
			queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: { id: message.id, success: true, result: message.type === 'activate' ? [] : null } })));
		}
		terminate(): void { }
	}
	Object.defineProperty(globalThis, 'Worker', { configurable: true, value: WorkerFixture });
	try {
		using remote = new RemoteHost();
		remote.reconcile = remote.list = async () => ({ generation: 1, extensions: [] });
		remote.registerClientHandler = () => Disposable.None;
		using api = new WebWorkerExtensionHost({
			list: async () => ({ generation: 1, diagnostics: [], extensions: [{ id: 'browser', name: 'browser', publisher: 'test', version: '1', displayName: 'Browser', sourceKind: 'builtIn', manifestJson: '{"browser":"./browser.js"}', manifestSha256: `sha256:${'a'.repeat(64)}`, packageSha256: `sha256:${'a'.repeat(64)}` }] }),
			resources: new ExtensionResourceLoaderService(async () => new Uint8Array()),
		}, remote, remote.instantiation, remote.trust);
		const handler = api.registerClientHandler(async operation => (operation as { operation: string; }).operation === 'readInitialization'
			? { result: 'initialization', initialization: { workspaceFolders: [], workspaceName: null, workspaceFile: null, configurationValues: {}, configurationData: null } }
			: { result: 'command', hasValue: true, value: NaN });
		using registration = toDisposable(() => handler.dispose());
		await api.reconcile('refresh');
		worker.dispatchEvent(new MessageEvent('message', { data: { type: 'clientRequest', id: 1, request: { operation: 'executeCommand', command: 'test.invalid', arguments: [] } } }));
		const result = await replied.p;
		assert.equal(result.success, false);
		assert.match(result.error!, /non-finite/u);
	} finally {
		if (originalWorker) Object.defineProperty(globalThis, 'Worker', originalWorker);
		else delete (globalThis as { Worker?: unknown; }).Worker;
	}
});

test('readable user and registry browser packages do not gain client execution authority', async () => {
	using remote = new RemoteHost();
	remote.reconcile = remote.list = async () => ({ generation: 1, extensions: [] });
	let reads = 0;
	using api = new WebWorkerExtensionHost({
		list: async () => ({
			generation: 1, diagnostics: [], extensions: ['user', 'registry'].map(sourceKind => ({
				id: `test.${sourceKind}`, name: sourceKind, publisher: 'test', version: '1', displayName: sourceKind,
				sourceKind: sourceKind as 'user' | 'registry', manifestJson: '{"browser":"main.js"}',
				manifestSha256: `sha256:${'a'.repeat(64)}`, packageSha256: `sha256:${'b'.repeat(64)}`,
			}))
		}),
		resources: new ExtensionResourceLoaderService(async () => { reads++; throw new Error('Unauthorized browser entry'); }),
	}, remote, remote.instantiation, remote.trust);
	assert.deepEqual((await api.reconcile('refresh')).extensions, []);
	assert.equal(reads, 0);
});

test('declarative packages do not delay executable host startup with translation reads', async () => {
	using remote = new RemoteHost();
	let reconciled = false;
	let resourceReads = 0;
	remote.reconcile = async () => { reconciled = true; return { generation: 1, extensions: [] }; };
	const extensions: IExtensionApi = {
		list: async () => ({
			generation: 1, diagnostics: [], extensions: [{
				id: 'static', name: 'static', publisher: 'test', version: '1', displayName: 'Static', sourceKind: 'builtIn',
				manifestJson: '{"displayName":"%name%","contributes":{"themes":[]}}',
				manifestSha256: `sha256:${'a'.repeat(64)}`, packageSha256: `sha256:${'a'.repeat(64)}`,
			}],
		}),
		resources: new ExtensionResourceLoaderService(async () => { resourceReads++; return new Uint8Array(); }),
	};
	using catalogServices = remote.instantiation.createChild(new ServiceCollection([IExtensionApi, extensions]));
	using api = new WebWorkerExtensionHost(extensions, remote, catalogServices, remote.trust);
	assert.deepEqual((await api.reconcile('refresh')).extensions, []);
	assert.equal(reconciled, true);
	assert.equal(resourceReads, 0);
});

test('browser refresh preserves unchanged Workers and pending calls, and cleans up changed packages before replacement', async () => {
	const originalWorker = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
	const order: string[] = [];
	const catalogReads: string[] = [];
	const urls: string[] = [];
	let digest = `sha256:${'a'.repeat(64)}`;
	const invoked = new DeferredPromise<void>();
	const statusUpdated = new DeferredPromise<void>();
	const status = { kind: 'statusBar', registrationId: 'test.status', revision: 1, entries: [] };
	let finishInvocation: (() => void) | undefined;
	let activeWorker: WorkerFixture;
	class WorkerFixture extends EventTarget {
		constructor() { super(); activeWorker = this; }
		postMessage(message: BrowserExtensionHostRequest): void {
			queueMicrotask(() => {
				if (message.type === 'activate') {
					order.push('activate');
					const url = URL.createObjectURL(new Blob(['style']));
					urls.push(url);
					this.dispatchEvent(new MessageEvent('message', { data: { type: 'webviewResource', url } }));
					this.dispatchEvent(new MessageEvent('message', { data: { id: message.id, success: true, result: [{ kind: 'dataChannel', registrationId: 'test.image', channelId: 'image.editor.v1' }, status] } }));
				} else if (message.type === 'deactivate') {
					order.push('deactivate');
					this.dispatchEvent(new MessageEvent('message', { data: { type: 'releaseWebviewResource', url: urls.at(-1) } }));
					this.dispatchEvent(new MessageEvent('message', { data: { id: message.id, success: true, result: null } }));
				} else if (message.type === 'invoke') {
					finishInvocation = () => this.dispatchEvent(new MessageEvent('message', { data: { id: message.id, success: true, result: 'completed' } }));
					void invoked.complete();
				} else if (message.type === 'commandResult') {
					assert.equal(message.success, true);
					void statusUpdated.complete();
				} else assert.fail(`Unexpected Worker request: ${message.type}`);
			});
		}
		terminate(): void { order.push('terminate'); }
	}
	Object.defineProperty(globalThis, 'Worker', { configurable: true, value: WorkerFixture });
	try {
		using remote = new RemoteHost();
		remote.reconcile = remote.list = async () => ({ generation: 1, extensions: [] });
		remote.registerClientHandler = () => Disposable.None;
		// No callback requests a service in this lifecycle fixture.
		remote.instantiation.registerInstance(ICommandService, {} as ICommandService);
		remote.instantiation.registerInstance(IFileService, {} as IFileService);
		remote.instantiation.registerInstance(IWorkspaceContextService, {} as IWorkspaceContextService);
		remote.instantiation.registerInstance(IAppServerApi, {} as IAppServerApi);
		using api = new WebWorkerExtensionHost({
			list: async reload => {
				catalogReads.push(reload);
				return {
					generation: 1, diagnostics: [], extensions: [{
						id: 'browser', name: 'browser', publisher: 'test', version: '1', displayName: 'Browser', sourceKind: 'builtIn',
						manifestJson: JSON.stringify({ browser: './browser.js' }), manifestSha256: digest, packageSha256: digest,
					}]
				};
			},
			resources: new ExtensionResourceLoaderService(async () => new Uint8Array()),
		}, remote, remote.instantiation, remote.trust);
		const registration = api.registerClientHandler(async operation => {
			if ((operation as { operation: string; }).operation === 'setStatusBarEntries') return { result: 'done' };
			assert.deepEqual(operation, { operation: 'readInitialization' });
			return { result: 'initialization', initialization: { workspaceFolders: [], workspaceName: null, workspaceFile: null, configurationValues: {}, configurationData: null } };
		});
		using handler = toDisposable(() => registration.dispose());
		const activation = api.reconcile('refresh');
		assert.equal(api.reconcile('refresh'), activation, 'Concurrent reads share the existing activation');
		const original = (await activation).extensions[0]!;
		assert.equal(original.lifecycle, 'ready');
		assert.equal(await (await fetch(urls[0]!)).text(), 'style');
		const invocation = { extensionId: original.id, activationGeneration: original.activationGeneration, incarnation: original.incarnation!, registrationId: 'callback', operation: 'execute', payload: {}, deadlineUnixMillis: Date.now() + 10_000 };
		const pending = api.invoke(invocation, new AbortController().signal);
		await invoked.p;
		assert.deepEqual((await api.reconcile('refresh')).extensions[0], original);
		await remote.activation.complete(snapshot(2, 'ready'));
		assert.deepEqual((await api.activateByEvent(request)).extensions.find(runtime => runtime.id === original.id), original);
		assert.deepEqual(order, ['activate']);
		assert.equal(await (await fetch(urls[0]!)).text(), 'style');
		finishInvocation!();
		assert.equal(await pending, 'completed');
		assert.equal((await api.list()).extensions.find(runtime => runtime.id === original.id)!.registrations.length, 2);
		activeWorker!.dispatchEvent(new MessageEvent('message', { data: { type: 'registrationsChanged', snapshot: { revision: 1, registrations: [status] } } }));
		assert.deepEqual((await api.list()).extensions.find(runtime => runtime.id === original.id)!.registrations, [status]);
		activeWorker!.dispatchEvent(new MessageEvent('message', { data: { type: 'registrationsChanged', snapshot: { revision: 1, registrations: [{ kind: 'dataChannel', registrationId: 'late', channelId: 'image.editor.v1' }] } } }));
		assert.deepEqual((await api.list()).extensions.find(runtime => runtime.id === original.id)!.registrations, [status], 'an old transport revision cannot revive a retired registration');
		activeWorker!.dispatchEvent(new MessageEvent('message', { data: { type: 'clientRequest', id: 900, request: { operation: 'setStatusBarEntries', registrationId: 'test.status', revision: 2, entries: [] } } }));
		await statusUpdated.p;
		const refreshed = await api.reconcile('refresh');
		assert.deepEqual(refreshed.extensions.find(runtime => runtime.id === original.id)!.registrations, [{ ...status, revision: 2 }], 'consumed registration messages cannot roll back later acknowledged status-bar state');
		digest = `sha256:${'b'.repeat(64)}`;
		const replacement = (await api.reconcile('restartFailed')).extensions.find(runtime => runtime.id === original.id)!;
		assert.equal(replacement.lifecycle, 'ready');
		assert.notEqual(replacement.activationGeneration, original.activationGeneration);
		assert.deepEqual(catalogReads, ['cached', 'cached', 'cached', 'cached'], 'each reconciliation reads current backend packages without repeating source discovery');
		assert.deepEqual(order, ['activate', 'deactivate', 'terminate', 'activate']);
		await assert.rejects(fetch(urls[0]!));
		await assert.rejects(api.invoke(invocation, new AbortController().signal), /retired activation/);
		api.dispose();
		await assert.rejects(fetch(urls[1]!));
		assert.deepEqual(order, ['activate', 'deactivate', 'terminate', 'activate', 'terminate']);
	} finally {
		if (originalWorker) Object.defineProperty(globalThis, 'Worker', originalWorker);
		else Reflect.deleteProperty(globalThis, 'Worker');
		for (const url of urls) URL.revokeObjectURL(url);
	}
});

for (const revocation of ['disablement', 'workspace trust']) {
	test(`${revocation} during activation retires the Worker before publishing its contributions`, async () => {
		const originalWorker = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
		const started = new DeferredPromise<void>();
		let enabled = true;
		let reads = 0;
		let terminated = false;
		let reply: (() => void) | undefined;
		class WorkerFixture extends EventTarget {
			postMessage(message: BrowserExtensionHostRequest): void {
				if (message.type === 'deactivate') {
					queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: { id: message.id, success: true, result: null } })));
					return;
				}
				assert.equal(message.type, 'activate');
				reply = () => this.dispatchEvent(new MessageEvent('message', { data: { id: message.id, success: true, result: [] } }));
				void started.complete();
			}
			terminate(): void { terminated = true; }
		}
		Object.defineProperty(globalThis, 'Worker', { configurable: true, value: WorkerFixture });
		try {
			using remote = new RemoteHost();
			remote.reconcile = remote.list = async () => ({ generation: 1, extensions: [] });
			remote.registerClientHandler = () => Disposable.None;
			remote.instantiation.registerInstance(ICommandService, {} as ICommandService);
			remote.instantiation.registerInstance(IFileService, {} as IFileService);
			remote.instantiation.registerInstance(IWorkspaceContextService, {} as IWorkspaceContextService);
			remote.instantiation.registerInstance(IAppServerApi, {} as IAppServerApi);
			using changes = new Emitter<void>();
			using api = new WebWorkerExtensionHost({
				onDidChange: changes.event,
				list: async () => {
					reads++;
					return {
						generation: 1, diagnostics: [], extensions: enabled ? [{
							id: 'browser', name: 'browser', publisher: 'test', version: '1', displayName: 'Browser', sourceKind: 'builtIn',
							manifestJson: JSON.stringify({ browser: './browser.js' }), manifestSha256: `sha256:${'a'.repeat(64)}`, packageSha256: `sha256:${'a'.repeat(64)}`,
						}] : []
					};
				},
				resources: new ExtensionResourceLoaderService(async () => new Uint8Array()),
			}, remote, remote.instantiation, remote.trust);
			const registration = api.registerClientHandler(async () => ({ result: 'initialization', initialization: { workspaceFolders: [], workspaceName: null, workspaceFile: null, configurationValues: {}, configurationData: null } }));
			using handler = toDisposable(() => registration.dispose());
			const published: Promise<ExtensionHostFleetSnapshot>[] = [];
			const subscription = api.onDidChange(() => { published.push(api.list()); });
			using listener = toDisposable(() => subscription.dispose());
			const activation = api.reconcile('refresh');
			await started.p;
			let trustChange: Promise<void> | undefined;
			if (revocation === 'workspace trust') {
				trustChange = remote.trust.setWorkspaceTrust(false);
				remote.trust.invalidations.fire();
			} else {
				enabled = false;
				changes.fire();
			}
			assert.equal(api.reconcile('restartFailed'), activation);
			reply!();
			assert.deepEqual((await activation).extensions, []);
			await trustChange;
			if (revocation === 'disablement') assert.equal(reads, 2, 'The enablement event queues a fresh catalog read');
			else assert.ok(reads >= 2, 'Trust revocation queues a fresh catalog read');
			assert.equal(terminated, true);
			for (const fleet of await Promise.all(published)) { assert.deepEqual(fleet.extensions, []); }
		} finally {
			if (originalWorker) Object.defineProperty(globalThis, 'Worker', originalWorker);
			else Reflect.deleteProperty(globalThis, 'Worker');
		}
	});
}

test('first-use activation returns ready even while a notification refresh is pending', async () => {
	using remote = new RemoteHost();
	using api = browser(remote);
	await api.reconcile('refresh');
	const activation = api.activateByEvent(request);
	remote.notify();
	await remote.readStarted.p;
	await remote.activation.complete(snapshot(2, 'ready'));
	assert.equal((await activation).extensions[0]!.lifecycle, 'ready');
	await remote.read.complete(snapshot(1, 'dormant'));
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal((await api.list()).extensions[0]!.lifecycle, 'ready');
});

test('a completed newer refresh cannot be replaced by an older activation reply', async () => {
	using remote = new RemoteHost();
	using api = browser(remote);
	await api.reconcile('refresh');
	const activation = api.activateByEvent(request);
	remote.notify();
	await remote.readStarted.p;
	const applied = new DeferredPromise<void>();
	const registration = api.onDidChange(() => { void applied.complete(); });
	using subscription = toDisposable(() => registration.dispose());
	await remote.read.complete(snapshot(3, 'ready'));
	await applied.p;
	await remote.activation.complete(snapshot(2, 'dormant'));
	assert.equal((await activation).extensions[0]!.lifecycle, 'ready');
});

test('activation replies from a disconnected backend cannot restore remote contributions', async () => {
	using remote = new RemoteHost();
	using api = browser(remote);
	await api.reconcile('refresh');
	const activation = api.activateByEvent(request);
	remote.disconnect();
	await remote.activation.complete(snapshot(2, 'ready'));
	await assert.rejects(activation, /retired activation/);
	assert.deepEqual((await api.list()).extensions, []);
});

for (const id of ['external.ssh']) {
	test(`the external host cannot claim the product SSH resolver as ${id}`, async () => {
		using remote = new RemoteHost();
		remote.reconcile = async () => normalizeExtensionHostSnapshot({
			generation: 1, extensions: [{
				id, version: '1', packageDigest: `sha256:${'a'.repeat(64)}`, runtimeApiVersion: 1,
				activationGeneration: 1, incarnation: 1, lifecycle: 'ready', failure: null, stderr: '', outputEvents: [],
				registrations: [{ kind: 'remoteConnectionResolver', registrationId: 'ssh', authorityPrefix: 'ssh' }],
			}],
		});
		using api = browser(remote);
		await assert.rejects(api.reconcile('refresh'), /SSH extension|ssh prefix/);
		assert.deepEqual((await api.list()).extensions, []);
	});
}

test('the backend product SSH resolver uses the same remote host invocation path', async () => {
	using remote = new RemoteHost();
	remote.reconcile = async () => normalizeExtensionHostSnapshot({
		generation: 1, extensions: [{
			id: 'ash.remote-ssh', version: '1', packageDigest: `sha256:${'a'.repeat(64)}`, runtimeApiVersion: 1,
			activationGeneration: 1, incarnation: 1, lifecycle: 'ready', failure: null, stderr: '', outputEvents: [],
			registrations: [{ kind: 'remoteConnectionResolver', registrationId: 'remote:ssh', authorityPrefix: 'ssh' }],
		}],
	});
	using api = browser(remote);
	assert.equal((await api.reconcile('refresh')).extensions[0]?.id, 'ash.remote-ssh');
	const request = { extensionId: 'ash.remote-ssh', activationGeneration: 1, incarnation: 1, registrationId: 'remote:ssh', operation: 'resolveConnection', payload: { authority: 'ssh+build' }, deadlineUnixMillis: Date.now() + 5_000 };
	const cancellation = new AbortController();
	remote.invoke = async (actual, signal) => { assert.deepEqual(JSON.parse(JSON.stringify(actual)), request); assert.equal(signal, cancellation.signal); return { connectionName: 'build' }; };
	assert.deepEqual(await api.invoke(request, cancellation.signal), { connectionName: 'build' });
	remote.disconnect();
	assert.deepEqual((await api.list()).extensions, []);
});
