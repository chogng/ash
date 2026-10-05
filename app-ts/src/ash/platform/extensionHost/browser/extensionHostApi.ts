import type { ExtensionHostReconcileMode, IExtensionHostApi } from "../common/extensionHostApi.js";
import { invokeExtensionHost, normalizeExtensionHostChanged, normalizeExtensionHostSnapshot } from "../common/extensionHostApi.js";
import type { UnavailableOperation } from "../../renderer/browser/disconnectedHost.js";
import type { AppServerProtocolClient } from "../../app-server/browser/appServerProtocolClient.js";
import { appServerRequest } from "../../app-server/browser/appServerRequest.js";
import { inertSubscription } from "../../renderer/browser/disconnectedHost.js";
import { Disposable, DisposableMap, toDisposable } from '../../../base/common/lifecycle.js';
import { Emitter } from '../../../base/common/event.js';
import type { IExtensionApi, ExtensionDescriptor } from '../../extensions/common/extensionApi.js';
import { getNLSLanguage, localize } from '../../../nls.js';
import { ICommandService } from '../../commands/common/commands.js';
import { normalizeExtensionHostInvocationRequest, normalizeExtensionHostPayload, type ExtensionHostFleetSnapshot, type ExtensionHostRuntime, type JsonValue } from '../common/extensionHostApi.js';

export type BrowserExtensionHostRequest =
	| { readonly id: number; readonly type: 'activate'; readonly entryPoint: string; readonly language: string }
	| { readonly id: number; readonly type: 'invoke'; readonly request: Parameters<IExtensionHostApi['invoke']>[0] }
	| { readonly id: number; readonly type: 'cancel'; readonly invocationId: number }
	| { readonly id: number; readonly type: 'commandResult'; readonly success: true; readonly result: JsonValue }
	| { readonly id: number; readonly type: 'commandResult'; readonly success: false; readonly error: string };

/** A package snapshot is executed in a window-owned Worker, never in the Workbench realm. */
export class BrowserExtensionHostApi extends Disposable implements IExtensionHostApi {
	private readonly workers = this._register(new DisposableMap<string, BrowserExtensionWorker>());
	private readonly changes = this._register(new Emitter<number>());
	private generation = 0;
	private snapshot: ExtensionHostFleetSnapshot = { generation: 1, extensions: [] };
	private refreshing: Promise<ExtensionHostFleetSnapshot> | undefined;
	private remoteSnapshot: ExtensionHostFleetSnapshot = { generation: 1, extensions: [] };
	private remoteRevision = 0;

	constructor(private readonly extensions: IExtensionApi, private readonly remote: IExtensionHostApi,
		@ICommandService private readonly commandService: ICommandService) {
		super();
		const changes = remote.onDidChange(() => { void this.refreshRemote().catch(error => console.error('Extension Host refresh failed', error)); });
		this._register(toDisposable(() => changes.dispose()));
		const connection = remote.onConnectionState(state => {
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
				worker = new BrowserExtensionWorker(source, this.commandService);
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

type WorkerRequest = Omit<Extract<BrowserExtensionHostRequest, { type: 'activate' }>, 'id'> | Omit<Extract<BrowserExtensionHostRequest, { type: 'invoke' }>, 'id'>;

class BrowserExtensionWorker extends Disposable {
	private readonly failures = this._register(new Emitter<Error>());
	public readonly onDidFail = this.failures.event;
	public readonly entryPoint: string;
	private readonly worker: Worker;
	private nextId = 1;
	private readonly pending = new Map<number, { resolve(value: JsonValue): void; reject(error: Error): void }>();

	constructor(source: Uint8Array, commandService: ICommandService) {
		super();
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
		isAvailable: () => Promise.resolve(false),
		list: () => unavailable("extensionHost.list"),
		reconcile: () => unavailable("extensionHost.reconcile"),
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
		isAvailable: () => Promise.resolve(connection.capabilities?.extensionHost === true),
		list: async () => normalizeExtensionHostSnapshot(await appServerRequest(connection, "extensionHost/list", {})),
		reconcile: async mode => normalizeExtensionHostSnapshot(await appServerRequest(connection, "extensionHost/reconcile", { mode })),
		invoke: (request, signal) => invokeExtensionHost(transport, request, signal),
		getConnectionState: () => Promise.resolve(connection.state),
		onDidChange: listener => connection.onNotification(event => {
			if (event.method === "extensionHost/changed") listener(normalizeExtensionHostChanged(event.params));
		}),
		onConnectionState: listener => connection.onStateChange(listener),
	};
}
