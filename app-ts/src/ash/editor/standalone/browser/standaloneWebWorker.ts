import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { WebWorkerClient, WebWorkerServer, type WebWorkerClientPort } from '../../../base/common/worker/webWorker.js';
import { type IModelService } from '../../common/services/model.js';
import { LanguageWorkerDocumentMirror } from '../../common/services/textModelSync/textModelSync.impl.js';
import { StandaloneWebWorkerService, standaloneHostChannel, standaloneWorkerChannel, sharedPort, type StandaloneWorkerOptions, type StandaloneWorkerSnapshot } from './services/standaloneWebWorkerService.js';

export interface MonacoWebWorker<T extends object> extends IDisposable {
	getProxy(): Promise<T>;
	withSyncedResources(resources: URI[]): Promise<T>;
}

/** Creates a Worker whose foreign methods can read synchronized editor models. */
export function createWebWorker<T extends object>(modelService: IModelService, options: StandaloneWorkerOptions): MonacoWebWorker<T> {
	return new StandaloneWebWorkerService<T>(modelService, options);
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
	postMessage(message: unknown): void;
}

/** Called once by the supplied Worker module to serve foreign method requests. */
export function startStandaloneWebWorker<T extends object>(scope: StandaloneWorkerScope, create: (context: StandaloneWorkerContext) => T | Promise<T>): IDisposable {
	const store = new DisposableStore();
	const messages = store.add(new Emitter<unknown>());
	const listener = (event: MessageEvent<unknown>): void => messages.fire(event.data);
	scope.addEventListener('message', listener);
	store.add(toDisposable(() => scope.removeEventListener('message', listener)));
	const port: WebWorkerClientPort = { onMessage: messages.event, onFailure: Event.None, send: value => scope.postMessage(value), ...Disposable.None };
	const host = store.add(new WebWorkerClient(sharedPort(port), standaloneHostChannel));
	const mirrors = new Map<string, { readonly uri: URI; readonly document: LanguageWorkerDocumentMirror }>();
	let requestId = 0;
	const context: StandaloneWorkerContext = {
		getMirrorModels: () => [...mirrors.values()].map(({ uri, document }) => ({
			uri,
			get version() { return document.version; },
			getValue: () => document.createSnapshot().getText(),
		})),
		callHost: (method, ...args) => host.request(++requestId, { operation: 'invoke', method, args }, new AbortController().signal),
	};
	const instance = Promise.resolve().then(() => create(context));
	void instance.catch(() => {});
	store.add(new WebWorkerServer(sharedPort(port), standaloneWorkerChannel, {
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
				case 'invoke': {
					if (typeof message.method !== 'string' || !Array.isArray(message.args) || ['constructor', 'prototype', '__proto__'].includes(message.method)) {
						throw new TypeError('Invalid standalone Worker method');
					}
					const target = await instance;
					const method = (target as Record<string, unknown>)[message.method];
					if (typeof method !== 'function') throw new ReferenceError(`Unknown standalone Worker method '${message.method}'`);
					return method.apply(target, message.args);
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
	store.add(toDisposable(() => {
		for (const mirror of mirrors.values()) mirror.document.dispose();
		mirrors.clear();
	}));
	return store;
}
