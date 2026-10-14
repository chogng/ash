import { DeferredPromise } from '../../../base/common/async.js';
import { CancellationError } from '../../../base/common/errors.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { localize } from '../../../nls.js';
import { ILogService } from '../../log/common/log.js';

/** Pairs terminal domain callbacks. Transport request IDs remain with the protocol client. */
export class RequestStore<T, RequestArgs> extends Disposable {
	private readonly requested = this._register(new Emitter<RequestArgs & { requestId: number; }>());
	readonly onCreateRequest = this.requested.event;
	private readonly waiting = new Map<number, { completion: DeferredPromise<T>; timer: ReturnType<typeof setTimeout>; }>();
	private nextId = 0;
	private readonly timeout: number;

	constructor(timeout: number | undefined, @ILogService private readonly log: ILogService) {
		super();
		this.timeout = timeout ?? 15_000;
	}

	createRequest(args: RequestArgs): Promise<T> {
		if (this.isDisposed) {
			return Promise.reject(new CancellationError());
		}
		const requestId = ++this.nextId;
		const completion = new DeferredPromise<T>();
		const timer = setTimeout(() => {
			this.waiting.delete(requestId);
			completion.error(new Error(localize('terminal.request.timedOut', 'Terminal request timed out.')));
		}, this.timeout);
		// Register before dispatch so a synchronous provider reply cannot be lost.
		this.waiting.set(requestId, { completion, timer });
		this.requested.fire({ ...args, requestId });
		return completion.p;
	}

	acceptReply(requestId: number, data: T): void {
		const pending = this.waiting.get(requestId);
		if (!pending) {
			this.log.trace('Terminal reply arrived after its request was released', { requestId });
			return;
		}
		this.waiting.delete(requestId);
		clearTimeout(pending.timer);
		pending.completion.complete(data);
	}

	protected override disposeCore(): void {
		for (const { timer, completion } of this.waiting.values()) {
			clearTimeout(timer);
			completion.error(new CancellationError());
		}
		this.waiting.clear();
		super.disposeCore();
	}
}
