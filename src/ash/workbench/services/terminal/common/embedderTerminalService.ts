import { Emitter, type Event } from '../../../../base/common/event.js';
import { Disposable, dispose, toDisposable } from '../../../../base/common/lifecycle.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { ProcessPropertyType, type IProcessProperty, type IProcessReadyEvent, type IShellLaunchConfig, type ITerminalChildProcess } from '../../../../platform/terminal/common/terminal.js';

export const IEmbedderTerminalService = createServiceIdentifier<IEmbedderTerminalService>('embedderTerminalService');

export interface IEmbedderTerminalService {
	/** Requests always carry customPtyImplementation, including buffered startup requests. */
	readonly onDidCreateTerminal: Event<IShellLaunchConfig>;
	createTerminal(options: IEmbedderTerminalOptions): void;
}

export type EmbedderTerminal = IShellLaunchConfig & Required<Pick<IShellLaunchConfig, 'customPtyImplementation'>>;

export interface IEmbedderTerminalOptions {
	readonly name: string;
	readonly pty: IEmbedderTerminalPty;
}

/** Host-owned output PTY; opening begins output, closing releases the host's resources. */
export interface IEmbedderTerminalPty {
	readonly onDidWrite: Event<string>;
	readonly onDidClose?: Event<void | number>;
	readonly onDidChangeName?: Event<string>;
	open(): void;
	close(): void;
}

class EmbedderTerminalService extends Disposable implements IEmbedderTerminalService {
	private readonly pending: IEmbedderTerminalOptions[] = [];
	private readonly created = this._register(new Emitter<IShellLaunchConfig>({
		onDidAddFirstListener: () => queueMicrotask(() => {
			if (this.isDisposed || !this.created.hasListeners()) {
				return;
			}
			while (!this.isDisposed && this.created.hasListeners() && this.pending.length > 0) {
				this.publish(this.pending.shift()!);
			}
		}),
	}));
	public readonly onDidCreateTerminal = this.created.event;

	public createTerminal(options: IEmbedderTerminalOptions): void {
		this.assertNotDisposed();
		if (typeof options.name !== 'string' || typeof options.pty?.onDidWrite !== 'function' || typeof options.pty.open !== 'function' || typeof options.pty.close !== 'function') {
			throw new TypeError('Embedder terminal requires a name and an output PTY');
		}
		if ((options.pty.onDidClose !== undefined && typeof options.pty.onDidClose !== 'function') || (options.pty.onDidChangeName !== undefined && typeof options.pty.onDidChangeName !== 'function')) {
			throw new TypeError('Embedder terminal lifecycle events must be functions');
		}
		// Retain startup requests until the contribution owns an output subscriber.
		if (!this.created.hasListeners() || this.pending.length > 0) {
			this.pending.push(options);
			return;
		}
		this.publish(options);
	}

	private publish(options: IEmbedderTerminalOptions): void {
		this.created.fire({
			name: options.name,
			isFeatureTerminal: true,
			customPtyImplementation: terminalId => new EmbedderTerminalProcess(terminalId, options.pty),
		});
	}

	protected override disposeCore(): void {
		try {
			dispose(this.pending.splice(0).map(options => toDisposable(() => options.pty.close())));
		} finally {
			super.disposeCore();
		}
	}
}

class EmbedderTerminalProcess extends Disposable implements ITerminalChildProcess {
	private readonly data = this._register(new Emitter<string>());
	private readonly ready = this._register(new Emitter<IProcessReadyEvent>());
	private readonly property = this._register(new Emitter<IProcessProperty>());
	private readonly exit = this._register(new Emitter<number | undefined>());
	private opened = false;
	private closed = false;
	public readonly shouldPersist = false;
	public readonly onProcessData = this.data.event;
	public readonly onProcessReady = this.ready.event;
	public readonly onDidChangeProperty = this.property.event;
	public readonly onProcessExit = this.exit.event;

	constructor(public readonly id: number, private readonly pty: IEmbedderTerminalPty) {
		super();
		this._register(pty.onDidWrite(data => {
			if (this.opened && !this.closed) {
				this.data.fire(data);
			}
		}));
		if (pty.onDidChangeName) {
			this._register(pty.onDidChangeName(name => {
				if (!this.closed) {
					this.property.fire({ type: ProcessPropertyType.Title, value: name });
				}
			}));
		}
		if (pty.onDidClose) {
			this._register(pty.onDidClose(code => {
				if (this.closed) {
					return;
				}
				this.closed = true;
				this.exit.fire(typeof code === 'number' ? code : undefined);
				this.dispose();
			}));
		}
	}

	public async start(): Promise<void> {
		this.assertNotDisposed();
		if (this.opened) {
			return;
		}
		this.opened = true;
		// A host PTY has no OS child identity; readiness precedes synchronous open output.
		this.ready.fire({ pid: -1, cwd: '' });
		this.pty.open();
	}

	public shutdown(_immediate: boolean): void {
		this.dispose();
	}

	protected override disposeCore(): void {
		try {
			if (!this.closed) {
				this.closed = true;
				this.pty.close();
			}
		} finally {
			super.disposeCore();
		}
	}
}

registerSingleton(IEmbedderTerminalService, EmbedderTerminalService, InstantiationType.Delayed);
