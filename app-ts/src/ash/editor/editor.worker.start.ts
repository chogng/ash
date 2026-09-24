import { type Event } from '../base/common/event.js';
import { DisposableStore, toDisposable, type IDisposable } from '../base/common/lifecycle.js';

/** Structured-clone port owned by one dedicated editor worker runtime. */
export interface StanzaWorkerPort extends IDisposable {
	readonly onMessage: Event<unknown>;
	send(message: unknown): void;
}

/** Context supplied to one dedicated editor worker bootstrap. */
export interface StanzaWorkerContext {
	readonly port: StanzaWorkerPort;
	readonly resources: DisposableStore;
}

let activeResources: DisposableStore | undefined;

/** Starts one editor worker runtime over the canonical structured-clone port. */
export function start(bootstrap: (context: StanzaWorkerContext) => void, portFactory: () => StanzaWorkerPort = createDedicatedWorkerPort): void {
	if (typeof bootstrap !== 'function') throw new TypeError('Stanza worker bootstrap must be a function');
	if (activeResources) throw new Error('Stanza worker has already started');
	const resources = new DisposableStore();
	activeResources = resources;
	resources.add(toDisposable(() => {
		if (activeResources === resources) activeResources = undefined;
	}));
	try {
		const port = resources.add(portFactory());
		bootstrap({ port, resources });
	} catch (error) {
		resources.dispose();
		throw error;
	}
}

function createDedicatedWorkerPort(): StanzaWorkerPort {
	const scope = globalThis as unknown as DedicatedWorkerScope;
	if (typeof scope.postMessage !== 'function' || typeof scope.addEventListener !== 'function' || typeof scope.removeEventListener !== 'function') {
		throw new ReferenceError('Stanza worker must run in a dedicated worker scope');
	}
	let disposed = false;
	const dispose = (): void => {
		if (disposed) return;
		disposed = true;
		scope.close();
	};
	return {
		onMessage(listener) {
			if (disposed) throw new ReferenceError('Stanza worker port is disposed');
			if (typeof listener !== 'function') throw new TypeError('Stanza worker message listener must be a function');
			const handler = (event: { readonly data: unknown }) => listener(event.data);
			scope.addEventListener('message', handler);
			return toDisposable(() => scope.removeEventListener('message', handler));
		},
		send(message) {
			if (disposed) throw new ReferenceError('Stanza worker port is disposed');
			scope.postMessage(message);
		},
		dispose,
		[Symbol.dispose]: dispose,
	};
}

interface DedicatedWorkerScope {
	postMessage(message: unknown): void;
	addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
	removeEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
	close(): void;
}
