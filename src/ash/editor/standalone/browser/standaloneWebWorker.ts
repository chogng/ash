import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { WebWorkerServer, type IWebWorkerClient, type WebWorkerClientPort } from '../../../base/common/worker/webWorker.js';
import { type IModelService } from '../../common/services/model.js';
import { LanguageWorkerDocumentMirror } from '../../common/services/textModelSync/textModelSync.impl.js';
import type { IWebWorkerService } from '../../../platform/webWorker/browser/webWorkerService.js';
import type { ITextModel } from '../../common/model.js';

const standaloneWorkerChannel = Object.freeze({ protocol: 'ash.standalone-worker', version: 1 });

interface StandaloneWorkerSnapshot {
	readonly uri: string;
	readonly version: number;
	readonly text: string;
	readonly lineCount: number;
}

export interface StandaloneWorkerOptions {
	readonly worker: Worker | Promise<Worker>;
	readonly host?: Record<string, Function>;
	readonly keepIdleModels?: boolean;
}


export interface MonacoWebWorker<T extends object> extends IDisposable {
	getProxy(): Promise<T>;
	withSyncedResources(resources: URI[]): Promise<T>;
}

/** Creates a Worker whose foreign methods can read synchronized editor models. */
export function createWebWorker<T extends object>(modelService: IModelService, webWorkerService: IWebWorkerService, options: StandaloneWorkerOptions): MonacoWebWorker<T> {
	return new MonacoWebWorkerImpl<T>(modelService, webWorkerService, options);
}

export interface StandaloneWorkerMirrorModel {
	readonly uri: URI;
	readonly version: number;
	getValue(): string;
}

export interface StandaloneWorkerContext {
	getMirrorModels(): readonly StandaloneWorkerMirrorModel[];
	callHost(method: string, ...args: unknown[]): Promise<unknown>;
}

export interface StandaloneWorkerScope {
	addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
	removeEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
	postMessage(message: unknown, options?: { transfer: ArrayBuffer[]; }): void;
}

/** Called once by the supplied Worker module to serve foreign method requests. */
export function startStandaloneWebWorker<T extends object>(scope: StandaloneWorkerScope, create: (context: StandaloneWorkerContext) => T | Promise<T>): IDisposable {
	const store = new DisposableStore();
	const messages = store.add(new Emitter<unknown>());
	const listener = (event: MessageEvent<unknown>): void => messages.fire(event.data);
	scope.addEventListener('message', listener);
	store.add(toDisposable(() => scope.removeEventListener('message', listener)));
	const port: WebWorkerClientPort = { onMessage: messages.event, onFailure: Event.None, send: (value, transfer) => scope.postMessage(value, { transfer: transfer ? [...transfer] : [] }), ...Disposable.None };

	const mirrors = new Map<string, { readonly uri: URI; readonly document: LanguageWorkerDocumentMirror; }>();
	const context: StandaloneWorkerContext = {
		getMirrorModels: () => [...mirrors.values()].map(({ uri, document }) => ({
			uri,
			get version() { return document.version; },
			getValue: () => document.createSnapshot().getText(),
		})),
		callHost: (method, ...args) => server.getChannel<Record<string, (...args: unknown[]) => Promise<unknown>>>('host')[method]!(...args),
	};
	const instance = Promise.resolve().then(() => create(context));
	void instance.catch(() => { });
	const server = store.add(new WebWorkerServer(port, standaloneWorkerChannel, {
		handleRequest: async message => {
			switch (message.operation) {
				case 'ready':
					await instance;
					return null;
				case 'sync': {
					if (!Array.isArray(message.snapshots)) throw new TypeError('Invalid standalone Worker snapshots');
					for (const value of message.snapshots) {
						const item = value as StandaloneWorkerSnapshot;
						if (typeof item.uri !== 'string' || typeof item.text !== 'string' || !Number.isSafeInteger(item.version) || !Number.isSafeInteger(item.lineCount)) {
							throw new TypeError('Invalid standalone Worker snapshot');
						}
						const old = mirrors.get(item.uri);
						old?.document.dispose();
						const document = new LanguageWorkerDocumentMirror({
							version: item.version, length: item.text.length, lineCount: item.lineCount,
							getText: () => item.text,
							getTextBetweenOffsets: (start, end) => item.text.slice(start, end),
						});
						mirrors.set(item.uri, { uri: URI.parse(item.uri), document });
					}
					return null;
				}
				default: throw new TypeError('Unknown standalone Worker operation');
			}
		},
		handleNotification: message => {
			switch (message.kind) {
				case 'change': {
					if (typeof message.uri !== 'string' || !Array.isArray(message.changes)) throw new TypeError('Invalid standalone Worker change');
					const mirror = mirrors.get(message.uri);
					if (!mirror) return;
					if (message.previousVersion !== mirror.document.version || message.modelVersion !== mirror.document.version + 1) throw new Error(`Standalone Worker mirror ${message.uri} is at ${mirror.document.version}, received ${String(message.previousVersion)} -> ${String(message.modelVersion)}`);
					mirror.document.synchronize(message.previousVersion as number, message.modelVersion as number, message.changes, message.eol as '\n' | '\r\n');
					return;
				}
				case 'drop': {
					if (typeof message.uri !== 'string') throw new TypeError('Invalid standalone Worker model');
					mirrors.get(message.uri)?.document.dispose();
					mirrors.delete(message.uri);
					return;
				}
				case 'clear':
					for (const mirror of mirrors.values()) mirror.document.dispose();
					mirrors.clear();
					return;
				default: throw new TypeError('Unknown standalone Worker notification');
			}
		},
	}));
	server.setChannel('foreign', new Proxy({}, {
		get: (_target, method) => async (...args: unknown[]) => {
			const target = await instance;
			const fn = (target as Record<string, unknown>)[method as string];
			if (typeof fn !== 'function') throw new ReferenceError(`Unknown standalone Worker method '${String(method)}'`);
			return fn.apply(target, args);
		},
	}));
	store.add(toDisposable(() => {
		for (const mirror of mirrors.values()) mirror.document.dispose();
		mirrors.clear();
	}));
	return store;
}

/** Owns one browser Worker, its model subscriptions, and both RPC channels. */
class MonacoWebWorkerImpl<T extends object> extends Disposable {
	private readonly models = this._register(new DisposableMap<string, DisposableStore>());
	private readonly tracked = new Map<string, ITextModel>();
	private readonly client: IWebWorkerClient<object>;
	private requestId = 0;
	private idleTimer: ReturnType<typeof setTimeout> | undefined;
	private proxy: T | undefined;

	constructor(private readonly modelService: IModelService, webWorkerService: IWebWorkerService, private readonly options: StandaloneWorkerOptions) {
		super();
		const client = this._register(webWorkerService.createWorkerClient<object>(options.worker, standaloneWorkerChannel));
		this.client = client;
		client.setChannel('host', options.host ?? {});
		this._register(client.onDidFail(() => this.clearModels()));
		this._register(toDisposable(() => this.clearModels()));
	}

	async getProxy(): Promise<T> {
		const client = this.client;
		await client.request(++this.requestId, { operation: 'ready' }, new AbortController().signal);
		if (!this.proxy) {
			const remote = client.getChannel<T>('foreign');
			this.proxy = new Proxy({} as T, {
				get: (_target, property) => {
					if (property === 'then') return undefined;
					if (typeof property !== 'string') throw new TypeError('Invalid standalone Worker method');
					return (...args: unknown[]) => {
						return (remote as Record<string, (...args: unknown[]) => Promise<unknown>>)[property]!(...args).then(result => {
							this.scheduleIdle();
							return result;
						});
					};
				},
			});
		}
		return this.proxy;
	}

	async withSyncedResources(resources: readonly URI[]): Promise<T> {
		const client = this.client;
		const models = resources.map(resource => this.modelService.getModel(resource)).filter((model): model is ITextModel => model !== null);
		for (const model of models) this.track(model, client);
		await client.request(++this.requestId, { operation: 'sync', snapshots: models.map(snapshot) }, new AbortController().signal);
		this.scheduleIdle();
		return this.getProxy();
	}

	private track(model: ITextModel, client: IWebWorkerClient<object>): void {
		const key = model.uri.toString();
		if (this.tracked.get(key) === model) return;
		this.models.deleteAndDispose(key);
		this.tracked.set(key, model);
		const listeners = new DisposableStore();
		this.models.set(key, listeners);
		listeners.add(model.onDidChangeContent(change => {
			client.send('change', {
				uri: key,
				previousVersion: change.version - 1,
				modelVersion: change.version,
				eol: change.eol,
				changes: change.changes.map(item => ({ rangeOffset: item.rangeOffset, rangeLength: item.rangeLength, text: item.text })),
			});
		}));
		listeners.add(Event.once(model.onWillDispose)(() => {
			this.tracked.delete(key);
			client.send('drop', { uri: key });
			this.models.deleteAndDispose(key);
		}));
	}

	private scheduleIdle(): void {
		this.assertNotDisposed();
		if (this.options.keepIdleModels) return;
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(() => {
			this.clearModels();
			this.client.send('clear', {});
		}, 60_000);
	}

	private clearModels(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
		for (const key of this.models.keys()) this.models.deleteAndDispose(key);
		this.tracked.clear();
	}
}

function snapshot(model: ITextModel): StandaloneWorkerSnapshot {
	return { uri: model.uri.toString(), version: model.getVersionId(), text: model.getValue(), lineCount: model.getLineCount() };
}
