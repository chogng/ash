import { VSBuffer } from '../../../common/buffer.js';
import { CancellationToken, CancellationTokenSource } from '../../../common/cancellation.js';
import { CancellationError, onUnexpectedError } from '../../../common/errors.js';
import { Emitter, Event } from '../../../common/event.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable, type IDisposable } from '../../../common/lifecycle.js';
import { isRecord } from '../../../common/types.js';

export interface IChannel {
	call<T>(command: string, arg?: unknown, cancellationToken?: CancellationToken): Promise<T>;
	listen<T>(event: string, arg?: unknown): Event<T>;
}

export interface IServerChannel<TContext = string> {
	call<T>(context: TContext, command: string, arg?: unknown, cancellationToken?: CancellationToken): Promise<T>;
	listen<T>(context: TContext, event: string, arg?: unknown): Event<T>;
}

/** Domain adapters encode channel payloads as JSON data before crossing this boundary. */
export interface IMessagePassingProtocol {
	send(buffer: VSBuffer): void;
	readonly onMessage: Event<VSBuffer>;
	readonly onDidClose?: Event<void>;
}

export interface IChannelClient {
	getChannel<T extends IChannel>(channelName: string): T;
}

export interface IChannelServer<TContext = string> {
	registerChannel(channelName: string, channel: IServerChannel<TContext>): void;
}

/** Service proxies transport JSON data; implementations keep process-local objects and lifetimes. */
export namespace ProxyChannel {
	export function fromService<TContext>(service: object, _disposables: DisposableStore): IServerChannel<TContext> {
		const member = (name: string): Function => {
			if (name in Object.prototype) { throw new Error('Unknown service member: ' + name); }
			const value: unknown = Reflect.get(service, name);
			if (typeof value !== 'function') { throw new Error('Unknown service member: ' + name); }
			return value;
		};
		return {
			call: async <T>(_context: TContext, command: string, arg: unknown): Promise<T> => {
				if (command.startsWith('on') || !Array.isArray(arg)) { throw new TypeError('Invalid service call'); }
				return await member(command).apply(service, arg) as T;
			},
			listen: <T>(_context: TContext, event: string, arg: unknown): Event<T> => {
				if (event.startsWith('onDynamic')) {
					if (!Array.isArray(arg)) { throw new TypeError('Invalid dynamic event arguments'); }
					return member(event).apply(service, arg) as Event<T>;
				}
				if (!event.startsWith('on')) { throw new TypeError('Invalid service event'); }
				return member(event).bind(service) as Event<T>;
			},
		};
	}

	export function toService<T extends object>(channel: IChannel): T {
		return new Proxy({}, {
			get: (_target, name) => {
				if (typeof name !== 'string' || name === 'then') { return undefined; }
				if (name.startsWith('onDynamic')) { return (...args: unknown[]) => channel.listen(name, args); }
				if (name.startsWith('on')) { return channel.listen(name); }
				return (...args: unknown[]) => channel.call(name, args);
			},
		}) as T;
	}
}

interface PendingCall {
	readonly resources: DisposableStore;
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: Error) => void;
}

type Packet =
	| { type: 'call' | 'listen'; id: number; channel: string; name: string; arg?: unknown }
	| { type: 'result' | 'event'; id: number; data?: unknown }
	| { type: 'error'; id: number; error: { name: string; message: string } }
	| { type: 'cancel' | 'unsubscribe'; id: number }
	| { type: 'closed' };

function decode(buffer: VSBuffer): Packet {
	const value: unknown = JSON.parse(buffer.toString());
	if (!isRecord(value)) { throw new TypeError('Invalid IPC packet'); }
	if (value.type === 'closed') { return { type: 'closed' }; }
	if (!Number.isSafeInteger(value.id) || (value.id as number) <= 0) { throw new TypeError('Invalid IPC request ID'); }
	switch (value.type) {
		case 'call': case 'listen':
			if (typeof value.channel !== 'string' || !value.channel || typeof value.name !== 'string' || !value.name) {
				throw new TypeError('Invalid IPC channel operation');
			}
			break;
		case 'result': case 'event': case 'cancel': case 'unsubscribe': break;
		case 'error':
			if (!isRecord(value.error) || typeof value.error.name !== 'string' || typeof value.error.message !== 'string') {
				throw new TypeError('Invalid IPC error');
			}
			break;
		default: throw new TypeError('Unknown IPC packet type');
	}
	return value as Packet;
}

/** One authenticated connection owns both directions of calls and event subscriptions. */
export class IPCClient<TContext = string> extends Disposable implements IChannelClient, IChannelServer<TContext> {
	private sequence = 0;
	private disconnected = false;
	private closeError = new Error('IPC connection closed');
	private readonly channels = new Map<string, IServerChannel<TContext>>();
	private readonly pending = new Map<number, PendingCall>();
	private readonly listeners = new Map<number, { deliver(value: unknown): void; dispose(): void }>();
	private readonly calls = new Map<number, CancellationTokenSource>();
	private readonly subscriptions = new Map<number, IDisposable>();

	constructor(private readonly protocol: IMessagePassingProtocol, private readonly context: TContext) {
		super();
		this._register(toDisposable(() => this.release()));
		this._register(protocol.onMessage(buffer => {
			try { this.receive(decode(buffer)); }
			catch (error) {
				this.closeError = error instanceof Error ? error : new Error(String(error));
				this.dispose();
				onUnexpectedError(this.closeError);
			}
		}));
		if (protocol.onDidClose) {
			this._register(protocol.onDidClose(() => { this.disconnected = true; this.dispose(); }));
		}
	}

	public getChannel<T extends IChannel>(channelName: string): T {
		this.assertNotDisposed();
		return {
			call: <R>(command: string, arg?: unknown, token = CancellationToken.None) => this.call<R>(channelName, command, arg, token),
			listen: <R>(event: string, arg?: unknown) => this.listen<R>(channelName, event, arg),
		} as T;
	}

	public registerChannel(channelName: string, channel: IServerChannel<TContext>): void {
		this.assertNotDisposed();
		if (this.channels.has(channelName)) { throw new Error(`IPC channel '${channelName}' is already registered`); }
		this.channels.set(channelName, channel);
	}

	private call<T>(channel: string, name: string, arg: unknown, token: CancellationToken): Promise<T> {
		if (this.isDisposed) { return Promise.reject(this.closeError); }
		if (token.isCancellationRequested) { return Promise.reject(new CancellationError()); }
		const id = ++this.sequence;
		return new Promise<T>((resolve, reject) => {
			const resources = new DisposableStore();
			this.pending.set(id, { resources, resolve: value => resolve(value as T), reject });
			resources.add(token.onCancellationRequested(() => {
				this.finish(id, new CancellationError(), true);
				this.send({ type: 'cancel', id });
			}));
			try { this.send({ type: 'call', id, channel, name, arg }); }
			catch (error) { this.finish(id, error instanceof Error ? error : new Error(String(error)), true); }
		});
	}

	private listen<T>(channel: string, name: string, arg: unknown): Event<T> {
		return (listener, thisArgs, disposables) => {
			this.assertNotDisposed();
			const id = ++this.sequence;
			const subscription = toDisposable(() => {
				if (!this.listeners.delete(id) || this.isDisposed) { return; }
				this.send({ type: 'unsubscribe', id });
			});
			this.listeners.set(id, { deliver: value => listener.call(thisArgs, value as T), dispose: () => subscription.dispose() });
			try { this.send({ type: 'listen', id, channel, name, arg }); }
			catch (error) { this.listeners.delete(id); subscription.dispose(); throw error; }
			if (Array.isArray(disposables)) { disposables.push(subscription); } else { disposables?.add(subscription); }
			return subscription;
		};
	}

	private finish(id: number, value: unknown, failed: boolean): void {
		const call = this.pending.get(id);
		if (!call) { return; }
		this.pending.delete(id);
		call.resources.dispose();
		if (failed) { call.reject(value as Error); } else { call.resolve(value); }
	}

	private send(packet: Packet): void { this.protocol.send(VSBuffer.fromString(JSON.stringify(packet))); }

	private receive(packet: Packet): void {
		switch (packet.type) {
			case 'closed': this.disconnected = true; this.dispose(); return;
			case 'result': this.finish(packet.id, packet.data, false); return;
			case 'error': {
				const error = packet.error.name === 'CancellationError' ? new CancellationError() : new Error(packet.error.message);
				error.name = packet.error.name;
				const listener = this.listeners.get(packet.id);
				if (listener) { listener.dispose(); onUnexpectedError(error); return; }
				this.finish(packet.id, error, true);
				return;
			}
			case 'event':
				try { this.listeners.get(packet.id)?.deliver(packet.data); } catch (error) { onUnexpectedError(error); }
				return;
			case 'cancel': this.calls.get(packet.id)?.cancel(); return;
			case 'unsubscribe': this.subscriptions.get(packet.id)?.dispose(); this.subscriptions.delete(packet.id); return;
			case 'call': this.acceptCall(packet); return;
			case 'listen': this.acceptSubscription(packet); return;
		}
	}

	private acceptCall(packet: Extract<Packet, { type: 'call' | 'listen' }>): void {
		this.assertRequestAvailable(packet.id);
		const source = new CancellationTokenSource();
		this.calls.set(packet.id, source);
		void (async () => {
			try {
				const channel = this.channels.get(packet.channel);
				if (!channel) { throw new Error(`Unknown IPC channel '${packet.channel}'`); }
				const data = await channel.call(this.context, packet.name, packet.arg, source.token);
				if (!this.isDisposed && !source.token.isCancellationRequested) { this.send({ type: 'result', id: packet.id, data }); }
			} catch (error) {
				if (!this.isDisposed && !source.token.isCancellationRequested) { this.replyError(packet.id, error); }
			} finally { this.calls.delete(packet.id); source.dispose(); }
		})();
	}

	private acceptSubscription(packet: Extract<Packet, { type: 'call' | 'listen' }>): void {
		this.assertRequestAvailable(packet.id);
		try {
			const channel = this.channels.get(packet.channel);
			if (!channel) { throw new Error(`Unknown IPC channel '${packet.channel}'`); }
			const subscription = channel.listen(this.context, packet.name, packet.arg)(data => this.send({ type: 'event', id: packet.id, data }));
			if (this.isDisposed) { subscription.dispose(); } else { this.subscriptions.set(packet.id, subscription); }
		} catch (error) { this.replyError(packet.id, error); }
	}

	private replyError(id: number, error: unknown): void {
		this.send({ type: 'error', id, error: { name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error) } });
	}

	private assertRequestAvailable(id: number): void {
		if (this.calls.has(id) || this.subscriptions.has(id)) { throw new TypeError('Duplicate active IPC request ID'); }
	}

	private release(): void {
		try { if (!this.disconnected) { this.send({ type: 'closed' }); } }
		finally {
			for (const id of this.pending.keys()) { this.finish(id, this.closeError, true); }
			for (const listener of this.listeners.values()) { listener.dispose(); }
			this.listeners.clear();
			for (const source of this.calls.values()) { source.dispose(true); }
			this.calls.clear();
			for (const subscription of this.subscriptions.values()) { subscription.dispose(); }
			this.subscriptions.clear();
			this.channels.clear();
		}
	}
}

export interface Client<TContext> {
	readonly ctx: TContext;
}

export interface ClientConnectionEvent<TContext = string> extends Client<TContext> {
	readonly protocol: IMessagePassingProtocol;
	/** Assigned by the authenticated transport, never read from a renderer-supplied packet. */
	readonly ctx: TContext;
	readonly onDidClientDisconnect: Event<void>;
}

/** Shared channel registrations survive individual renderer connections. */
export class IPCServer<TContext = string> extends Disposable implements IChannelServer<TContext> {
	private readonly channels = new Map<string, IServerChannel<TContext>>();
	private readonly clients = new Map<ClientConnectionEvent<TContext>, { peer: IPCClient<TContext>; resources: DisposableStore }>();
	private readonly connectionsChanged = this._register(new Emitter<void>());

	constructor(onDidClientConnect: Event<ClientConnectionEvent<TContext>>) {
		super();
		this._register(onDidClientConnect(connection => {
			const resources = new DisposableStore();
			const peer = resources.add(new IPCClient(connection.protocol, connection.ctx));
			for (const [name, channel] of this.channels) { peer.registerChannel(name, channel); }
			this.clients.set(connection, { peer, resources });
			resources.add(connection.onDidClientDisconnect(() => { this.clients.delete(connection); resources.dispose(); this.connectionsChanged.fire(); }));
			this.connectionsChanged.fire();
		}));
		this._register(toDisposable(() => {
			for (const { resources } of this.clients.values()) { resources.dispose(); }
			this.clients.clear(); this.channels.clear();
		}));
	}

	/** The authenticated context selects the renderer; each call resolves the current document. */
	public getChannel<T extends IChannel>(channelName: string, clientFilter: (client: Client<TContext>) => boolean): T {
		return {
			call: async <R>(command: string, arg?: unknown, cancellationToken?: CancellationToken): Promise<R> => {
				this.assertNotDisposed();
				const matches = [...this.clients].filter(([connection]) => clientFilter(connection));
				if (matches.length !== 1) {
					throw new Error(`Expected one IPC client for '${channelName}', found ${matches.length}`);
				}
				return matches[0]![1].peer.getChannel(channelName).call<R>(command, arg, cancellationToken);
			},
			listen: <R>(event: string, arg?: unknown): Event<R> => (listener, thisArgs, disposables) => {
				this.assertNotDisposed();
				const resources = new DisposableStore();
				const subscriptions = resources.add(new DisposableMap<ClientConnectionEvent<TContext>, IDisposable>());
				const update = (): void => {
					for (const connection of subscriptions.keys()) {
						if (!this.clients.has(connection) || !clientFilter(connection)) { subscriptions.deleteAndDispose(connection); }
					}
					for (const [connection, { peer }] of this.clients) {
						if (clientFilter(connection) && !subscriptions.has(connection)) {
							subscriptions.set(connection, peer.getChannel(channelName).listen<R>(event, arg)(value => listener.call(thisArgs, value)));
						}
					}
				};
				resources.add(this.connectionsChanged.event(update));
				update();
				if (Array.isArray(disposables)) { disposables.push(resources); }
				else { disposables?.add(resources); }
				return resources;
			},
		} as T;
	}

	public registerChannel(name: string, channel: IServerChannel<TContext>): void {
		this.assertNotDisposed();
		if (this.channels.has(name)) { throw new Error(`IPC channel '${name}' is already registered`); }
		this.channels.set(name, channel);
		for (const { peer } of this.clients.values()) { peer.registerChannel(name, channel); }
	}
}
