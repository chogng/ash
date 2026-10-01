import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { setup, suite, teardown, test } from 'mocha';
import { VSBuffer } from '../../../../common/buffer.js';
import { CancellationTokenSource, type CancellationToken } from '../../../../common/cancellation.js';
import { Emitter, Event } from '../../../../common/event.js';
import { Disposable, DisposableStore, DisposableTracker, installDisposableTracker, toDisposable } from '../../../../common/lifecycle.js';
import { IPCClient, IPCServer, type ClientConnectionEvent, type IMessagePassingProtocol, type IServerChannel } from '../../common/ipc.js';

class MemoryProtocol extends Disposable implements IMessagePassingProtocol {
	private readonly messages = this._register(new Emitter<VSBuffer>());
	public readonly onMessage = this.messages.event;
	public other!: MemoryProtocol;
	public send(buffer: VSBuffer): void {
		this.assertNotDisposed();
		queueMicrotask(() => { if (!this.other.isDisposed) { this.other.messages.fire(buffer); } });
	}
}

function pair(resources: DisposableStore): [MemoryProtocol, MemoryProtocol] {
	const first = resources.add(new MemoryProtocol());
	const second = resources.add(new MemoryProtocol());
	first.other = second; second.other = first;
	return [first, second];
}

suite('IPC channels', () => {
	let tracker: DisposableTracker;
	let tracking: ReturnType<typeof installDisposableTracker>;
	setup(() => { tracker = new DisposableTracker(); tracking = installDisposableTracker(tracker); });
	teardown(() => { try { tracker.assertNoLeaks(); } finally { tracking[Symbol.dispose](); } });

	test('calls carry JSON data and errors in both directions without ending the connection', async () => {
		using resources = new DisposableStore();
		const [a, b] = pair(resources);
		const first = resources.add(new IPCClient(a, 'first'));
		const second = resources.add(new IPCClient(b, 'second'));
		const channel: IServerChannel = {
			async call<T>(context: string, command: string, arg?: unknown): Promise<T> {
				if (command === 'fail') { throw new TypeError('Invalid operation'); }
				return { context, arg } as T;
			}, listen: () => Event.None,
		};
		first.registerChannel('echo', channel); second.registerChannel('echo', channel);
		const payload = { items: [false, null, '你好'], count: 3 };
		assert.deepEqual(await Promise.all([
			first.getChannel('echo').call('read', payload),
			second.getChannel('echo').call('read'),
		]), [{ context: 'second', arg: payload }, { context: 'first' }]);
		await assert.rejects(first.getChannel('echo').call('fail'), { name: 'TypeError', message: 'Invalid operation' });
		await assert.rejects(first.getChannel('missing').call('read'), /Unknown IPC channel/);
		assert.deepEqual(await first.getChannel('echo').call('read', 4), { context: 'second', arg: 4 });
		assert.throws(() => second.registerChannel('echo', channel), /already registered/);
	});

	test('cancelling a call cancels the server operation and discards its late result', async () => {
		using resources = new DisposableStore();
		const [a, b] = pair(resources);
		const client = resources.add(new IPCClient(a, 'renderer'));
		const server = resources.add(new IPCClient(b, 'window:1'));
		using token = new CancellationTokenSource();
		let cancelled = 0;
		let finish!: (value: unknown) => void;
		server.registerChannel('slow', {
			call<T>(_context: string, _command: string, _arg: unknown, cancellation?: CancellationToken): Promise<T> {
				resources.add(cancellation!.onCancellationRequested(() => cancelled++));
				return new Promise<T>(resolve => { finish = resolve as (value: unknown) => void; });
			}, listen: () => Event.None,
		});
		const call = client.getChannel('slow').call('run', undefined, token.token);
		await setImmediate();
		const rejected = assert.rejects(call, { name: 'CancellationError' });
		token.cancel();
		await rejected; await setImmediate();
		finish('late'); await setImmediate();
		assert.equal(cancelled, 1);
		await assert.rejects(client.getChannel('slow').call('run', undefined, token.token), { name: 'CancellationError' });
	});

	test('disposing a listener releases its server subscription while other listeners stay live', async () => {
		using resources = new DisposableStore();
		const [a, b] = pair(resources);
		const client = resources.add(new IPCClient(a, 'renderer'));
		const server = resources.add(new IPCClient(b, 'window:1'));
		const changes = resources.add(new Emitter<number>());
		let subscriptions = 0;
		server.registerChannel('changes', {
			call: async <T>() => undefined as T,
			listen<T>(): Event<T> {
				return listener => {
					subscriptions++;
					const subscription = changes.event(value => listener(value as T));
					return toDisposable(() => { subscription.dispose(); subscriptions--; });
				};
			},
		});
		const first: number[] = []; const second: number[] = [];
		const listener = resources.add(client.getChannel('changes').listen<number>('updated')(value => first.push(value)));
		resources.add(client.getChannel('changes').listen<number>('updated')(value => second.push(value)));
		await setImmediate(); changes.fire(1); await setImmediate();
		listener.dispose(); await setImmediate(); changes.fire(2); await setImmediate();
		assert.deepEqual({ first, second, subscriptions }, { first: [1], second: [1, 2], subscriptions: 1 });
		client.dispose(); await setImmediate();
		assert.equal(subscriptions, 0);
	});

	test('closing one window rejects its calls and subscriptions without touching another window', async () => {
		using resources = new DisposableStore();
		const connections = resources.add(new Emitter<ClientConnectionEvent>());
		const server = resources.add(new IPCServer(connections.event));
		const operations: { context: string; cancelled: boolean; finish(value: unknown): void }[] = [];
		const active = new Set<string>();
		server.registerChannel('system', {
			call<T>(context: string, _command: string, _arg: unknown, token?: CancellationToken): Promise<T> {
				return new Promise<T>(resolve => {
					const operation = { context, cancelled: false, finish: resolve as (value: unknown) => void };
					operations.push(operation);
					resources.add(token!.onCancellationRequested(() => { operation.cancelled = true; }));
				});
			},
			listen<T>(context: string): Event<T> { return () => { active.add(context); return toDisposable(() => { active.delete(context); }); }; },
		});
		const open = (context: string): { client: IPCClient; disconnect: Emitter<void> } => {
			const [a, b] = pair(resources);
			const disconnect = resources.add(new Emitter<void>());
			const client = resources.add(new IPCClient(a, 'untrusted renderer claim'));
			connections.fire({ protocol: b, ctx: context, onDidClientDisconnect: disconnect.event });
			resources.add(toDisposable(() => disconnect.fire()));
			return { client, disconnect };
		};
		const first = open('window:1'); const second = open('window:2');
		resources.add(first.client.getChannel('system').listen('changed')(() => {}));
		resources.add(second.client.getChannel('system').listen('changed')(() => {}));
		const firstChannel = first.client.getChannel('system');
		const firstCall = firstChannel.call('read'); const secondCall = second.client.getChannel('system').call('read');
		await setImmediate();
		const rejected = assert.rejects(firstCall, /IPC connection closed/);
		first.disconnect.fire(); await rejected; await setImmediate();
		await assert.rejects(firstChannel.call('read'), /IPC connection closed/);
		operations[0]!.finish('old'); operations[1]!.finish('second result');
		assert.equal(await secondCall, 'second result');
		assert.deepEqual({ active: [...active], operations: operations.map(({ context, cancelled }) => ({ context, cancelled })) }, {
			active: ['window:2'], operations: [{ context: 'window:1', cancelled: true }, { context: 'window:2', cancelled: false }],
		});
	});
});
