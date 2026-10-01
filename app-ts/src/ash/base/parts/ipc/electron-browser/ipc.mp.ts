import { addDisposableListener } from '../../../browser/dom.js';
import type { CancelablePromise } from '../../../common/async.js';
import { CancellationError } from '../../../common/errors.js';
import { DisposableStore, toDisposable } from '../../../common/lifecycle.js';
import { isRecord } from '../../../common/types.js';
import { generateUuid } from '../../../common/uuid.js';
import type { ISandboxSubscription } from '../../sandbox/common/sandboxTypes.js';
import { ipcMessagePort, ipcRenderer } from '../../sandbox/electron-browser/globals.js';

/** Main could not provide the requested port; fatal failures require host recovery. */
export class MessagePortAcquisitionError extends Error {
	constructor(message: string, public readonly fatal: boolean) {
		super(message);
	}
}

/** A successful response transfers port ownership to the caller; cancellation releases only waiting resources. */
export function acquirePort(
	requestChannel: string | undefined,
	responseChannel: string,
	nonce: string = generateUuid(),
	acquire: (channel: string, requestNonce: string) => ISandboxSubscription | void = (channel, requestNonce) => ipcMessagePort.acquire(channel, requestNonce),
): CancelablePromise<MessagePort> {
	const resources = new DisposableStore();
	const targetWindow = window;
	let settled = false;
	let cancel: () => void;
	const result = new Promise<MessagePort>((resolve, reject) => {
		const finish = (outcome: { port: MessagePort } | { error: unknown }): void => {
			if (settled) { return; }
			settled = true;
			resources.dispose();
			if ('error' in outcome) {
				reject(outcome.error);
			} else {
				resolve(outcome.port);
			}
		};
		cancel = () => finish({ error: new CancellationError() });
		resources.add(addDisposableListener(targetWindow, 'message', (event: MessageEvent) => {
			const response: unknown = event.data;
			const responseNonce = typeof response === 'string' ? response : isRecord(response) ? response.nonce : undefined;
			if (event.source !== targetWindow || responseNonce !== nonce) { return; }
			if (isRecord(response) && typeof response.error === 'string') {
				for (const port of event.ports) { port.close(); }
				finish({ error: new MessagePortAcquisitionError(response.error, response.fatal === true) });
			} else if (event.ports.length !== 1) {
				for (const port of event.ports) { port.close(); }
				finish({ error: new Error(`MessagePort response '${responseChannel}' must include exactly one port`) });
			} else {
				finish({ port: event.ports[0] });
			}
		}));
		try {
			// Install the DOM listener before preload registration or request dispatch can deliver a response.
			const subscription = acquire(responseChannel, nonce);
			if (subscription) {
				if (settled) {
					subscription.dispose();
				} else {
					resources.add(toDisposable(() => subscription.dispose()));
				}
			}
			if (requestChannel !== undefined) { ipcRenderer.send(requestChannel, nonce); }
		} catch (error) {
			finish({ error });
		}
	}) as CancelablePromise<MessagePort>;
	result.cancel = () => cancel();
	return result;
}
