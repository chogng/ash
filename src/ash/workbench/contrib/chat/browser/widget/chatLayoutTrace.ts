import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { LogLevel, type ILogger } from '../../../../../platform/log/common/log.js';

export type ChatLayoutTraceMethod = 'renderElement' | 'disposeElement' | 'renderChatTreeItem' | 'doNextProgressiveRender' | 'getNextProgressiveRenderContent';

interface TraceEventSummary {
	readonly method: ChatLayoutTraceMethod;
	count: number;
	firstIndex?: number;
	lastIndex?: number;
	readonly samples: string[];
}

interface TraceBatch {
	readonly startedAt: number;
	readonly events: TraceEventSummary[];
}

let nextTraceId = 1;

/** One list owns the batch so row replacement cannot turn diagnostics into a per-row log stream. */
export class ChatLayoutTrace extends Disposable {
	private readonly traceId = nextTraceId++;
	private batch: TraceBatch | undefined;
	private readonly publish = this._register(new RunOnceScheduler(() => this.publishBatch(), 1000));

	constructor(private readonly now: () => number, private readonly logger: ILogger) {
		super();
		this._register(logger.onDidChangeLogLevel(level => {
			if (level !== LogLevel.Trace) {
				this.batch = undefined;
				this.publish.cancel();
			}
		}));
	}

	trace(method: ChatLayoutTraceMethod, message: () => string, index?: number): void {
		if (this.isDisposed || this.logger.getLevel() !== LogLevel.Trace) return;
		const time = this.now();
		// A synchronous render storm may prevent the scheduled task from running.
		if (this.batch && time - this.batch.startedAt >= 1000) this.publishBatch();
		if (!this.batch) {
			this.batch = { startedAt: time, events: [] };
			this.publish.schedule();
		}
		let summary = this.batch.events.find(event => event.method === method);
		if (!summary) {
			summary = { method, count: 0, samples: [] };
			this.batch.events.push(summary);
		}
		summary.count++;
		if (index !== undefined) {
			summary.firstIndex = Math.min(summary.firstIndex ?? index, index);
			summary.lastIndex = Math.max(summary.lastIndex ?? index, index);
		}
		if (summary.samples.length < 2) summary.samples.push(message().slice(0, 180));
	}

	private publishBatch(): void {
		const batch = this.batch;
		this.batch = undefined;
		this.publish.cancel();
		if (batch && this.logger.getLevel() === LogLevel.Trace) {
			this.logger.trace(JSON.stringify({ traceId: this.traceId, elapsedMs: Math.round(this.now() - batch.startedAt), events: batch.events }));
		}
	}

	protected override disposeCore(): void {
		this.publishBatch();
		super.disposeCore();
	}
}
