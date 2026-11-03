import { RunOnceScheduler } from '../../../../../../../base/common/async.js';
import { Emitter, type Event } from '../../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../../base/common/lifecycle.js';

export interface ITerminalToolAutoExpandOptions {
	readonly onCommandExecuted: Event<unknown>;
	readonly onCommandFinished: Event<unknown>;
	readonly onWillData: Event<unknown>;
	shouldAutoExpand(): boolean;
	hasRealOutput(): boolean;
}

export const enum TerminalToolAutoExpandTimeout {
	NoData = 500,
	DataEvent = 50,
}

/** Coalesces output admission and cancels it when a fast command finishes. */
export class TerminalToolAutoExpand extends Disposable {
	private readonly expand = this._register(new Emitter<void>());
	public readonly onDidRequestExpand = this.expand.event;
	private active = false;
	private receivedData = false;
	private readonly admission: RunOnceScheduler;

	constructor(options: ITerminalToolAutoExpandOptions) {
		super();
		this.admission = this._register(new RunOnceScheduler(() => {
			if (this.active && options.shouldAutoExpand() && options.hasRealOutput()) {
				this.active = false;
				this.expand.fire();
			}
		}, TerminalToolAutoExpandTimeout.NoData));
		this._register(options.onCommandExecuted(() => {
			this.active = true;
			this.receivedData = false;
			this.admission.cancel();
			if (options.shouldAutoExpand()) { this.admission.schedule(); }
		}));
		this._register(options.onWillData(() => {
			if (this.active && !this.receivedData) {
				this.receivedData = true;
				if (options.shouldAutoExpand()) { this.admission.schedule(TerminalToolAutoExpandTimeout.DataEvent); }
			}
		}));
		this._register(options.onCommandFinished(() => {
			this.active = false;
			this.admission.cancel();
		}));
	}
}
