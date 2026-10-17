import { toDisposable } from '../../../base/common/lifecycle.js';
import { WebWorkerServer, type WebWorkerPort } from '../../../base/common/worker/webWorker.js';
import { appServerDecodeChannel, appServerDecodeHandler } from './appServerProtocolDecoding.js';

// This Worker is part of the Renderer protocol client, with no transport or UI access.
const scope = globalThis as unknown as {
	postMessage(value: unknown): void;
	addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
	removeEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
	close(): void;
};
const port: WebWorkerPort = {
	onMessage(listener) {
		const receive = (event: MessageEvent<unknown>) => listener(event.data);
		scope.addEventListener('message', receive);
		return toDisposable(() => scope.removeEventListener('message', receive));
	},
	send: value => scope.postMessage(value),
	dispose: () => scope.close(),
	[Symbol.dispose]: () => scope.close(),
};
new WebWorkerServer(port, appServerDecodeChannel, appServerDecodeHandler);
