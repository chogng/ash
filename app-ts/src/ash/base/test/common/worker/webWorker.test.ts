import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter } from '../../../common/event.js';
import { Disposable } from '../../../common/lifecycle.js';
import { WebWorkerClient, WebWorkerServer, WebWorkerRemoteError } from '../../../common/worker/webWorker.js';

class MemoryPort extends Disposable {
	private readonly messages = this._register(new Emitter<unknown>());
	private readonly failures = this._register(new Emitter<unknown>());
	public readonly onMessage = this.messages.event;
	public readonly onFailure = this.failures.event;
	public peer!: MemoryPort;

	public send(message: unknown): void {
		this.assertNotDisposed();
		const data = structuredClone(message);
		queueMicrotask(() => {
			if (!this.peer.isDisposed) {
				this.peer.messages.fire(data);
			}
		});
	}
}

function ports(): [MemoryPort, MemoryPort] {
	const client = new MemoryPort();
	const server = new MemoryPort();
	client.peer = server;
	server.peer = client;
	return [client, server];
}

const channel = { protocol: 'test.calculator', version: 1 };

test('cancelling one worker request leaves unrelated requests usable', async () => {
	const [clientPort, serverPort] = ports();
	let started!: () => void;
	const ready = new Promise<void>(resolve => { started = resolve; });
	let remoteSignal: AbortSignal | undefined;
	using server = new WebWorkerServer(serverPort, channel, {
		handleRequest: async (message, signal) => {
			if (message.wait) {
				remoteSignal = signal;
				started();
				await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
			}
			return Number(message.value) * 2;
		},
		handleNotification: () => assert.fail('No notification expected'),
	});
	using client = new WebWorkerClient(clientPort, channel);
	const abort = new AbortController();
	const cancelled = client.request(1, { wait: true, value: 3 }, abort.signal);
	await ready;
	abort.abort();
	await assert.rejects(cancelled, { name: 'AbortError' });
	assert.equal(await client.request(2, { value: 9 }, new AbortController().signal), 18);
	assert.equal(remoteSignal?.aborted, true);
});

test('notification failure rejects pending requests and prevents further use', async () => {
	const [clientPort, serverPort] = ports();
	using server = new WebWorkerServer(serverPort, channel, {
		handleRequest: async (_message, signal) => new Promise(resolve => signal.addEventListener('abort', () => resolve(null), { once: true })),
		handleNotification: () => { throw new RangeError('Invalid settings'); },
	});
	using client = new WebWorkerClient(clientPort, channel);
	const pending = client.request(1, {}, new AbortController().signal);
	client.send('settings', {});
	await assert.rejects(pending, error => error instanceof WebWorkerRemoteError && error.remoteName === 'RangeError' && error.message === 'Invalid settings');
	assert.throws(() => client.request(2, {}, new AbortController().signal), /Invalid settings/);
});
