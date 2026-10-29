import { ensureNoDisposablesAreLeakedInTestSuite } from '../utils.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { Emitter } from '../../../common/event.js';
import { Disposable } from '../../../common/lifecycle.js';
import { WebWorkerClient, WebWorkerServer, WebWorkerRemoteError } from '../../../common/worker/webWorker.js';

suite('Worker transport and RPC', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	class MemoryPort extends Disposable {
		private readonly messages = this._register(new Emitter<unknown>());
		private readonly failures = this._register(new Emitter<unknown>());
		public readonly onMessage = this.messages.event;
		public readonly onFailure = this.failures.event;
		public peer!: MemoryPort;

		public send(message: unknown, transfer: readonly ArrayBuffer[] = []): void {
			this.assertNotDisposed();
			const data = structuredClone(message, { transfer: [...transfer] });
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
		const ready = new Promise<void>(resolve => {
			started = resolve;
		});
		let remoteSignal: AbortSignal | undefined;
		using server = new WebWorkerServer(serverPort, channel, {
			handleRequest: async (message, signal) => {
				if (message.wait) {
					remoteSignal = signal;
					started();
					await new Promise<void>(resolve =>
						signal.addEventListener('abort', () => resolve(), { once: true }),
					);
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
			handleRequest: async (_message, signal) =>
				new Promise(resolve => signal.addEventListener('abort', () => resolve(null), { once: true })),
			handleNotification: () => {
				throw new RangeError('Invalid settings');
			},
		});
		using client = new WebWorkerClient(clientPort, channel);
		const pending = client.request(1, {}, new AbortController().signal);
		client.send('settings', {});
		await assert.rejects(
			pending,
			error =>
				error instanceof WebWorkerRemoteError &&
				error.remoteName === 'RangeError' &&
				error.message === 'Invalid settings',
		);
		assert.equal(clientPort.isDisposed, true);
		assert.throws(() => client.request(2, {}, new AbortController().signal), /Invalid settings/);
	});

	test('Worker proxies route named channels and host callbacks through the same request protocol', async () => {
		const [clientPort, serverPort] = ports();
		using client = new WebWorkerClient<{
			$add(a: number, b: number): number;
			$host(value: string): Promise<string>;
		}>(clientPort);
		client.setChannel('host', { $echo: (value: string) => `host:${value}` });
		using server = new WebWorkerServer(serverPort, server => ({
			$add: (a: number, b: number) => a + b,
			$host: (value: string) => server.getChannel<{ $echo(value: string): string }>('host').$echo(value),
		}));
		server.setChannel('other', { $add: (value: number) => value * 2 });
		assert.equal(await client.proxy.$add(2, 3), 5);
		assert.equal(await client.proxy.$host('hello'), 'host:hello');
		assert.equal(await client.getChannel<{ $add(value: number): number }>('other').$add(7), 14);
		assert.equal(client.getChannel('other'), client.getChannel('other'));
		await assert.rejects(client.getChannel<{ $missing(): void }>('other').$missing(), /Unknown Worker method/);
		assert.equal(await client.proxy.$add(5, 6), 11);
	});

	test('disposing a Worker proxy rejects pending calls and prevents a retained proxy from sending', async () => {
		const [clientPort, serverPort] = ports();
		using server = new WebWorkerServer(serverPort, () => ({ $wait: () => new Promise(() => {}) }));
		const client = new WebWorkerClient<{ $wait(): Promise<void> }>(clientPort);
		const proxy = client.proxy;
		const rejected = assert.rejects(proxy.$wait(), /disposed/);
		client.dispose();
		await rejected;
		assert.throws(() => proxy.$wait(), /disposed/);
	});

	test('Worker proxies transfer ArrayBuffer arguments and replies without retaining the sending buffer', async () => {
		const [clientPort, serverPort] = ports();
		using server = new WebWorkerServer(serverPort, () => ({ $echo: (value: ArrayBuffer) => value }));
		using client = new WebWorkerClient<{ $echo(value: ArrayBuffer): ArrayBuffer }>(clientPort);
		const bytes = new Uint8Array([3, 7, 11]);
		const result = client.proxy.$echo(bytes.buffer);
		assert.equal(bytes.byteLength, 0);
		assert.deepEqual(new Uint8Array(await result), new Uint8Array([3, 7, 11]));
	});

	test('a failed domain channel also settles calls on its generic proxy', async () => {
		const [clientPort, serverPort] = ports();
		using server = new WebWorkerServer(serverPort, channel, {
			handleRequest: async () => null,
			handleNotification: () => {
				throw new Error('Domain channel failed');
			},
		});
		server.setChannel('foreign', { $wait: () => new Promise(() => {}) });
		using client = new WebWorkerClient(clientPort, channel);
		const rejected = assert.rejects(
			client.getChannel<{ $wait(): void }>('foreign').$wait(),
			/Domain channel failed/,
		);
		client.send('invalid', {});
		await rejected;
	});
});
