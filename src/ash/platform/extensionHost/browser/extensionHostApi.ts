import type { ExtensionHostReconcileMode, IExtensionHostApi } from "../common/extensionHostApi.js";
import { invokeExtensionHost, normalizeExtensionHostChanged, normalizeExtensionHostSnapshot } from "../common/extensionHostApi.js";
import type { UnavailableOperation } from "../../renderer/browser/disconnectedHost.js";
import type { AppServerProtocolClient } from "../../app-server/browser/appServerProtocolClient.js";
import { appServerRequest } from "../../app-server/browser/appServerRequest.js";
import { APP_SERVER_SERVER_REQUESTS } from '../../../../../.build/protocol/typescript/index.js';
import type { JsonValue as ProtocolJsonValue } from '../../../../../.build/protocol/typescript/index.js';
import type { ExtensionClientHandler } from '../common/extensionHostApi.js';
import { inertSubscription } from "../../renderer/browser/disconnectedHost.js";
import { Disposable, DisposableMap, combinedDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { IFileService, FileKind, FileNotFoundError } from '../../files/common/files.js';
import { IFileSystemProviderService } from '../../files/common/fileSystemProviderService.js';
import { IAppServerApi } from '../../app-server/common/appServerApi.js';
import { IWorkspaceContextService } from '../../workspace/common/workspace.js';
import { IInstantiationService } from '../../instantiation/common/instantiation.js';
import type { ExtensionClientOperation } from '../common/extensionHostApi.js';
import { Emitter } from '../../../base/common/event.js';
import type { IExtensionApi, ExtensionDescriptor } from '../../extensions/common/extensionApi.js';
import { getNLSLanguage, localize } from '../../../nls.js';
import { ICommandService } from '../../commands/common/commands.js';
import { normalizeExtensionHostInvocationRequest, normalizeExtensionHostPayload, type ExtensionHostFleetSnapshot, type ExtensionHostRuntime, type JsonValue } from '../common/extensionHostApi.js';

export type BrowserExtensionHostRequest =
	| { readonly id: number; readonly type: 'activate'; readonly entryPoint: string; readonly language: string; }
	| { readonly id: number; readonly type: 'invoke'; readonly request: Parameters<IExtensionHostApi['invoke']>[0]; }
	| { readonly id: number; readonly type: 'cancel'; readonly invocationId: number; }
	| { readonly id: number; readonly type: 'commandResult'; readonly success: true; readonly result: JsonValue; }
	| { readonly id: number; readonly type: 'commandResult'; readonly success: false; readonly error: string; };

/** A package snapshot is executed in a window-owned Worker, never in the Workbench realm. */
export class BrowserExtensionHostApi extends Disposable implements IExtensionHostApi {
	public registerClientHandler(handler: ExtensionClientHandler): ReturnType<IExtensionHostApi['registerClientHandler']> {
		if (this.clientHandler) throw new Error('An extension client handler is already registered');
		const remote = this.remote.registerClientHandler(handler);
		this.clientHandler = handler;
		return combinedDisposable(toDisposable(() => remote.dispose()), toDisposable(() => { this.clientHandler = undefined; }));
	}
	private clientHandler: ExtensionClientHandler | undefined;
	private readonly workers = this._register(new DisposableMap<string, BrowserExtensionWorker>());
	private readonly changes = this._register(new Emitter<number>());
	private generation = 0;
	private snapshot: ExtensionHostFleetSnapshot = { generation: 1, extensions: [] };
	private refreshing: Promise<ExtensionHostFleetSnapshot> | undefined;
	private remoteSnapshot: ExtensionHostFleetSnapshot = { generation: 1, extensions: [] };
	private remoteRevision = 0;
	private remoteConnectionRevision = 0;

	constructor(private readonly extensions: IExtensionApi, private readonly remote: IExtensionHostApi,
		@IInstantiationService private readonly instantiation: IInstantiationService) {
		super();
		const changes = remote.onDidChange(() => { void this.refreshRemote().catch(error => console.error('Extension Host refresh failed', error)); });
		this._register(toDisposable(() => changes.dispose()));
		const connection = remote.onConnectionState(state => {
			this.remoteConnectionRevision++;
			if (state === 'ready') void this.refreshRemote().catch(error => console.error('Extension Host refresh failed', error));
			else { this.remoteRevision++; this.remoteSnapshot = { generation: 1, extensions: [] }; this.changes.fire(++this.snapshotGeneration); }
		});
		this._register(toDisposable(() => connection.dispose()));
	}
	private snapshotGeneration = 1;

	public async isAvailable(): Promise<boolean> { return true; }
	public async getConnectionState(): Promise<'ready'> { return 'ready'; }
	public onDidChange(listener: (generation: number) => void): ReturnType<IExtensionHostApi['onDidChange']> { return this.changes.event(listener); }
	public onConnectionState(): ReturnType<IExtensionHostApi['onConnectionState']> { return Disposable.None; }
	public async list(): Promise<ExtensionHostFleetSnapshot> {
		return { generation: this.snapshotGeneration, extensions: [...this.snapshot.extensions, ...this.remoteSnapshot.extensions] };
	}

	private async refreshRemote(mode?: ExtensionHostReconcileMode): Promise<void> {
		const revision = ++this.remoteRevision;
		if (await this.remote.getConnectionState() !== 'ready' || !await this.remote.isAvailable()) return;
		const snapshot = mode ? await this.remote.reconcile(mode) : await this.remote.list();
		this.assertNotDisposed();
		if (revision !== this.remoteRevision) return;
		this.acceptRemoteSnapshot(snapshot);
	}

	private acceptRemoteSnapshot(snapshot: ExtensionHostFleetSnapshot): void {
		if (snapshot.generation < this.remoteSnapshot.generation) { return; }
		const localIds = new Set(this.snapshot.extensions.map(runtime => runtime.id));
		if (snapshot.extensions.some(runtime => localIds.has(runtime.id))) throw new Error('An extension cannot be active in two hosts');
		this.remoteSnapshot = snapshot;
		this.changes.fire(++this.snapshotGeneration);
	}

	public reconcile(mode: ExtensionHostReconcileMode): Promise<ExtensionHostFleetSnapshot> {
		this.assertNotDisposed();
		if (!this.refreshing) {
			this.refreshing = this.activate(mode);
			void this.refreshing.finally(() => { this.refreshing = undefined; }).catch(() => undefined);
		}
		return this.refreshing;
	}

	public async activateByEvent(request: Parameters<IExtensionHostApi['activateByEvent']>[0]): Promise<ExtensionHostFleetSnapshot> {
		this.assertNotDisposed();
		const connectionRevision = this.remoteConnectionRevision;
		const activated = await this.remote.activateByEvent(request);
		this.assertNotDisposed();
		if (connectionRevision !== this.remoteConnectionRevision) { throw new Error(localize('extensionHost.browser.retired', 'Browser extension invocation belongs to a retired activation')); }
		// The activation reply is a complete fleet. Retire in-flight older reads so first use
		// cannot return dormant metadata while a notification refresh is still pending.
		this.remoteRevision++;
		this.acceptRemoteSnapshot(activated);
		return this.list();
	}

	public async invoke(request: Parameters<IExtensionHostApi['invoke']>[0], signal: AbortSignal): Promise<JsonValue> {
		this.assertNotDisposed();
		const normalized = normalizeExtensionHostInvocationRequest(request);
		if (this.remoteSnapshot.extensions.some(extension => extension.id === normalized.extensionId)) return this.remote.invoke(normalized, signal);
		const worker = this.workers.get(normalized.extensionId);
		const runtime = this.snapshot.extensions.find(extension => extension.id === normalized.extensionId);
		if (!worker || runtime?.lifecycle !== 'ready' || runtime.activationGeneration !== normalized.activationGeneration || runtime.incarnation !== normalized.incarnation) {
			throw new Error(localize('extensionHost.browser.retired', 'Browser extension invocation belongs to a retired activation'));
		}
		return worker.request({ type: 'invoke', request: normalized }, normalized.deadlineUnixMillis, signal);
	}

	private async activate(mode: ExtensionHostReconcileMode): Promise<ExtensionHostFleetSnapshot> {
		const generation = ++this.generation;
		if (mode === 'refresh') { this.workers.clearAndDisposeAll(); }
		const catalog = await this.extensions.list('refresh');
		const runtimes: ExtensionHostRuntime[] = [];
		for (const extension of catalog.extensions) {
			const previous = this.snapshot.extensions.find(runtime => runtime.id === extension.id);
			if (mode === 'restartFailed' && previous?.lifecycle === 'ready') { runtimes.push(previous); continue; }
			const manifest = JSON.parse(extension.manifestJson);
			if (typeof manifest.browser !== 'string') { continue; }
			let worker: BrowserExtensionWorker | undefined;
			try {
				const path = manifest.browser.replace(/^\.\//, '');
				const source = await this.extensions.readResource({ generation: catalog.generation, extensionId: extension.id, path });
				this.assertNotDisposed();
				worker = this.instantiation.createInstance(BrowserExtensionWorker, source, (operation: ExtensionClientOperation, signal: AbortSignal) => {
					if (!this.clientHandler) throw new Error('No extension client handler is registered');
					return this.clientHandler(operation, signal, { extensionId: extension.id, activationGeneration: generation, incarnation: generation });
				});
				this.workers.set(extension.id, worker);
				const registrations = await worker.request({ type: 'activate', entryPoint: worker.entryPoint, language: getNLSLanguage() }, Date.now() + 30_000);
				this.assertNotDisposed();
				const runtime = normalizeExtensionHostSnapshot({ generation, extensions: [{ ...runtimeIdentity(extension, generation), lifecycle: 'ready', failure: null, registrations }] }).extensions[0];
				worker.onDidFail(error => this.retire(extension.id, generation, error));
				runtimes.push(runtime);
			} catch (error) {
				this.workers.deleteAndDispose(extension.id);
				if (this.isDisposed) { throw error; }
				runtimes.push({ ...runtimeIdentity(extension, generation), lifecycle: 'failed', failure: { code: 'activationFailed', message: String(error), incarnation: generation }, registrations: [] });
			}
		}
		this.snapshot = Object.freeze({ generation: this.snapshot.generation + 1, extensions: Object.freeze(runtimes) });
		this.snapshotGeneration++;
		await this.refreshRemote(mode);
		return this.list();
	}

	private retire(id: string, activationGeneration: number, error: Error): void {
		const runtime = this.snapshot.extensions.find(extension => extension.id === id);
		if (!runtime || runtime.activationGeneration !== activationGeneration) { return; }
		this.workers.deleteAndDispose(id);
		this.snapshot = normalizeExtensionHostSnapshot({
			generation: this.snapshot.generation + 1,
			extensions: this.snapshot.extensions.map(extension => extension.id === id
				? { ...extension, lifecycle: 'failed', failure: { code: 'hostExited', message: error.message, incarnation: extension.incarnation }, registrations: [] }
				: extension),
		});
		this.changes.fire(++this.snapshotGeneration);
	}
}

type WorkerRequest = Omit<Extract<BrowserExtensionHostRequest, { type: 'activate'; }>, 'id'> | Omit<Extract<BrowserExtensionHostRequest, { type: 'invoke'; }>, 'id'>;

class BrowserExtensionWorker extends Disposable {
	private readonly failures = this._register(new Emitter<Error>());
	public readonly onDidFail = this.failures.event;
	public readonly entryPoint: string;
	private readonly worker: Worker;
	private nextId = 1;
	private readonly pending = new Map<number, { resolve(value: JsonValue): void; reject(error: Error): void; }>();

	constructor(source: Uint8Array, clientHandler: (operation: ExtensionClientOperation, signal: AbortSignal) => ReturnType<ExtensionClientHandler>,
		@ICommandService commandService: ICommandService,
		@IFileService files: IFileService,
		@IWorkspaceContextService workspace: IWorkspaceContextService,
		@IFileSystemProviderService fileProviders: IFileSystemProviderService,
		@IAppServerApi appServer: IAppServerApi) {
		super();
		const clients = new Map<number, AbortController>();
		const lifetime = new AbortController();
		this._register(toDisposable(() => { lifetime.abort(); for (const client of clients.values()) client.abort(); clients.clear(); }));
		this.entryPoint = URL.createObjectURL(new Blob([Uint8Array.from(source)], { type: 'text/javascript' }));
		this._register(toDisposable(() => URL.revokeObjectURL(this.entryPoint)));
		this.worker = new Worker(new URL('./extensionHostWorker.ts', import.meta.url), { type: 'module', name: 'Ash Web Extension Host' });
		this._register(toDisposable(() => {
			this.worker.terminate();
			for (const pending of this.pending.values()) { pending.reject(new Error(localize('extensionHost.browser.stopped', 'Browser extension Worker stopped'))); }
			this.pending.clear();
		}));
		const onMessage = (event: MessageEvent): void => {
			const message = event.data;
			if (message?.type === 'webviewResource') {
				if (typeof message.url !== 'string' || !URL.canParse(message.url) || !message.url.startsWith('blob:') || new URL(message.url).origin !== new URL(this.entryPoint).origin) {
					this.fail(new TypeError('Invalid extension webview resource URL'));
					return;
				}
				const url = message.url;
				this._register(toDisposable(() => URL.revokeObjectURL(url)));
				return;
			}
			if (message?.type === 'clientCancel') { clients.get(message.id)?.abort(); return; }
			if (message?.type === 'clientRequest') {
				if (!Number.isSafeInteger(message.id) || message.id <= 0 || clients.has(message.id)) {
					this.fail(new TypeError('Invalid browser extension client request ID'));
					return;
				}
				const client = new AbortController();
				clients.set(message.id, client);
				void (async (): Promise<JsonValue> => {
					const payload = normalizeExtensionHostPayload(message.request);
					if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError('Invalid browser extension client request');
					const value = payload as Record<string, JsonValue>;
					if (typeof value.operation !== 'string') throw new TypeError('Invalid browser extension client request');
					if (value.operation === 'workspaceFolders') {
						const connected = await appServer.getConnectionState() === 'ready';
						// Browser-owned folders remain readable offline; backend roots require their connection.
						return workspace.getWorkspace().folders
							.filter(folder => connected || fileProviders.hasProvider(folder.uri.scheme))
							.map(folder => folder.uri.toString());
					}
					if (value.operation === 'stat' || value.operation === 'readDirectory') {
						if (typeof value.resource !== 'string') throw new TypeError('Expected a resource URI');
						const resource = URI.parse(value.resource);
						try {
							if (value.operation === 'stat') return { isDirectory: (await files.stat(resource)).kind === FileKind.Directory };
							return (await files.readDirectory(resource)).map(entry => [entry.name, { isDirectory: entry.kind === FileKind.Directory }]);
						} catch (error) {
							if (error instanceof FileNotFoundError) return value.operation === 'stat' ? null : [];
							throw error;
						}
					}
					if (value.operation !== 'listDocuments' && value.operation !== 'readDocument' && value.operation !== 'readConfiguration') throw new TypeError('Unsupported browser extension client operation');
					if (value.operation === 'readDocument' && typeof value.uri !== 'string') throw new TypeError('Expected a document URI');
					if (value.operation === 'readConfiguration' && (typeof value.section !== 'string' || value.resource !== null && typeof value.resource !== 'string')) throw new TypeError('Expected a configuration section and resource');
					return await clientHandler(value as unknown as ExtensionClientOperation, AbortSignal.any([lifetime.signal, client.signal])) as unknown as JsonValue;
				})().then(result => {
					clients.delete(message.id);
					if (client.signal.aborted) return;
					if (!this.isDisposed) this.worker.postMessage({ type: 'commandResult', id: message.id, success: true, result: normalizeExtensionHostPayload(result) });
				}, error => {
					clients.delete(message.id);
					if (client.signal.aborted) return;
					if (!this.isDisposed) this.worker.postMessage({ type: 'commandResult', id: message.id, success: false, error: String(error) });
				});
				return;
			}
			if (message?.type === 'executeCommand') {
				const payload = normalizeExtensionHostPayload(message);
				if (typeof payload !== 'object' || payload === null || Array.isArray(payload) || !Number.isSafeInteger(message.id) || typeof message.command !== 'string' || !Array.isArray(message.args)) {
					this.fail(new Error(localize('extensionHost.browser.invalidResponse', 'Invalid browser extension Worker response'))); return;
				}
				void commandService.executeCommand(message.command, ...message.args).then(result => {
					if (!this.isDisposed) this.worker.postMessage({ type: 'commandResult', id: message.id, success: true, result: normalizeExtensionHostPayload(result ?? null) } satisfies BrowserExtensionHostRequest);
				}).catch(error => {
					if (!this.isDisposed) this.worker.postMessage({ type: 'commandResult', id: message.id, success: false, error: String(error) } satisfies BrowserExtensionHostRequest);
				});
				return;
			}
			if (!message || !Number.isSafeInteger(message.id) || typeof message.success !== 'boolean') { this.fail(new Error(localize('extensionHost.browser.invalidResponse', 'Invalid browser extension Worker response'))); return; }
			const pending = this.pending.get(message.id);
			if (!pending) { return; }
			if (message.success) {
				try { pending.resolve(normalizeExtensionHostPayload(message.result)); } catch (error) { pending.reject(error as Error); }
			} else { pending.reject(new Error(String(message.error))); }
		};
		const onError = (event: ErrorEvent): void => { this.fail(new Error(event.message)); };
		this.worker.addEventListener('message', onMessage);
		this.worker.addEventListener('error', onError);
		this._register(toDisposable(() => { this.worker.removeEventListener('message', onMessage); this.worker.removeEventListener('error', onError); }));
	}

	public request(request: WorkerRequest, deadline: number, signal?: AbortSignal): Promise<JsonValue> {
		this.assertNotDisposed();
		if (signal?.aborted) { return Promise.reject(new DOMException(localize('extensionHost.browser.cancelled', 'Browser extension invocation cancelled'), 'AbortError')); }
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const cleanup = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); this.pending.delete(id); };
			// Keep the deadline until the Worker acknowledges cancellation; an uncooperative handler must be stopped.
			const onAbort = (): void => { this.worker.postMessage({ id: this.nextId++, type: 'cancel', invocationId: id } satisfies BrowserExtensionHostRequest); reject(new DOMException(localize('extensionHost.browser.cancelled', 'Browser extension invocation cancelled'), 'AbortError')); };
			const timer = setTimeout(() => { this.fail(new Error(localize('extensionHost.browser.deadline', 'Browser extension invocation deadline elapsed'))); }, Math.max(0, deadline - Date.now()));
			this.pending.set(id, { resolve: value => { cleanup(); resolve(value); }, reject: error => { cleanup(); reject(error); } });
			signal?.addEventListener('abort', onAbort, { once: true });
			this.worker.postMessage({ ...request, id } satisfies BrowserExtensionHostRequest);
		});
	}

	private fail(error: Error): void {
		for (const pending of this.pending.values()) { pending.reject(error); }
		this.failures.fire(error);
		this.dispose();
	}
}

function runtimeIdentity(extension: ExtensionDescriptor, generation: number): Omit<ExtensionHostRuntime, 'lifecycle' | 'failure' | 'registrations'> {
	return { id: extension.id, version: extension.version, packageDigest: extension.packageSha256, runtimeApiVersion: 1, activationGeneration: generation, incarnation: generation, stderr: '', outputEvents: [] };
}

export function createDisconnectedExtensionHostApi(unavailable: UnavailableOperation): IExtensionHostApi {
	return {
		registerClientHandler: () => inertSubscription(),
		isAvailable: () => Promise.resolve(false),
		list: () => unavailable("extensionHost.list"),
		reconcile: () => unavailable("extensionHost.reconcile"),
		activateByEvent: () => unavailable("extensionHost.activate"),
		invoke: () => unavailable("extensionHost.invoke"),
		getConnectionState: () => Promise.resolve("stopped"),
		onDidChange: inertSubscription,
		onConnectionState: inertSubscription,
	};
}

export function createAppServerExtensionHostApi(connection: AppServerProtocolClient): IExtensionHostApi {
	const transport = {
		start: (request: Parameters<IExtensionHostApi["invoke"]>[0]) => appServerRequest(connection, "extensionHost/invoke/start", request),
		read: (invocationId: string) => appServerRequest(connection, "extensionHost/invoke/read", { invocationId }),
		cancel: (invocationId: string) => appServerRequest(connection, "extensionHost/invoke/cancel", { invocationId }),
	};
	return {
		registerClientHandler: handler => connection.registerRequestHandler(APP_SERVER_SERVER_REQUESTS['extensionClient/request'], async ({ operation, ...source }, context) => {
			if (operation.operation === 'readWorkspaceFile') {
				throw new Error('Workspace file requests must be handled by App Server');
			}
			const request = operation.operation === 'executeCommand'
				? { ...operation, arguments: operation.arguments.map(normalizeExtensionHostPayload) }
				: operation.operation === 'updateConfiguration'
					? { ...operation, value: normalizeExtensionHostPayload(operation.value) }
					: operation;
			const result = await handler(request, context.signal, source);
			// Domain payloads are immutable; the transport owns a separate mutable wire value.
			switch (result.result) {
				case 'command':
				case 'configuration': return { ...result, value: protocolJsonValue(result.value) };
				default: return result;
			}
		}),
		isAvailable: () => Promise.resolve(connection.capabilities?.extensionHost === true),
		list: async () => normalizeExtensionHostSnapshot(await appServerRequest(connection, "extensionHost/list", {})),
		reconcile: async mode => normalizeExtensionHostSnapshot(await appServerRequest(connection, "extensionHost/reconcile", { mode })),
		activateByEvent: async request => normalizeExtensionHostSnapshot(await appServerRequest(connection, "extensionHost/activate", request)),
		invoke: (request, signal) => invokeExtensionHost(transport, request, signal),
		getConnectionState: () => Promise.resolve(connection.state),
		onDidChange: listener => connection.onNotification(event => {
			if (event.method === "extensionHost/changed") listener(normalizeExtensionHostChanged(event.params));
		}),
		onConnectionState: listener => connection.onStateChange(listener),
	};
}

function protocolJsonValue(value: JsonValue): ProtocolJsonValue {
	if (value === null || typeof value !== 'object') { return value; }
	if (Array.isArray(value)) { return value.map(protocolJsonValue); }
	return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, protocolJsonValue(entry)]));
}
