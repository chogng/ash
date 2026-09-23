import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import type { URI } from '../../../../base/common/uri.js';
import { WebWorkerClient, WebWorkerServer, type WebWorkerClientPort, type WebWorkerPort } from '../../../../base/common/worker/webWorker.js';
import { BrowserWorkerClientPort } from '../../../../platform/webWorker/browser/browserWorkerClientPort.js';
import type { ITextModel } from '../../../common/model.js';
import type { IModelService } from '../../../common/services/model.js';

export const standaloneWorkerChannel = Object.freeze({ protocol: 'ash.standalone-worker', version: 1 });
export const standaloneHostChannel = Object.freeze({ protocol: 'ash.standalone-worker-host', version: 1 });

export interface StandaloneWorkerSnapshot {
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

/** Owns one browser Worker, its model subscriptions, and both RPC channels. */
export class StandaloneWebWorkerService<T extends object> extends Disposable {
	private readonly models = this._register(new DisposableMap<string, DisposableStore>());
	private readonly tracked = new Map<string, ITextModel>();
	private readonly ready: Promise<WebWorkerClient>;
	private client: WebWorkerClient | undefined;
	private requestId = 0;
	private idleTimer: ReturnType<typeof setTimeout> | undefined;
	private proxy: T | undefined;

	constructor(private readonly modelService: IModelService, private readonly options: StandaloneWorkerOptions) {
		super();
		this.ready = Promise.resolve(options.worker).then(worker => {
			if (this.isDisposed) {
				worker.terminate();
				throw new ReferenceError('Standalone Worker is disposed');
			}
			const port = this._register(new BrowserWorkerClientPort(worker));
			const channel = sharedPort(port);
			const client = this._register(new WebWorkerClient(channel, standaloneWorkerChannel));
			this.client = client;
			this._register(new WebWorkerServer(channel, standaloneHostChannel, {
				handleRequest: async message => {
					if (message.operation !== 'invoke' || typeof message.method !== 'string' || !Array.isArray(message.args)) {
						throw new TypeError('Invalid standalone Worker host request');
					}
					const method = this.options.host && Object.hasOwn(this.options.host, message.method) ? this.options.host[message.method] : undefined;
					if (typeof method !== 'function') throw new ReferenceError(`Unknown standalone Worker host method '${message.method}'`);
					return method.apply(this.options.host, message.args);
				},
				handleNotification: () => { throw new TypeError('Unknown standalone Worker host notification'); },
			}));
			this._register(client.onDidFail(() => this.clearModels()));
			return client;
		});
		void this.ready.catch(() => {});
		this._register(toDisposable(() => this.clearModels()));
	}

	async getProxy(): Promise<T> {
		const client = await this.ready;
		await client.request(++this.requestId, { operation: 'ready' }, new AbortController().signal);
		if (!this.proxy) {
			this.proxy = new Proxy({} as T, {
				get: (_target, property) => {
					if (property === 'then') return undefined;
					if (typeof property !== 'string' || property === 'constructor' || property === '__proto__' || property === 'prototype') {
						throw new TypeError('Invalid standalone Worker method');
					}
					return (...args: unknown[]) => this.invoke(property, args);
				},
			});
		}
		return this.proxy;
	}

	async withSyncedResources(resources: readonly URI[]): Promise<T> {
		const client = await this.ready;
		const models = resources.map(resource => this.modelService.getModel(resource)).filter((model): model is ITextModel => model !== null);
		for (const model of models) this.track(model, client);
		await client.request(++this.requestId, { operation: 'sync', snapshots: models.map(snapshot) }, new AbortController().signal);
		this.scheduleIdle();
		return this.getProxy();
	}

	private async invoke(method: string, args: readonly unknown[]): Promise<unknown> {
		const client = await this.ready;
		const result = await client.request(++this.requestId, { operation: 'invoke', method, args }, new AbortController().signal);
		this.scheduleIdle();
		return result;
	}

	private track(model: ITextModel, client: WebWorkerClient): void {
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
		listeners.add(model.onWillDispose(() => {
			this.tracked.delete(key);
			client.send('drop', { uri: key });
			this.models.deleteAndDispose(key);
		}));
	}

	private scheduleIdle(): void {
		if (this.options.keepIdleModels) return;
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(() => {
			this.clearModels();
			this.client?.send('clear', {});
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

/** Both RPC channels share one physical Worker without either channel terminating it. */
export function sharedPort(port: WebWorkerClientPort): WebWorkerClientPort & WebWorkerPort {
	return { onMessage: port.onMessage, onFailure: port.onFailure, send: value => port.send(value), ...Disposable.None };
}
