import { MainThreadLocalization } from '../../../api/browser/mainThreadLocalization.js';
import type { ExtensionHostReconcileMode, IExtensionHostApi, ExtensionHostClientHandler, ExtensionHostFleetSnapshot, ExtensionHostRuntime, JsonValue } from '../../../../platform/agentHost/common/extensionHostApi.js';
import { normalizeExtensionHostInvocationRequest, normalizeExtensionHostPayload, normalizeExtensionHostSnapshot } from '../../../../platform/agentHost/browser/extensionHostProtocol.js';
import { decodeAppServerServerRequestParams } from '../../../../../../.build/protocol/typescript/AppServerProtocolDecoder.js';
import { Disposable, DisposableMap, combinedDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { Emitter } from '../../../../base/common/event.js';
import type { IExtensionApi, ExtensionDescriptor } from '../../../../platform/extensions/common/extensionApi.js';
import { getNLSLanguage, localize } from '../../../../nls.js';
import type { ExtensionClientHandler, ExtensionClientOperation } from '../../../api/common/extHost.protocol.js';
import type { BrowserExtensionHostRequest } from '../common/extensionHostProtocol.js';

const BUILT_IN_SSH_EXTENSION_ID = 'ash.remote-ssh';

/** A package snapshot is executed in a window-owned Worker, never in the Workbench realm. */
export class WebWorkerExtensionHost extends Disposable implements IExtensionHostApi {
	public registerClientHandler(handler: ExtensionHostClientHandler): ReturnType<IExtensionHostApi['registerClientHandler']> {
		if (this.clientHandler) throw new Error('An extension client handler is already registered');
		const remote = this.remote.registerClientHandler(handler);
		this.clientHandler = handler as ExtensionClientHandler;
		return combinedDisposable(toDisposable(() => remote.dispose()), toDisposable(() => { this.clientHandler = undefined; }));
	}
	private clientHandler: ExtensionClientHandler | undefined;
	private readonly workers = this._register(new DisposableMap<string, BrowserExtensionWorker>());
	private readonly workerPackages = new Map<string, string>();
	private readonly changes = this._register(new Emitter<number>());
	private generation = 0;
	private snapshot: ExtensionHostFleetSnapshot = { generation: 1, extensions: [] };
	private refreshing: Promise<ExtensionHostFleetSnapshot> | undefined;
	private pendingMode: ExtensionHostReconcileMode | undefined;
	private remoteSnapshot: ExtensionHostFleetSnapshot = { generation: 1, extensions: [] };
	private remoteRevision = 0;
	private remoteConnectionRevision = 0;

	constructor(private readonly extensions: IExtensionApi, private readonly remote: IExtensionHostApi,
		@IInstantiationService private readonly instantiation: IInstantiationService) {
		super();
		if (extensions.onDidChange) {
			this._register(extensions.onDidChange(() => {
				this.pendingMode ??= 'restartFailed';
				void this.reconcile('restartFailed').catch(error => console.error('Browser extension enablement refresh failed', error));
			}));
		}
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

	public start(environment: Readonly<Record<string, string | null>>): Promise<ExtensionHostFleetSnapshot> { return this.remote.start(environment); }
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
		for (const runtime of snapshot.extensions) {
			assertRemoteResolverOwnership(runtime, runtime.id === BUILT_IN_SSH_EXTENSION_ID);
		}
		const localIds = new Set(this.snapshot.extensions.map(runtime => runtime.id));
		if (snapshot.extensions.some(runtime => localIds.has(runtime.id))) throw new Error('An extension cannot be active in two hosts');
		this.remoteSnapshot = snapshot;
		// The queued catalog read may revoke a local runtime activated by the current pass.
		if (!this.pendingMode) { this.changes.fire(++this.snapshotGeneration); }
	}

	public reconcile(mode: ExtensionHostReconcileMode): Promise<ExtensionHostFleetSnapshot> {
		this.assertNotDisposed();
		if (!this.refreshing) {
			this.pendingMode = mode;
			this.refreshing = this.drainReconciles();
			void this.refreshing.finally(() => { this.refreshing = undefined; }).catch(() => undefined);
		}
		return this.refreshing;
	}

	private async drainReconciles(): Promise<ExtensionHostFleetSnapshot> {
		while (this.pendingMode) {
			const mode = this.pendingMode;
			this.pendingMode = undefined;
			await this.activate(mode);
		}
		return this.list();
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
		// Reconcile runtime instances against the authoritative package snapshot.
		// Source discovery belongs to package/theme refresh, not each host startup;
		// a cached backend read still observes managed updates and connection changes.
		const catalog = await this.extensions.list('cached');
		this.assertNotDisposed();
		const packages = new Map(catalog.extensions.map(extension => [extension.id, browserPackageIdentity(extension)]));
		const retained = this.snapshot.extensions.filter(runtime => runtime.lifecycle === 'ready' && this.workers.has(runtime.id) && this.workerPackages.get(runtime.id) === packages.get(runtime.id));
		const retainedIds = new Set(retained.map(runtime => runtime.id));
		const retired: BrowserExtensionWorker[] = [];
		for (const [id] of this.workers) {
			if (!retainedIds.has(id)) {
				retired.push(this.workers.deleteAndLeak(id)!);
				this.workerPackages.delete(id);
			}
		}
		// Revoke changed owners before cleanup or replacement can reuse their SCM identities.
		// An ordinary refresh (including remote first-use activation) keeps unchanged Workers.
		if (retained.length !== this.snapshot.extensions.length) {
			this.snapshot = { ...this.snapshot, extensions: retained };
			this.changes.fire(++this.snapshotGeneration);
		}
		await Promise.all(retired.map(worker => worker.close()));
		this.assertNotDisposed();
		const runtimes: ExtensionHostRuntime[] = [];
		for (const extension of catalog.extensions) {
			// Package readability does not admit code into the client host. User and registry
			// packages must pass backend runtime admission before their scripts can execute.
			if (extension.sourceKind !== 'builtIn') { continue; }
			// Declarative and Rust packages have no browser activation. Do not put
			// their optional translation/resource reads on the executable host path.
			if (typeof JSON.parse(extension.manifestJson).browser !== 'string') { continue; }
			const previous = this.snapshot.extensions.find(runtime => runtime.id === extension.id);
			if (previous?.lifecycle === 'ready') { runtimes.push(previous); continue; }
			const localization = this.instantiation.createInstance(MainThreadLocalization);
			const manifest = JSON.parse(await localization.localizeManifest(extension.id, extension.manifestJson, catalog.generation));
			if (typeof manifest.browser !== 'string') { continue; }
			let worker: BrowserExtensionWorker | undefined;
			try {
				if (extension.id === BUILT_IN_SSH_EXTENSION_ID) { throw new TypeError(localize('extensionHost.browser.productSsh', 'The product SSH extension must execute as a Rust provider')); }
				const path = manifest.browser.replace(/^\.\//, '');
				const source = await this.extensions.resources.readExtensionResourceBytes({ generation: catalog.generation, extensionId: extension.id, path });
				this.assertNotDisposed();
				worker = this.instantiation.createInstance(BrowserExtensionWorker, extension.id, source, async (message: unknown, signal: AbortSignal) => {
					if (this.workers.get(extension.id) !== worker) { throw new Error(localize('extensionHost.browser.retired', 'Browser extension invocation belongs to a retired activation')); }
					const operation = message as ExtensionClientOperation;
					if (!this.clientHandler) throw new Error('No extension client handler is registered');
					const result = await this.clientHandler(operation, signal, { extensionId: extension.id, activationGeneration: generation, incarnation: generation });
					if (this.workers.get(extension.id) !== worker) { throw new Error(localize('extensionHost.browser.retired', 'Browser extension invocation belongs to a retired activation')); }
					if (operation.operation === 'setStatusBarEntries' && result.result === 'done' && !signal.aborted) {
						// Reconnect snapshots retain only the current acknowledged value, never activation's old arguments.
						this.snapshot = {
							...this.snapshot, extensions: this.snapshot.extensions.map(runtime => runtime.id !== extension.id || runtime.incarnation !== generation ? runtime : {
								...runtime, registrations: runtime.registrations.map(registration => registration.kind === 'statusBar' && registration.registrationId === operation.registrationId && operation.revision > registration.revision
									? { ...registration, revision: operation.revision, entries: operation.entries } : registration),
							})
						};
						// The client already applied this value. Publishing a fleet change before
						// the Worker receives its reply would invalidate the originating command.
						this.snapshotGeneration++;
					}
					if (operation.operation === 'scmUpdate' && result.result === 'done' && !signal.aborted) {
						this.snapshot = { ...this.snapshot, extensions: this.snapshot.extensions.map(runtime => runtime.id !== extension.id || runtime.incarnation !== generation ? runtime : { ...runtime, registrations: runtime.registrations.map(registration => registration.kind === 'sourceControl' && registration.registrationId === operation.registrationId && operation.revision > registration.revision ? { ...registration, revision: operation.revision, providers: operation.providers } : registration) }) };
						this.snapshotGeneration++;
					}
					return result;
				});
				this.workers.set(extension.id, worker);
				if (!this.clientHandler) throw new Error('No extension client handler is registered');
				const initialized = await this.clientHandler({ operation: 'readInitialization' }, new AbortController().signal, { extensionId: extension.id, activationGeneration: generation, incarnation: generation });
				if (initialized.result !== 'initialization') throw new Error('Invalid extension initialization');
				const registrations = await worker.request({ type: 'activate', entryPoint: worker.entryPoint, language: getNLSLanguage(), extensionId: extension.id, initialization: normalizeExtensionHostPayload(initialized.initialization), configuration: normalizeExtensionHostPayload({ commands: manifest.contributes?.commands ?? [], extensionId: extension.id, extensionPath: '/', pathSeparator: '/', manifest, debuggers: manifest.contributes?.debuggers ?? [] }) }, Date.now() + 30_000);
				this.assertNotDisposed();
				const runtime = normalizeExtensionHostSnapshot({ generation, extensions: [{ ...runtimeIdentity(extension, generation), lifecycle: 'ready', failure: null, registrations }] }).extensions[0];
				assertRemoteResolverOwnership(runtime, false);
				worker.onDidFail(error => this.retire(extension.id, generation, error));
				this.workerPackages.set(extension.id, packages.get(extension.id)!);
				runtimes.push(runtime);
			} catch (error) {
				this.workers.deleteAndDispose(extension.id);
				if (this.isDisposed) { throw error; }
				runtimes.push({ ...runtimeIdentity(extension, generation), lifecycle: 'failed', failure: { code: 'activationFailed', message: String(error), incarnation: generation }, registrations: [] });
			}
		}
		// Background SCM/status-bar publication can advance a retained runtime while another
		// package activates. Carry its latest acknowledged registrations into the complete fleet.
		this.snapshot = Object.freeze({
			generation: this.snapshot.generation + 1, extensions: Object.freeze(runtimes.map(runtime =>
				this.snapshot.extensions.find(current => current.id === runtime.id && current.activationGeneration === runtime.activationGeneration) ?? runtime))
		});
		this.snapshotGeneration++;
		await this.refreshRemote(mode);
		if (!this.pendingMode) { this.changes.fire(++this.snapshotGeneration); }
		return this.list();
	}

	private retire(id: string, activationGeneration: number, error: Error): void {
		const runtime = this.snapshot.extensions.find(extension => extension.id === id);
		if (!runtime || runtime.activationGeneration !== activationGeneration) { return; }
		this.workers.deleteAndDispose(id);
		this.workerPackages.delete(id);
		this.snapshot = {
			generation: this.snapshot.generation + 1,
			extensions: this.snapshot.extensions.map(extension => extension.id === id
				? { ...extension, lifecycle: 'failed', failure: { code: 'hostExited', message: error.message, incarnation: extension.incarnation }, registrations: [] }
				: extension),
		};
		this.changes.fire(++this.snapshotGeneration);
	}
}

type WorkerRequest = Omit<Extract<BrowserExtensionHostRequest, { type: 'activate'; }>, 'id'> | Omit<Extract<BrowserExtensionHostRequest, { type: 'invoke'; }>, 'id'> | Omit<Extract<BrowserExtensionHostRequest, { type: 'deactivate'; }>, 'id'>;

class BrowserExtensionWorker extends Disposable {
	private readonly failures = this._register(new Emitter<Error>());
	public readonly onDidFail = this.failures.event;
	public readonly entryPoint: string;
	private readonly worker: Worker;
	private nextId = 1;
	private readonly pending = new Map<number, { resolve(value: JsonValue): void; reject(error: Error): void; }>();

	constructor(extensionId: string, source: Uint8Array, clientHandler: (operation: unknown, signal: AbortSignal) => ReturnType<ExtensionHostClientHandler>) {
		super();
		const clients = new Map<number, AbortController>();
		const webviewResources = this._register(new DisposableMap<string>());
		const lifetime = new AbortController();
		this._register(toDisposable(() => { lifetime.abort(); for (const client of clients.values()) client.abort(); clients.clear(); }));
		this.entryPoint = URL.createObjectURL(new Blob([Uint8Array.from(source)], { type: 'text/javascript' }));
		this._register(toDisposable(() => URL.revokeObjectURL(this.entryPoint)));
		this.worker = new Worker(new URL('../../../api/worker/extensionHostWorker.ts', import.meta.url), { type: 'module', name: `Ash Web Extension Host: ${extensionId}` });
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
				webviewResources.set(url, toDisposable(() => URL.revokeObjectURL(url)));
				return;
			}
			if (message?.type === 'releaseWebviewResource') {
				if (typeof message.url !== 'string' || !webviewResources.has(message.url)) {
					this.fail(new TypeError('Unknown extension webview resource URL'));
					return;
				}
				webviewResources.deleteAndDispose(message.url);
				return;
			}
			if (message?.type === 'clientCancel') {
				const client = clients.get(message.id);
				clients.delete(message.id);
				client?.abort();
				return;
			}
			if (message?.type === 'clientRequest') {
				if (!Number.isSafeInteger(message.id) || message.id <= 0 || clients.has(message.id) || clients.size >= 32) {
					this.fail(new TypeError('Invalid browser extension client request ID'));
					return;
				}
				const client = new AbortController();
				clients.set(message.id, client);
				void (async (): Promise<JsonValue> => {
					const payload = normalizeExtensionHostPayload(message.request);
					// The generated Rust contract validates both Worker and backend client requests.
					// These fields validate shape only; the window binding supplies the actual fence.
					const browserOperation = normalizeBrowserClientOperation(payload);
					if (browserOperation) { return await clientHandler(browserOperation, AbortSignal.any([lifetime.signal, client.signal])) as unknown as JsonValue; }
					const { operation } = decodeAppServerServerRequestParams('extensionClient/request', { extensionId, activationGeneration: 1, incarnation: 1, operation: payload });
					if (operation.operation === 'readWorkspaceFile') throw new TypeError('Workspace file requests belong to the backend');
					return await clientHandler(operation, AbortSignal.any([lifetime.signal, client.signal])) as unknown as JsonValue;
				})().then(normalizeExtensionHostPayload).then(result => {
					clients.delete(message.id);
					if (client.signal.aborted) return;
					if (!this.isDisposed) this.worker.postMessage({ type: 'commandResult', id: message.id, success: true, result });
				}, error => {
					clients.delete(message.id);
					if (client.signal.aborted) return;
					if (!this.isDisposed) this.worker.postMessage({ type: 'commandResult', id: message.id, success: false, error: String(error) });
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

	public async close(): Promise<void> {
		if (this.isDisposed) return;
		// Refresh allows extension cleanup; a blocked callback cannot keep the old Worker alive.
		try { await this.request({ type: 'deactivate' }, Date.now() + 1_000); }
		catch (error) { console.error('Browser extension cleanup failed', error); }
		finally { this.dispose(); }
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

function assertRemoteResolverOwnership(runtime: ExtensionHostRuntime, builtInSsh: boolean): void {
	// The backend admits this identity only from its authorized Rust executable. Worker packages
	// cannot acquire the reserved prefix, even if their catalog provenance is built-in.
	if (!builtInSsh && runtime.registrations.some(registration => (registration.kind === 'remoteAuthorityResolver' || registration.kind === 'remoteConnectionResolver') && registration.authorityPrefix === 'ssh')) {
		throw new TypeError('Remote ssh prefix belongs to the built-in SSH extension');
	}
}

function browserPackageIdentity(extension: ExtensionDescriptor): string {
	return JSON.stringify([extension.id, extension.version, extension.packageSha256, extension.manifestSha256, extension.sourceKind, extension.extensionLocation, extension.targetPlatform, getNLSLanguage()]);
}

function runtimeIdentity(extension: ExtensionDescriptor, generation: number): Omit<ExtensionHostRuntime, 'lifecycle' | 'failure' | 'registrations'> {
	return { id: extension.id, version: extension.version, packageDigest: extension.packageSha256, runtimeApiVersion: 1, activationGeneration: generation, incarnation: generation, stderr: '', outputEvents: [] };
}

function normalizeBrowserClientOperation(value: JsonValue): ExtensionClientOperation | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) { return undefined; }
	const input = value as Record<string, JsonValue>;
	const identifier = (entry: JsonValue): string => {
		if (typeof entry !== 'string' || !entry || entry.length > 256 || entry.includes('\0')) { throw new TypeError('Invalid browser extension identifier'); }
		return entry;
	};
	if (input.operation === 'scmUpdate') {
		if (!Number.isSafeInteger(input.revision) || Number(input.revision) < 1 || !Array.isArray(input.providers) || input.providers.length > 128) { throw new TypeError('Invalid SCM update'); }
		return { operation: 'scmUpdate', registrationId: identifier(input.registrationId), revision: Number(input.revision), providers: input.providers };
	}
	if (input.operation === 'backendRequest') { return { operation: 'backendRequest', capability: identifier(input.capability), method: identifier(input.method), params: input.params }; }
	if (input.operation === 'editorOperation') { return { operation: 'editorOperation', payload: normalizeExtensionHostPayload(input.payload) }; }
	if (input.operation === 'backendState') {
		if (!Number.isSafeInteger(input.after) || Number(input.after) < 0) { throw new TypeError('Invalid backend event cursor'); }
		return { operation: 'backendState', capability: identifier(input.capability), after: Number(input.after) };
	}
	return undefined;
}
