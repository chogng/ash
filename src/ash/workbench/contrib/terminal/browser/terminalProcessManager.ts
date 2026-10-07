import { raceCancellationError, timeout } from '../../../../base/common/async.js';
import { cancelOnDispose, type CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ITerminalProcessService, type IProcessDataEvent, type ITerminalProcessCloseOptions, type ITerminalProcessCommandStatusEvent } from '../../../../platform/terminal/common/terminal.js';
import type { ITerminalCommandStatusEvent } from './terminal.js';

const MAX_READ_CHUNKS = 128;
const POLL_DELAY_MILLIS = 35;

/** One Shell's output stream; the instance owns creation, input and process shutdown. */
export class TerminalProcessManager extends Disposable {
	private readonly reading = this._register(new MutableDisposable<DisposableStore>());
	private readonly processDataEmitter = this._register(new Emitter<IProcessDataEvent>());
	private readonly commandStatusEmitter = this._register(new Emitter<ITerminalCommandStatusEvent>());
	private readonly processExitEmitter = this._register(new Emitter<number | undefined>());
	private readonly ptyReconnectEmitter = this._register(new Emitter<void>());
	private readonly outputGapEmitter = this._register(new Emitter<void>());
	private readonly pendingCommandEvents: ITerminalProcessCommandStatusEvent[] = [];
	private nextSequence = 0;
	private nextCommandSequence = 0;
	private pendingCommit: Promise<void> | undefined;

	public readonly onProcessData = this.processDataEmitter.event;
	public readonly onDidChangeCommandStatus = this.commandStatusEmitter.event;
	public readonly onProcessExit = this.processExitEmitter.event;
	public readonly onPtyReconnect = this.ptyReconnectEmitter.event;
	public readonly onOutputGap = this.outputGapEmitter.event;

	constructor(private readonly identity: ITerminalProcessCloseOptions, @ITerminalProcessService private readonly processService: ITerminalProcessService) {
		super();
	}

	public async start(reconnecting = false): Promise<void> {
		this.assertNotDisposed();
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

	public stop(): void {
		this.reading.clear();
	}

	protected override disposeCore(): void {
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
