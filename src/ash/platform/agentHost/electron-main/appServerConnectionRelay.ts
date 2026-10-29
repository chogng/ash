import { appServerConnectionChannel, type AppServerConnectionTarget } from '../common/appServerTransport.js';
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
	private connectionOptions: { readonly enabled: false } | { readonly enabled: true; readonly processLauncher: IAppServerProcessLauncher };
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
	private acquisitionRevision = 0;
	private navigationGeneration = 0;
	private acquiredNavigation = -1;
	private startPromise: CancelablePromise<void> | undefined;

	constructor(
		options: { readonly enabled: false } | { readonly enabled: true; readonly processLauncher: IAppServerProcessLauncher },
		private readonly connection: AppServerConnectionTarget = 'workspace',
	) {
		super();
		this.connectionOptions = options;
		this._register(toDisposable(() => this.startPromise?.cancel()));
	}

	private get channelPrefix(): string {
		return appServerConnectionChannel(this.connection);
	}

	public get options(): { readonly enabled: false } | { readonly enabled: true; readonly processLauncher: IAppServerProcessLauncher } {
		return this.connectionOptions;
	}

	public replaceProcessLauncher(processLauncher: IAppServerProcessLauncher): void {
		if (!this.options.enabled || this.state !== 'stopped') throw new Error('App Server launcher can only change while stopped');
		this.connectionOptions = { enabled: true, processLauncher };
	}

	/** Concurrent restart callers share the same preparation and renderer handshake. */
	public start(): Promise<void> {
		this.assertNotDisposed();
		if (!this.options.enabled) {
			throw new Error('App Server is disabled');
		}
		if (this.startPromise) {
			return this.startPromise;
		}
		const operation = createCancelablePromise(token => this.startConnection(token));
		this.startPromise = operation;
		const settled = (): void => {
			if (this.startPromise === operation) {
				this.startPromise = undefined;
			}
		};
		void operation.then(settled, settled);
		return operation;
	}

	private async startConnection(token: CancellationToken): Promise<void> {
		using resources = new DisposableStore();
		if (!this.options.enabled) {
			throw new Error('App Server is disabled');
		}
		const navigationGeneration = this.navigationGeneration;
		const previousTransport = this.transport.value;
		// The profile reloader releases validation only after stopping its relays.
		// Waiting for that barrier inside the connection queue would block its stop.
		await this.options.processLauncher.validate();
		let ready: Promise<void> | undefined;
		await this.connectionOperations.schedule(async () => {
			this.assertNotDisposed();
			if (token.isCancellationRequested) {
				throw new CancellationError();
			}
			if (!this.options.enabled) {
				throw new Error('App Server is disabled');
			}
			if (previousTransport && this.transport.value === previousTransport) {
				await this.stopConnection();
			}
			// Validation and carrier shutdown can outlive the window that requested the restart.
			this.assertNotDisposed();
			if (token.isCancellationRequested) {
				throw new CancellationError();
			}
			// An acquisition or another start may already own the new connection generation.
			if (!this.transport.value) {
				this.transport.value = new ChildProcessJsonlTransport(this.options.processLauncher.launch(), {
					stdoutMode: 'bytes',
				});
				this.setState('starting');
			}
			if (this.state === 'ready') {
				return;
			}
			if (!this.renderer || this.renderer.isDestroyed()) {
				return;
			}
			const initializeTimeoutMs = this.options.processLauncher.initializeTimeoutMs ?? 15_000;
			ready = new Promise<void>((resolve, reject) => {
				resources.add(disposableTimeout(() => reject(new Error('Renderer initialization timed out')), initializeTimeoutMs));
				resources.add(token.onCancellationRequested(() => reject(new CancellationError())));
				resources.add(
					this.onStateChange(state => {
						if (state !== 'ready' && state !== 'crashed') {
							return;
						}
						if (state === 'ready') {
							resolve();
						} else {
							reject(new Error(this.diagnostics()));
						}
					}),
				);
			});
			// A new document already acquires its own port. Restarting its initial client
			// would interrupt that initialization; only wake the document we stopped.
			if (this.nonce === undefined && this.acquiredNavigation === navigationGeneration && this.navigationGeneration === navigationGeneration && this.pendingAcquisitions === 0) {
				this.renderer.send(`${this.channelPrefix}:restart`);
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

	public diagnostics(): string {
		return this.transport.value?.diagnostics() ?? this.diagnostic;
	}

	public routes(renderer: WebContents, metadata: () => { workspaceId: string; workspaceRoot: string }): readonly IpcRoute<unknown, unknown>[] {
		this.renderer = renderer;
		const processLauncher = (): IAppServerProcessLauncher | undefined => (this.options.enabled ? this.options.processLauncher : undefined);
		const reset = (): void => {
			if (!this.isDisposed) {
				void this.stop();
			}
		};
		renderer.on('render-process-gone', reset);
		// Initial navigation must keep the connection started before the window loaded.
		// did-navigate commits a main-frame document; blocked attempts retain its connection.
		let documentUrl: string | undefined;
		const navigating = (_event: unknown, url: string): void => {
			// A document-level owner can retire this relay earlier in the same event dispatch.
			if (this.isDisposed) {
				return;
			}
			const previousUrl = documentUrl;
			documentUrl = url;
			this.navigationGeneration++;
			if (this.nonce !== undefined) {
				reset();
			}
			// The old document can close its port before did-navigate is delivered.
			// Prepare its successor even then, sharing an in-flight restart that may
			// still be closing the old carrier. Validation overlaps Renderer loading;
			// a new nonce and initialize exchange still own the new document.
			if (previousUrl === url && this.options.enabled) {
				void this.start().catch(error => {
					if (!this.isDisposed && !(error instanceof CancellationError)) this.diagnostic = String(error);
				});
			}
		};
		renderer.on('did-navigate', navigating);
		this._register(toDisposable(() => renderer.removeListener('render-process-gone', reset)));
		this._register(toDisposable(() => renderer.removeListener('did-navigate', navigating)));
		return [
			{
				channel: `${this.channelPrefix}:acquire`,
				validate: value => {
					if (!isRecord(value) || typeof value.nonce !== 'string' || !/^[\da-f-]{36}$/.test(value.nonce)) {
						throw new Error('Invalid connection nonce');
					}
					return value.nonce;
				},
				invoke: async nonce => {
					this.trace('acquire', nonce as string);
					const navigationGeneration = this.navigationGeneration;
					const acquisitionRevision = ++this.acquisitionRevision;
					this.pendingAcquisitions++;
					try {
						this.assertNotDisposed();
						const launcher = processLauncher();
						if (!launcher) {
							return { enabled: false };
						}
						await launcher.validate();
						this.trace('validated', nonce as string);
						return await this.connectionOperations.schedule(async () => {
							this.assertNotDisposed();
							// Validation can outlive a document or a Renderer acquisition timeout.
							// Only the latest request may attach a port or stop its predecessor.
							if (this.acquisitionRevision !== acquisitionRevision || this.navigationGeneration !== navigationGeneration || processLauncher() !== launcher) {
								throw new CancellationError();
							}
							if (this.nonce !== undefined) {
								await this.stopConnection();
							}
							this.assertNotDisposed();
							if (this.acquisitionRevision !== acquisitionRevision || this.navigationGeneration !== navigationGeneration || processLauncher() !== launcher) {
								throw new CancellationError();
							}
							let transport = this.transport.value;
							if (!transport) {
								this.trace('launch', nonce as string);
								transport = new ChildProcessJsonlTransport(launcher.launch(), { stdoutMode: 'bytes' });
								this.transport.value = transport;
							}
							this.trace('carrier-ready', nonce as string);
							this.attach(renderer, nonce as string, transport);
							return { enabled: true, protocolVersion: 1, byteStream: true, ...metadata() };
						});
					} finally {
						this.pendingAcquisitions--;
					}
				},
			},
			{
				channel: `${this.channelPrefix}:recover-runtime`,
				validate: value => {
					if (!isRecord(value)) {
						throw new Error('Invalid runtime incompatibility');
					}
					const number = (key: string): number => {
						const result = value[key];
						if (typeof result !== 'number' || !Number.isSafeInteger(result) || result < 0) {
							throw new Error('Invalid runtime version');
						}
						return result;
					};
					if (value.kind === 'majorVersion') {
						return new AppServerProtocolIncompatibleError({
							kind: value.kind,
							expected: number('expected'),
							received: number('received'),
						});
					}
					if (
						value.kind === 'schemaHash' &&
						typeof value.expected === 'string' &&
						/^sha256:[a-f0-9]{64}$/.test(value.expected) &&
						typeof value.received === 'string' &&
						/^sha256:[a-f0-9]{64}$/.test(value.received)
					) {
						return new AppServerProtocolIncompatibleError({
							kind: value.kind,
							expected: value.expected,
							received: value.received,
						});
					}
					if (value.kind === 'missingCapability' && typeof value.name === 'string' && value.name.length < 128) {
						return new AppServerProtocolIncompatibleError({ kind: value.kind, name: value.name });
					}
					throw new Error('Invalid runtime incompatibility');
				},
				invoke: value => processLauncher()?.recoverInitializationFailure?.(value) ?? false,
			},
			{
				channel: `${this.channelPrefix}:initialized`,
				validate: value => value,
				invoke: value =>
					this.connectionOperations.schedule(async () => {
						this.assertNotDisposed();
						if (!isRecord(value) || value.nonce !== this.nonce || this.nonce === undefined) {
							throw new Error('Connection initialization superseded');
						}
						const transport = this.transport.value;
						await processLauncher()?.didInitialize?.();
						this.assertNotDisposed();
						if (value.nonce !== this.nonce || this.transport.value !== transport) {
							throw new CancellationError();
						}
						this.setState('ready');
						this.trace('initialized', value.nonce as string);
					}),
			},
		];
	}

	private attach(renderer: WebContents, nonce: string, transport: ChildProcessJsonlTransport): void {
		this.nonce = nonce;
		this.acquiredNavigation = this.navigationGeneration;
		const { port1, port2 } = new MessageChannelMain();
		this.setState('initializing');
		const sent: number[] = [];
		let bytes = 0;
		let writes = 0;
		let writeBytes = 0;
		let closed = false;
		let intentionalClose = false;
		const close = (): void => {
			if (closed) {
				return;
			}
			closed = true;
			data.dispose();
			ended.dispose();
			const intentional = intentionalClose || this.state === 'stopping' || this.isDisposed;
			// Delayed port/process events own only this attachment, never its replacement.
			if (this.transport.value === transport && this.nonce === nonce) {
				this.transport.clearAndLeak();
				this.nonce = undefined;
				this.diagnostic = transport.diagnostics();
				if (intentionalClose) {
					this.generation++;
					this.setState('stopped');
				} else if (!intentional) {
					this.generation++;
					this.setState('crashed');
				}
			}
			port1.postMessage({ closed: 'App Server connection closed', intentional });
			port1.close();
			transport.dispose();
		};
		let firstRead = true;
		let firstWrite = true;
		const data = transport.onData(chunk => {
			if (firstRead) {
				firstRead = false;
				this.trace('first-read', nonce);
			}
			const size = chunk.byteLength;
			if (sent.length >= 128 || bytes + size > DEFAULT_MAX_JSONL_FRAME_BYTES) {
				close();
				return;
			}
			sent.push(size);
			bytes += size;
			port1.postMessage({ data: new Uint8Array(chunk) });
			if (sent.length >= 4) {
				transport.process.stdout.pause();
			}
		});
		const ended = transport.onClose(error => {
			if (closed) {
				return;
			}
			port1.postMessage({ closed: transport.diagnostics() || error.message });
			close();
		});
		port1.on('message', event => {
			if (closed) {
				return;
			}
			const value: unknown = event.data;
			if (!isRecord(value)) {
				close();
				return;
			}
			if (value.intentional === true) {
				intentionalClose = true;
				close();
				return;
			}
			if (value.ack === true) {
				const size = sent.shift();
				if (size === undefined) {
					close();
					return;
				}
				bytes -= size;
				if (sent.length < 4) {
					transport.process.stdout.resume();
				}
				return;
			}
			if (!(value.data instanceof Uint8Array) || writes >= 128) {
				close();
				return;
			}
			const size = value.data.byteLength;
			if (writeBytes + size > DEFAULT_MAX_JSONL_FRAME_BYTES) {
				close();
				return;
			}
			if (firstWrite) {
				firstWrite = false;
				this.trace('first-write', nonce);
			}
			writeBytes += size;
			writes++;
			void transport
				.sendBytes(value.data)
				.then(() => {
					if (!closed) {
						port1.postMessage({ ack: true });
					}
				}, close)
				.finally(() => {
					writes--;
					writeBytes -= size;
				});
		});
		port1.on('close', close);
		port1.start();
		this.portResources.value = toDisposable(close);
		renderer.postMessage(`${this.channelPrefix}:port`, { nonce }, [port2]);
		this.trace('port-attached', nonce);
	}

	/** Opt-in marks correlate one port lease without retaining protocol payloads. */
	private trace(phase: string, nonce: string): void {
		if (process.env.ASH_DESKTOP_STARTUP_TRACE === '1') {
			performance.mark(`ash.appServer.main.${phase}`, {
				detail: {
					nonce,
					connection: this.connection,
					carrierPid: this.transport.value?.process.pid,
					...(phase === 'initialized'
						? {
								carrierTrace:
									this.transport.value
										?.diagnostics()
										.split('\n')
										.filter(line => line.startsWith('ASH_STARTUP_TRACE ')) ?? [],
							}
						: {}),
				},
			});
		}
	}

	private setState(state: AppServerConnectionState): void {
		if (this.state !== state) {
			this.state = state;
			this.changes.fire(state);
		}
	}
}
