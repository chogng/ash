import { AppServerProtocolIncompatibleError } from '../common/appServerProtocolCompatibility.js';
import { MessageChannelMain } from 'electron/main';
import type { WebContents } from 'electron/main';
import { Disposable, MutableDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import { Emitter } from '../../../base/common/event.js';
import { isRecord } from '../../../base/common/types.js';
import type { IpcRoute } from '../../ipc/electron-main/trustedIpcRouter.js';
import type { AppServerConnectionState } from '../common/appServerApi.js';
import type { IAppServerProcessLauncher } from './appServerProcessLauncher.js';
import { ChildProcessJsonlTransport, DEFAULT_MAX_JSONL_FRAME_BYTES } from '../node/childProcessJsonlTransport.js';

/** Owns one renderer's connection carrier; the carrier connects to the shared profile daemon. */
export class AppServerConnectionRelay extends Disposable {
	private readonly transport = this._register(new MutableDisposable<ChildProcessJsonlTransport>());
	private readonly portResources = this._register(new MutableDisposable<IDisposable>());
	private readonly changes = this._register(new Emitter<AppServerConnectionState>());
	public readonly onStateChange = this.changes.event;
	public state: AppServerConnectionState = 'stopped';
	public generation = 0;
	private renderer: WebContents | undefined;
	private diagnostic = '';
	private nonce: string | undefined;

	constructor(public readonly options: { readonly enabled: false } | { readonly enabled: true; readonly processLauncher: IAppServerProcessLauncher }) { super(); }

	public async start(): Promise<void> {
		this.assertNotDisposed();
		if (!this.options.enabled) { throw new Error('App Server is disabled'); }
		await this.options.processLauncher.validate();
		this.setState('starting');
		if (this.renderer && !this.renderer.isDestroyed()) {
			const ready = new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => { listener.dispose(); reject(new Error('Renderer initialization timed out')); }, 15_000);
				const listener = this.onStateChange(state => {
					if (state !== 'ready' && state !== 'crashed') { return; }
					clearTimeout(timer);
					listener.dispose();
					if (state === 'ready') { resolve(); } else { reject(new Error(this.diagnostics())); }
				});
			});
			this.renderer.send('ash:app-server:restart');
			await ready;
		}
	}

	public async stop(): Promise<void> {
		this.setState('stopping');
		const transport = this.transport.value;
		this.generation++;
		this.portResources.clear();
		this.transport.clear();
		await transport?.close();
		this.setState('stopped');
	}

	public diagnostics(): string { return this.transport.value?.diagnostics() ?? this.diagnostic; }

	public routes(renderer: WebContents, metadata: () => { workspaceId: string; workspaceRoot: string }): readonly IpcRoute<unknown, unknown>[] {
		this.renderer = renderer;
		const processLauncher = this.options.enabled ? this.options.processLauncher : undefined;
		const reset = (): void => { void this.stop(); };
		renderer.on('render-process-gone', reset);
		const navigating = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean): void => { if (mainFrame && !inPlace) { reset(); } };
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
				if (!processLauncher) { return { enabled: false }; }
				await processLauncher.validate();
				await this.stop();
				this.attach(renderer, nonce as string, processLauncher);
				return { enabled: true, protocolVersion: 1, ...metadata() };
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
			}, invoke: value => processLauncher?.recoverInitializationFailure?.(value) ?? false,
		}, {
			channel: 'ash:app-server:initialized', validate: value => value,
			invoke: async value => {
				if (!isRecord(value) || value.nonce !== this.nonce || this.nonce === undefined) { throw new Error('Connection initialization superseded'); }
				await processLauncher?.didInitialize?.();
				this.setState('ready');
			},
		}];
	}

	private attach(renderer: WebContents, nonce: string, processLauncher: IAppServerProcessLauncher): void {
		this.nonce = nonce;
		const { port1, port2 } = new MessageChannelMain();
		const transport = new ChildProcessJsonlTransport(processLauncher.launch());
		this.transport.value = transport;
		this.setState('initializing');
		const sent: number[] = [];
		let bytes = 0;
		let writes = 0;
		let writeBytes = 0;
		let closed = false;
		const close = (): void => {
			if (closed) { return; }
			closed = true;
			this.nonce = undefined;
			this.diagnostic = transport.diagnostics();
			frames.dispose();
			ended.dispose();
			const intentional = this.state === 'stopping' || this.isDisposed;
			if (!intentional) { this.setState('crashed'); }
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
			this.setState('crashed');
			close();
		});
		port1.on('message', event => {
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
