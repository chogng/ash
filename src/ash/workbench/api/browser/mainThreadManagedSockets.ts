import { VSBuffer } from '../../../base/common/buffer.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable, DisposableMap, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { SocketCloseEventType, type ISocket, type SocketCloseEvent, type SocketDiagnosticsEventType } from '../../../base/parts/ipc/common/ipc.net.js';
import { IExtensionHostApi, type ExtensionHostRuntime, type ExtensionHostInvocationRequest, type JsonValue } from '../../../platform/extensionHost/common/extensionHostApi.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IRemoteSocketFactoryService } from '../../../platform/remote/common/remoteSocketFactoryService.js';
import { RemoteConnectionType } from '../../../platform/remote/common/remoteAuthorityResolver.js';
import { isRecord } from '../../../base/common/types.js';

/** Binds a managed factory to its exact local extension generation, never a remote fleet. */
export class MainThreadManagedSockets extends Disposable {
	private readonly sockets = this._register(new DisposableMap<number, MainThreadManagedSocket>());

	constructor(runtime: ExtensionHostRuntime, registrationId: string, factoryId: number,
		@IExtensionHostApi api: IExtensionHostApi,
		@IRemoteSocketFactoryService factories: IRemoteSocketFactoryService,
		@IInstantiationService instantiation: IInstantiationService,
	) {
		super();
		if (runtime.incarnation === undefined) { throw new Error('Managed factory requires a running extension'); }
		const source = { extensionId: runtime.id, activationGeneration: runtime.activationGeneration, incarnation: runtime.incarnation, registrationId };
		this._register(factories.register(RemoteConnectionType.Managed, {
			supports: connection => connection.id === -factoryId,
			connect: async () => {
				const result = await api.invoke({ ...source, operation: 'remoteConnect', payload: { id: factoryId }, deadlineUnixMillis: Date.now() + 10_000 }, new AbortController().signal);
				if (!isRecord(result) || !Number.isSafeInteger(result.id) || (result.id as number) < 1) { throw new TypeError('Invalid managed connection lease'); }
				const socket = instantiation.createInstance(MainThreadManagedSocket, source, result.id as number);
				if (this.isDisposed) { socket.dispose(); throw new Error('Managed factory was retired'); }
				this.sockets.set(result.id as number, socket);
				socket.start();
				return socket;
			},
		}));
		this._register(toDisposable(() => {
			this.sockets.clearAndDisposeAll();
		}));
		const changes = api.onConnectionState(state => { if (state !== 'ready') { this.dispose(); } });
		this._register(toDisposable(() => changes.dispose()));
		const fleet = api.onDidChange(() => {
			void api.list().then(snapshot => {
				if (!snapshot.extensions.some(current => current.id === runtime.id && current.incarnation === runtime.incarnation && current.activationGeneration === runtime.activationGeneration && current.lifecycle === 'ready')) { this.dispose(); }
			}, () => this.dispose());
		});
		this._register(toDisposable(() => fleet.dispose()));
	}
}

type InvocationSource = Pick<ExtensionHostInvocationRequest, 'extensionId' | 'activationGeneration' | 'incarnation' | 'registrationId'>;

class MainThreadManagedSocket extends Disposable implements ISocket {
	private readonly data = this._register(new Emitter<VSBuffer>());
	private readonly closed = this._register(new Emitter<SocketCloseEvent>());
	private readonly ended = this._register(new Emitter<void>());
	private pending: Promise<unknown> = Promise.resolve();
	private queuedBytes = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private terminal = false;
	private endReceived = false;

	constructor(private readonly source: InvocationSource, private readonly id: number, @IExtensionHostApi private readonly api: IExtensionHostApi) {
		super();
		this._register(toDisposable(() => {
			if (this.timer !== undefined) { clearTimeout(this.timer); }
			// Short, nonblocking reads finish before release. Cancelling an invocation would retire the entire extension host.
			void this.pending.catch(() => undefined).then(() => this.invoke('remoteRelease', { id })).catch(() => undefined);
		}));
	}

	public start(): void { queueMicrotask(() => { if (!this.isDisposed) { void this.read(); } }); }
	public onData(listener: (data: VSBuffer) => void): IDisposable { return this.data.event(listener); }
	public onClose(listener: (event: SocketCloseEvent) => void): IDisposable { return this.closed.event(listener); }
	public onEnd(listener: () => void): IDisposable { return this.ended.event(listener); }
	public traceSocketEvent(_type: SocketDiagnosticsEventType, _data?: unknown): void { }

	public write(buffer: VSBuffer): void {
		this.assertNotDisposed();
		if (this.terminal || this.queuedBytes + buffer.byteLength > 1024 * 1024) { throw new Error('Managed socket write capacity exceeded'); }
		this.queuedBytes += buffer.byteLength;
		const bytes = buffer.buffer.slice();
		this.pending = this.pending.then(async () => {
			if (this.isDisposed) { return; }
			for (let offset = 0; offset < bytes.byteLength; offset += 32768) {
				const data = Array.from(bytes.subarray(offset, offset + 32768), byte => byte.toString(16).padStart(2, '0')).join('');
				await this.invoke('remoteWrite', { id: this.id, data });
			}
		}).finally(() => { this.queuedBytes -= bytes.byteLength; });
		void this.pending.catch(error => this.fail(error));
	}

	public async drain(): Promise<void> { this.assertNotDisposed(); await this.pending; await this.invoke('remoteDrain', { id: this.id }); }
	public end(): void {
		if (this.isDisposed || this.terminal) { return; }
		this.terminal = true;
		this.pending = this.pending.then(() => this.invoke('remoteEnd', { id: this.id }));
		void this.pending.then(() => this.dispose(), error => this.fail(error));
	}

	private invoke(operation: string, payload: JsonValue): Promise<JsonValue> {
		return this.api.invoke({ ...this.source, operation, payload, deadlineUnixMillis: Date.now() + 10_000 }, new AbortController().signal);
	}

	private async read(): Promise<void> {
		try {
			const request = this.pending.then(() => this.isDisposed ? null : this.invoke('remoteRead', { id: this.id }));
			this.pending = request;
			const result = await request;
			if (this.isDisposed) { return; }
			if (!isRecord(result) || typeof result.data !== 'string' || result.data.length > 65536 || result.data.length % 2 || !/^[0-9a-f]*$/.test(result.data) || typeof result.closed !== 'boolean' || typeof result.ended !== 'boolean' || result.error !== null && typeof result.error !== 'string') { throw new TypeError('Invalid managed socket read'); }
			const hex = result.data;
			if (hex) { this.data.fire(VSBuffer.wrap(Uint8Array.from({ length: hex.length / 2 }, (_, index) => parseInt(hex.slice(index * 2, index * 2 + 2), 16)))); }
			if (result.ended && !this.endReceived) { this.endReceived = true; this.ended.fire(); }
			if (result.closed) { this.fail(result.error ? new Error(result.error as string) : undefined); return; }
			if (!this.isDisposed) { this.timer = setTimeout(() => { this.timer = undefined; void this.read(); }, hex ? 0 : 20); }
		} catch (error) { this.fail(error); }
	}

	private fail(error: unknown): void {
		if (this.isDisposed) { return; }
		this.closed.fire({ type: SocketCloseEventType.NodeSocketCloseEvent, hadError: error !== undefined, error: error === undefined ? undefined : error instanceof Error ? error : new Error(String(error)) });
		this.dispose();
	}
}
