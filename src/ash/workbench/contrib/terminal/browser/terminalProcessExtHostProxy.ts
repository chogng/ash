import { CancellationError, onUnexpectedError } from '../../../../base/common/errors.js';
import { raceCancellationError, TaskQueue } from '../../../../base/common/async.js';
import { ProcessPropertyType } from '../../../../platform/terminal/common/terminal.js';
import type { JsonValue } from '../../../../platform/agentHost/common/extensionHostApi.js';
import { localize } from '../../../../nls.js';
import { BasePty } from '../common/basePty.js';
import { Emitter } from '../../../../base/common/event.js';
import { TerminalDataBufferer } from '../../../../platform/terminal/common/terminalDataBuffering.js';

export interface ExtensionTerminalPty {
	readonly ptyId: string;
	readonly acceptsInput: boolean;
	readonly invoke: (operation: string, payload: JsonValue, signal: AbortSignal) => Promise<JsonValue>;
}

/** The instance owns its screen; this child owns only an extension's bounded opaque PTY stream. */
export class TerminalProcessExtHostProxy extends BasePty {
	private readonly sendInput = (data: string) => this.dispatch('inputTaskTerminal', { data });
	get input(): ((data: string) => Promise<void>) | undefined {
		return this.acceptsInput ? this.sendInput : undefined;
	}
	private readonly queue = new TaskQueue();
	private readonly controller = new AbortController();
	private timer: ReturnType<typeof setTimeout> | undefined;
	private closed = false;
	private readonly incomingData = this._register(new Emitter<string>());
	private readonly bufferer = this._register(new TerminalDataBufferer((_id, data) => this.handleData(data)));

	constructor(
		id: number,
		private ptyId: string | undefined,
		private acceptsInput: boolean,
		private cols: number,
		private rows: number,
		private invoke: ExtensionTerminalPty['invoke'],
		private readonly releaseOwner: () => void,
		private readonly createPty?: (signal: AbortSignal) => Promise<ExtensionTerminalPty>,
	) {
		super(id, false);
		this._register(this.bufferer.startBuffering(id, this.incomingData.event));
	}

	async start(): Promise<void> {
		if (this.ptyId === undefined) {
			if (!this.createPty) throw invalid();
			const pty = await this.createPty(this.controller.signal);
			this.ptyId = pty.ptyId;
			this.acceptsInput = pty.acceptsInput;
			this.invoke = pty.invoke;
			if (this.closed) {
				await this.releasePty();
				throw new CancellationError();
			}
		}
		const result = await this.invoke('openTaskTerminal', { ptyId: this.ptyId, dimensions: { columns: this.cols, rows: this.rows } }, this.controller.signal);
		if (this.closed) throw new CancellationError();
		this.handleReady({ pid: -1, cwd: '' });
		this.consume(result);
		// open() may synchronously write before the instance has a screen. Publish
		// that initial batch before start() resolves, then throttle later output.
		this.bufferer.flushBuffer(this.id);
		this.poll();
	}

	resize(cols: number, rows: number): Promise<void> {
		this.cols = cols;
		this.rows = rows;
		// Before profile creation, these dimensions become the initial open request.
		if (!this.closed && this.ptyId === undefined) {
			return Promise.resolve();
		}
		return this.dispatch('resizeTaskTerminal', { dimensions: { columns: cols, rows } });
	}

	shutdown(_immediate: boolean): void {
		this.finish(undefined);
	}

	private finish(code: number | undefined): void {
		if (this.closed) return;
		this.closed = true;
		this.controller.abort();
		this.queue.clearPending();
		clearTimeout(this.timer);
		this.timer = undefined;
		this.bufferer.stopBuffering(this.id);
		this.releaseOwner();
		this.handleExit(code);
		void this.releasePty();
	}

	private async releasePty(): Promise<void> {
		if (this.ptyId === undefined) return;
		const ptyId = this.ptyId;
		this.ptyId = undefined;
		await this.invoke('closeTaskTerminal', { ptyId }, new AbortController().signal).catch(() => undefined);
	}

	private async dispatch(operation: string, payload: Record<string, JsonValue>): Promise<void> {
		const ptyId = this.ptyId;
		if (this.closed || ptyId === undefined) {
			throw new CancellationError();
		}
		try {
			await this.queue.schedule(async () => {
				if (this.closed) {
					throw new CancellationError();
				}
				const result = await raceCancellationError(this.invoke(operation, { ...payload, ptyId }, this.controller.signal), this.controller.signal);
				if (this.closed) {
					throw new CancellationError();
				}
				this.consume(result);
			});
		} catch (error) {
			if (!this.closed) {
				this.shutdown(true);
			}
			throw error;
		}
	}

	private poll(): void {
		const ptyId = this.ptyId;
		if (this.closed || ptyId === undefined) return;
		void this.queue
			.schedule(async () => {
				const result = await this.invoke('readTaskTerminal', { ptyId }, this.controller.signal);
				if (this.closed) return;
				this.consume(result);
			})
			.then(
				() => {
					if (!this.closed)
						this.timer = setTimeout(() => {
							this.timer = undefined;
							this.poll();
						}, 50);
				},
				error => {
					if (!this.closed) {
						onUnexpectedError(error);
						this.shutdown(true);
					}
				},
			);
	}

	private consume(value: JsonValue): void {
		if (this.closed) return;
		const result = record(value);
		if (!Array.isArray(result.events) || result.events.length > 1024) throw invalid();
		for (const value of result.events) {
			if (this.closed) break;
			const event = record(value);
			if (event.type === 'data') this.incomingData.fire(text(event.data, 262144, true));
			else if (event.type === 'name') {
				this.bufferer.flushBuffer(this.id);
				this.handleDidChangeProperty({ type: ProcessPropertyType.Title, value: text(event.name, 256) });
			} else if (event.type === 'close') {
				if (event.code !== null && (typeof event.code !== 'number' || !Number.isSafeInteger(event.code) || event.code < 0 || event.code > 2147483647)) throw invalid();
				this.finish(event.code === null ? undefined : (event.code as number));
			} else throw invalid();
		}
	}

	protected override disposeCore(): void {
		this.shutdown(true);
		super.disposeCore();
	}
}

function invalid(): TypeError {
	return new TypeError(localize('terminal.profile.invalidProviderResult', 'Invalid terminal profile provider response.'));
}

function record(value: unknown, keys?: readonly string[]): Record<string, JsonValue> {
	if (!value || typeof value !== 'object' || Array.isArray(value) || (keys && Object.keys(value).some(key => !keys.includes(key)))) throw invalid();
	return value as Record<string, JsonValue>;
}

function text(value: unknown, maximum: number, allowEmpty = false): string {
	if (typeof value !== 'string' || value.length > maximum || (!allowEmpty && (!value || /[\u0000-\u001f\u007f]/.test(value)))) throw invalid();
	return value;
}
