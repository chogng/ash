import { TimeoutTimer } from '../../../base/common/async.js';
import { Emitter, type Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';

export interface IInlineCompletionsService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeIsSnoozing: Event<boolean>;
	readonly snoozeTimeLeft: number;
	snooze(durationMs?: number): void;
	setSnoozeDuration(durationMs: number): void;
	isSnoozing(): boolean;
	cancelSnooze(): void;
	reportNewCompletion(requestUuid: string): void;
}

/** Owns editor-wide inline-completion snooze state and recent completion identities. */
export class InlineCompletionsService extends Disposable implements IInlineCompletionsService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeIsSnoozing = this._register(new Emitter<boolean>());
	readonly onDidChangeIsSnoozing: Event<boolean> = this._onDidChangeIsSnoozing.event;

	private static readonly SNOOZE_DURATION = 300_000;
	private _snoozeTimeEnd: number | undefined;
	private readonly _timer = this._register(new TimeoutTimer());
	private _lastCompletionId: string | undefined;
	private _recentCompletionIds: string[] = [];

	get snoozeTimeLeft(): number {
		return this._snoozeTimeEnd === undefined
			? 0
			: Math.max(0, this._snoozeTimeEnd - Date.now());
	}

	snooze(durationMs: number = InlineCompletionsService.SNOOZE_DURATION): void {
		this.setSnoozeDuration(durationMs + this.snoozeTimeLeft);
	}

	setSnoozeDuration(durationMs: number): void {
		if (!Number.isFinite(durationMs) || durationMs < 0) {
			throw new RangeError(`Invalid snooze duration: ${durationMs}. Duration must be non-negative.`);
		}
		if (durationMs === 0) {
			this.cancelSnooze();
			return;
		}
		const wasSnoozing = this.isSnoozing();
		this._snoozeTimeEnd = Date.now() + durationMs;
		if (!wasSnoozing) this._onDidChangeIsSnoozing.fire(true);
		this._timer.cancelAndSet(() => {
			if (this.isSnoozing()) throw new Error('Inline-completion snooze timer fired before its deadline');
			this._snoozeTimeEnd = undefined;
			this._onDidChangeIsSnoozing.fire(false);
		}, this.snoozeTimeLeft + 1);
	}

	isSnoozing(): boolean {
		return this.snoozeTimeLeft > 0;
	}

	cancelSnooze(): void {
		if (!this.isSnoozing()) return;
		this._snoozeTimeEnd = undefined;
		this._timer.cancel();
		this._onDidChangeIsSnoozing.fire(false);
	}

	reportNewCompletion(requestUuid: string): void {
		if (typeof requestUuid !== 'string' || requestUuid.length === 0) throw new TypeError('Inline completion request UUID must be a non-empty string');
		this._lastCompletionId = requestUuid;
		this._recentCompletionIds.unshift(requestUuid);
		if (this._recentCompletionIds.length > 5) this._recentCompletionIds.pop();
	}
}
