import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationError, isCancellationError } from '../../../../base/common/errors.js';
import { DeferredPromise, raceCancellationError, timeout } from '../../../../base/common/async.js';
import { CancellationTokenSource, cancelOnDispose, type CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ITerminalProcessService, type IProcessDataEvent, type ITerminalProcessCloseOptions, type ITerminalProcessCommandStatusEvent } from '../../../../platform/terminal/common/terminal.js';
import type { ITerminalCommandStatusEvent } from './terminal.js';

const INPUT_BATCH_DELAY_MILLIS = 8;
const INPUT_BATCH_CHARACTERS = 16_384;
const MAX_INPUT_BATCH_BYTES = 60 * 1024;

const MAX_READ_CHUNKS = 128;
const POLL_DELAY_MILLIS = 35;

/** One Shell's input, dimensions and output stream; the instance owns creation and shutdown. */
export class TerminalProcessManager extends Disposable {
	private readonly reading = this._register(new MutableDisposable<DisposableStore>());
	private readonly inputCancellation = this._register(new MutableDisposable<CancellationTokenSource>());
	private readonly processDataEmitter = this._register(new Emitter<IProcessDataEvent>());
	private readonly commandStatusEmitter = this._register(new Emitter<ITerminalCommandStatusEvent>());
	private readonly processExitEmitter = this._register(new Emitter<number | undefined>());
	private readonly ptyReconnectEmitter = this._register(new Emitter<void>());
	private readonly outputGapEmitter = this._register(new Emitter<void>());
	private readonly pendingCommandEvents: ITerminalProcessCommandStatusEvent[] = [];
	private readonly processErrorEmitter = this._register(new Emitter<unknown>());
	// Constructed only after the backend has acknowledged process readiness.
	private acceptingInput = true;
	private inputGeneration = 0;
	private pendingInput = '';
	private readonly pendingInputCompletions: DeferredPromise<void>[] = [];
	private inputTimer: ReturnType<typeof setTimeout> | undefined;
	private writeChain = Promise.resolve();
	private pendingDimensions: { readonly rows: number; readonly cols: number; } | undefined;
	private readonly pendingResizeCompletions: DeferredPromise<void>[] = [];
	private resizeScheduled = false;
	private nextSequence = 0;
	private nextCommandSequence = 0;
	private pendingCommit: Promise<void> | undefined;

	public readonly onProcessError = this.processErrorEmitter.event;
	public readonly onProcessData = this.processDataEmitter.event;
	public readonly onDidChangeCommandStatus = this.commandStatusEmitter.event;
	public readonly onProcessExit = this.processExitEmitter.event;
	public readonly onPtyReconnect = this.ptyReconnectEmitter.event;
	public readonly onOutputGap = this.outputGapEmitter.event;

	constructor(private readonly identity: ITerminalProcessCloseOptions, @ITerminalProcessService private readonly processService: ITerminalProcessService) {
		super();
		this.inputCancellation.value = new CancellationTokenSource();
	}

	public async start(reconnecting = false): Promise<void> {
		this.assertNotDisposed();
		if (!this.acceptingInput) {
			this.inputCancellation.value = new CancellationTokenSource();
		}
		this.acceptingInput = true;
		const lifetime = new DisposableStore();
		this.reading.value = lifetime;
		const token = cancelOnDispose(lifetime);
		try {
			// A queued screen write survives a transport interruption. Await it before
			// resuming, without replaying bytes already handed to that same screen.
			await this.waitForCommit(token);
			this.emitCommandEventsThrough(this.nextSequence, token);
			while (!token.isCancellationRequested) {
				const result = await raceCancellationError(this.processService.read({
					...this.identity,
					afterSequence: this.nextSequence,
					afterCommandSequence: this.nextCommandSequence,
					maxChunks: MAX_READ_CHUNKS,
				}), token);
				if (token.isCancellationRequested) {
					return;
				}
				if (reconnecting) {
					reconnecting = false;
					this.ptyReconnectEmitter.fire();
				}
				if (token.isCancellationRequested) {
					return;
				}
				if (result.outputGap) {
					this.outputGapEmitter.fire();
				}
				this.pendingCommandEvents.push(...result.commandEvents);
				this.nextCommandSequence = result.nextCommandSequence;
				this.emitCommandEventsThrough(this.nextSequence, token);
				for (const chunk of result.chunks) {
					if (token.isCancellationRequested) {
						return;
					}
					this.emitCommandEventsThrough(chunk.sequence - 1, token);
					const event: IProcessDataEvent = { data: chunk.data, trackCommit: true };
					this.processDataEmitter.fire(event);
					this.nextSequence = chunk.sequence;
					this.pendingCommit = event.writePromise;
					await this.waitForCommit(token);
					this.emitCommandEventsThrough(this.nextSequence, token);
				}
				this.nextSequence = result.nextSequence;
				this.emitCommandEventsThrough(this.nextSequence, token);
				if (token.isCancellationRequested) {
					return;
				}
				// The backend reports OS exit independently of pagination. A full page
				// may still have a tail, so drain both streams before publishing exit.
				if (result.exited && result.chunks.length < MAX_READ_CHUNKS && result.commandEvents.length < MAX_READ_CHUNKS) {
					this.stopInput();
					this.processExitEmitter.fire(result.exitCode);
					return;
				}
				if (result.chunks.length === 0) {
					const delay = timeout(POLL_DELAY_MILLIS);
					try {
						await raceCancellationError(delay, token);
					} finally {
						delay.cancel();
					}
				}
			}
		} finally {
			if (this.reading.value === lifetime) {
				this.reading.clear();
			}
		}
	}

	/** Resolves after every UTF-8 batch containing this input is acknowledged by the process. */
	public write(data: string): Promise<void> {
		if (!this.acceptingInput || this.isDisposed) { return Promise.reject(new CancellationError()); }
		if (data.length === 0) { return Promise.resolve(); }
		const completion = new DeferredPromise<void>();
		this.pendingInputCompletions.push(completion);
		this.pendingInput += data;
		if (this.pendingInput.length >= INPUT_BATCH_CHARACTERS) {
			this.flushInput();
		} else if (this.inputTimer === undefined) {
			this.inputTimer = setTimeout(() => {
				this.inputTimer = undefined;
				this.flushInput();
			}, INPUT_BATCH_DELAY_MILLIS);
		}
		return completion.p;
	}

	public processBinary(data: string): Promise<void> {
		if (!this.acceptingInput || this.isDisposed) {
			return Promise.reject(new CancellationError());
		}
		// Flush every preceding text batch before mouse bytes. Later text queues after them.
		this.flushInput();
		const bytes = Uint8Array.from(data, character => character.charCodeAt(0));
		return this.enqueueInput(bytes);
	}

	public setDimensions(cols: number, rows: number): Promise<void> {
		const dimensions = { cols, rows };
		if (!this.acceptingInput || this.isDisposed) { return Promise.reject(new CancellationError()); }
		const completion = new DeferredPromise<void>();
		this.pendingResizeCompletions.push(completion);
		this.pendingDimensions = dimensions;
		if (this.resizeScheduled) { return completion.p; }
		this.resizeScheduled = true;
		queueMicrotask(() => {
			this.resizeScheduled = false;
			const pending = this.pendingDimensions;
			this.pendingDimensions = undefined;
			const completions = this.pendingResizeCompletions.splice(0);
			if (!pending || !this.acceptingInput || this.isDisposed) return;
			const generation = this.inputGeneration;
			const operation = raceCancellationError(this.processService.resize({
				...this.identity,
				rows: pending.rows,
				cols: pending.cols,
			}), this.inputCancellation.value!.token);
			for (const waiter of completions) { waiter.settleWith(operation); }
			void operation.catch(error => {
				if (generation === this.inputGeneration && this.acceptingInput) {
					this.processErrorEmitter.fire(error);
				}
			});
		});
		return completion.p;
	}

	private flushInput(): void {
		if (this.inputTimer !== undefined) {
			clearTimeout(this.inputTimer);
			this.inputTimer = undefined;
		}
		if (!this.acceptingInput || this.isDisposed || this.pendingInput.length === 0) return;
		const completions = this.pendingInputCompletions.splice(0);
		const operations: Promise<void>[] = [];
		while (this.pendingInput.length > 0) {
			const data = takeUtf8Prefix(this.pendingInput, MAX_INPUT_BATCH_BYTES);
			this.pendingInput = this.pendingInput.slice(data.length);
			operations.push(this.enqueueInput(data));
		}
		const acknowledgement = Promise.all(operations).then(() => { });
		for (const completion of completions) { completion.settleWith(acknowledgement); }
	}

	private enqueueInput(data: string | Uint8Array): Promise<void> {
		const generation = this.inputGeneration;
		const token = this.inputCancellation.value!.token;
		const operation = this.writeChain.then(async () => {
			if (generation !== this.inputGeneration || !this.acceptingInput || this.isDisposed) {
				throw new CancellationError();
			}
			await raceCancellationError(this.processService.write({ ...this.identity, data }), token);
		});
		this.writeChain = operation.catch(error => {
			if (!isCancellationError(error) && generation === this.inputGeneration && this.acceptingInput) {
				this.processErrorEmitter.fire(error);
			}
		});
		return operation;
	}

	private stopInput(): void {
		this.acceptingInput = false;
		this.inputGeneration += 1;
		// Cancel acknowledgements as well as queued data. A hung old transport must
		// not hold the input queue after this same Shell reconnects.
		this.inputCancellation.value?.cancel();
		for (const completion of this.pendingInputCompletions.splice(0)) { void completion.error(new CancellationError()); }
		for (const completion of this.pendingResizeCompletions.splice(0)) { void completion.error(new CancellationError()); }
		this.pendingDimensions = undefined;
		if (this.inputTimer !== undefined) {
			clearTimeout(this.inputTimer);
			this.inputTimer = undefined;
		}
		this.pendingInput = "";
	}

	public stop(): void {
		this.reading.clear();
		this.stopInput();
	}

	protected override disposeCore(): void {
		this.stop();
		this.pendingCommit = undefined;
		this.pendingCommandEvents.length = 0;
		super.disposeCore();
	}

	private async waitForCommit(token: CancellationToken): Promise<void> {
		if (this.pendingCommit) {
			await raceCancellationError(this.pendingCommit, token);
			this.pendingCommit = undefined;
		}
	}

	private emitCommandEventsThrough(sequence: number, token: CancellationToken): void {
		while (!token.isCancellationRequested && this.pendingCommandEvents.length > 0 && this.pendingCommandEvents[0]!.afterOutputSequence <= sequence) {
			const event = this.pendingCommandEvents.shift()!;
			this.commandStatusEmitter.fire({ commandId: event.commandId, status: event.status, exitCode: event.exitCode });
		}
	}
}

function takeUtf8Prefix(value: string, maximumBytes: number): string {
	if (VSBuffer.fromString(value).byteLength <= maximumBytes) return value;
	let lower = 1;
	let upper = value.length;
	while (lower < upper) {
		const middle = Math.ceil((lower + upper) / 2);
		if (VSBuffer.fromString(value.slice(0, middle)).byteLength <= maximumBytes) {
			lower = middle;
		} else {
			upper = middle - 1;
		}
	}
	if (lower < value.length && isHighSurrogate(value.charCodeAt(lower - 1))) {
		lower -= 1;
	}
	return value.slice(0, Math.max(1, lower));
}

function isHighSurrogate(codeUnit: number): boolean {
	return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}
