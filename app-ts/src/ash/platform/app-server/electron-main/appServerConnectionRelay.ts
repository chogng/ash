import { AppServerProtocolIncompatibleError } from '../common/appServerProtocolCompatibility.js';
import { MessageChannelMain } from 'electron/main';
import type { WebContents } from 'electron/main';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import { Emitter } from '../../../base/common/event.js';
import { createCancelablePromise, disposableTimeout, TaskQueue, type CancelablePromise } from '../../../base/common/async.js';
import type { CancellationToken } from '../../../base/common/cancellation.js';
import { CancellationError } from '../../../base/common/errors.js';
import { isRecord } from '../../../base/common/types.js';
import type { IpcRoute } from '../../ipc/electron-main/trustedIpcRouter.js';
import type { AppServerConnectionState } from '../common/appServerApi.js';
import type { IAppServerProcessLauncher } from './appServerProcessLauncher.js';
import { ChildProcessJsonlTransport, DEFAULT_MAX_JSONL_FRAME_BYTES } from '../node/childProcessJsonlTransport.js';

/** Owns one renderer's connection carrier; the carrier connects to the shared profile daemon. */
export class AppServerConnectionRelay extends Disposable {
	private connectionOptions: { readonly enabled: false; } | { readonly enabled: true; readonly processLauncher: IAppServerProcessLauncher; };
	private readonly transport = this._register(new MutableDisposable<ChildProcessJsonlTransport>());
	private readonly portResources = this._register(new MutableDisposable<IDisposable>());
	private readonly changes = this._register(new Emitter<AppServerConnectionState>());
	public readonly onStateChange = this.changes.event;
	public state: AppServerConnectionState = 'stopped';
	public generation = 0;
	private renderer: WebContents | undefined;
	private diagnostic = '';
	private nonce: string | undefined;
	private readonly connectionOperations = new TaskQueue();
	private pendingAcquisitions = 0;
	private navigationGeneration = 0;
	private startPromise: CancelablePromise<void> | undefined;

	constructor(options: { readonly enabled: false; } | { readonly enabled: true; readonly processLauncher: IAppServerProcessLauncher; }) {
		super();
		this.connectionOptions = options;
		this._register(toDisposable(() => this.startPromise?.cancel()));
	}

	public get options(): { readonly enabled: false; } | { readonly enabled: true; readonly processLauncher: IAppServerProcessLauncher; } { return this.connectionOptions; }

	public replaceProcessLauncher(processLauncher: IAppServerProcessLauncher): void {
		if (!this.options.enabled || this.state !== 'stopped') throw new Error('App Server launcher can only change while stopped');
		this.connectionOptions = { enabled: true, processLauncher };
	}

	/** Concurrent restart callers share the same preparation and renderer handshake. */
	public start(): Promise<void> {
		this.assertNotDisposed();
		if (!this.options.enabled) { throw new Error('App Server is disabled'); }
		if (this.startPromise) { return this.startPromise; }
		const operation = createCancelablePromise(token => this.startConnection(token));
		this.startPromise = operation;
		const settled = (): void => { if (this.startPromise === operation) { this.startPromise = undefined; } };
		void operation.then(settled, settled);
		return operation;
	}

	private async startConnection(token: CancellationToken): Promise<void> {
		using resources = new DisposableStore();
		if (!this.options.enabled) { throw new Error('App Server is disabled'); }
		const navigationGeneration = this.navigationGeneration;
		const previousTransport = this.transport.value;
		// The profile reloader releases validation only after stopping its relays.
		// Waiting for that barrier inside the connection queue would block its stop.
		await this.options.processLauncher.validate();
		let ready: Promise<void> | undefined;
		await this.connectionOperations.schedule(async () => {
			this.assertNotDisposed();
			if (token.isCancellationRequested) { throw new CancellationError(); }
			if (!this.options.enabled) { throw new Error('App Server is disabled'); }
			if (previousTransport && this.transport.value === previousTransport) { await this.stopConnection(); }
			// Validation and carrier shutdown can outlive the window that requested the restart.
			this.assertNotDisposed();
			if (token.isCancellationRequested) { throw new CancellationError(); }
			// An acquisition or another start may already own the new connection generation.
			if (!this.transport.value) {
				this.transport.value = new ChildProcessJsonlTransport(this.options.processLauncher.launch());
				this.setState('starting');
			}
			if (this.state === 'ready') { return; }
			if (!this.renderer || this.renderer.isDestroyed()) { return; }
			ready = new Promise<void>((resolve, reject) => {
				resources.add(disposableTimeout(() => reject(new Error('Renderer initialization timed out')), 15_000));
				resources.add(token.onCancellationRequested(() => reject(new CancellationError())));
				resources.add(this.onStateChange(state => {
					if (state !== 'ready' && state !== 'crashed') { return; }
					if (state === 'ready') { resolve(); } else { reject(new Error(this.diagnostics())); }
				}));
			});
			// A new document already acquires its own port. Restarting its initial client
			// would interrupt that initialization; only wake the document we stopped.
			if (this.nonce === undefined && this.navigationGeneration === navigationGeneration && this.pendingAcquisitions === 0) {
				this.renderer.send('ash:app-server:restart');
			}
		});
		// Port acquisition must enter the same queue while we await renderer initialization.
		await ready;
	}

	public stop(): Promise<void> {
		// Stop ends this restart's lifetime, including validation that has not returned yet.
		this.startPromise?.cancel();
		this.startPromise = undefined;
		return this.connectionOperations.schedule(() => this.stopConnection());
	}

	private async stopConnection(): Promise<void> {
		this.setState('stopping');
		const transport = this.transport.value;
		this.generation++;
		this.portResources.clear();
		this.transport.clear();
		await transport?.close();
		this.setState('stopped');
	}

	public diagnostics(): string { return this.transport.value?.diagnostics() ?? this.diagnostic; }

	public routes(renderer: WebContents, metadata: () => { workspaceId: string; workspaceRoot: string; }): readonly IpcRoute<unknown, unknown>[] {
		this.renderer = renderer;
		const processLauncher = (): IAppServerProcessLauncher | undefined => this.options.enabled ? this.options.processLauncher : undefined;
		const reset = (): void => { void this.stop(); };
		renderer.on('render-process-gone', reset);
		// Initial navigation must keep the connection started before the window loaded.
		const navigating = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean): void => {
			if (!mainFrame || inPlace) { return; }
			this.navigationGeneration++;
			if (this.nonce !== undefined) { reset(); }
		};
		renderer.on('did-start-navigation', navigating);
		this._register(toDisposable(() => renderer.removeListener('render-process-gone', reset)));
		this._register(toDisposable(() => renderer.removeListener('did-start-navigation', navigating)));
		return [{
			channel: 'ash:app-server:acquire',
			validate: value => {
				if (!isRecord(value) || typeof value.nonce !== 'string' || !/^[\da-f-]{36}$/.test(value.nonce)) { throw new Error('Invalid connection nonce'); }
				return value.nonce;
			},
			invoke: async nonce => {
				const navigationGeneration = this.navigationGeneration;
				this.pendingAcquisitions++;
				try {
					this.assertNotDisposed();
					const launcher = processLauncher();
					if (!launcher) { return { enabled: false }; }
					await launcher.validate();
					return await this.connectionOperations.schedule(async () => {
						this.assertNotDisposed();
						// A delayed request from a replaced document must not detach its successor.
						if (this.navigationGeneration !== navigationGeneration || processLauncher() !== launcher) { throw new CancellationError(); }
						if (this.nonce !== undefined) { await this.stopConnection(); }
						this.assertNotDisposed();
						if (this.navigationGeneration !== navigationGeneration || processLauncher() !== launcher) { throw new CancellationError(); }
						let transport = this.transport.value;
						if (!transport) {
							transport = new ChildProcessJsonlTransport(launcher.launch());
							this.transport.value = transport;
						}
						this.attach(renderer, nonce as string, transport);
						return { enabled: true, protocolVersion: 1, ...metadata() };
					});
				} finally {
					this.pendingAcquisitions--;
				}
			},
		}, {
			channel: 'ash:app-server:recover-runtime', validate: value => {
				if (!isRecord(value)) { throw new Error('Invalid runtime incompatibility'); }
				const number = (key: string): number => { const result = value[key]; if (typeof result !== 'number' || !Number.isSafeInteger(result) || result < 0) { throw new Error('Invalid runtime version'); } return result; };
				if (value.kind === 'majorVersion') { return new AppServerProtocolIncompatibleError({ kind: value.kind, expected: number('expected'), received: number('received') }); }
				if ((value.kind === 'missingCapability' || value.kind === 'capabilityVersion') && typeof value.name === 'string' && value.name.length < 128) {
					const common = { name: value.name, minVersion: number('minVersion'), maxVersion: number('maxVersion') };
					return new AppServerProtocolIncompatibleError(value.kind === 'missingCapability' ? { kind: value.kind, ...common } : { kind: value.kind, ...common, received: number('received') });
				}
				throw new Error('Invalid runtime incompatibility');
			}, invoke: value => processLauncher()?.recoverInitializationFailure?.(value) ?? false,
		}, {
			channel: 'ash:app-server:initialized', validate: value => value,
			invoke: value => this.connectionOperations.schedule(async () => {
				this.assertNotDisposed();
				if (!isRecord(value) || value.nonce !== this.nonce || this.nonce === undefined) { throw new Error('Connection initialization superseded'); }
				const transport = this.transport.value;
				await processLauncher()?.didInitialize?.();
				this.assertNotDisposed();
				if (value.nonce !== this.nonce || this.transport.value !== transport) { throw new CancellationError(); }
				this.setState('ready');
			}),
		}];
	}

	private attach(renderer: WebContents, nonce: string, transport: ChildProcessJsonlTransport): void {
		this.nonce = nonce;
		const { port1, port2 } = new MessageChannelMain();
		this.setState('initializing');
		const sent: number[] = [];
		let bytes = 0;
		let writes = 0;
		let writeBytes = 0;
		let closed = false;
		const close = (): void => {
			if (closed) { return; }
			closed = true;
			frames.dispose();
			ended.dispose();
			const intentional = this.state === 'stopping' || this.isDisposed;
			// Delayed port/process events own only this attachment, never its replacement.
			if (this.transport.value === transport && this.nonce === nonce) {
				this.transport.clearAndLeak();
				this.nonce = undefined;
				this.diagnostic = transport.diagnostics();
				if (!intentional) {
					this.generation++;
					this.setState('crashed');
				}
			}
			port1.postMessage({ closed: 'App Server connection closed', intentional });
			port1.close();
			transport.dispose();
		};
		const frames = transport.onFrame(frame => {
			const size = Buffer.byteLength(frame);
			if (sent.length >= 128 || bytes + size > DEFAULT_MAX_JSONL_FRAME_BYTES) { close(); return; }
			sent.push(size);
			bytes += size;
			port1.postMessage({ frame });
			if (sent.length >= 4) { transport.process.stdout.pause(); }
		});
		const ended = transport.onClose(error => {
			if (closed) { return; }
			port1.postMessage({ closed: [error.message, transport.diagnostics()].filter(Boolean).join('\n') });
			close();
		});
		port1.on('message', event => {
			if (closed) { return; }
			const value: unknown = event.data;
			if (!isRecord(value)) { close(); return; }
			if (value.ack === true) {
				const size = sent.shift();
				if (size === undefined) { close(); return; }
				bytes -= size;
				if (sent.length < 4) { transport.process.stdout.resume(); }
				return;
			}
			if (typeof value.frame !== 'string' || writes >= 128) { close(); return; }
			const size = Buffer.byteLength(value.frame);
			if (writeBytes + size > DEFAULT_MAX_JSONL_FRAME_BYTES) { close(); return; }
			writeBytes += size;
			writes++;
			void transport.send(value.frame).then(() => { if (!closed) { port1.postMessage({ ack: true }); } }, close).finally(() => { writes--; writeBytes -= size; });
		});
		port1.on('close', close);
		port1.start();
		this.portResources.value = toDisposable(close);
		renderer.postMessage('ash:app-server:port', { nonce }, [port2]);
	}

	private setState(state: AppServerConnectionState): void {
		if (this.state !== state) { this.state = state; this.changes.fire(state); }
	}
}
