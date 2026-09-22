import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { WebWorkerServer, type WebWorkerClientPort } from '../../../../base/common/worker/webWorker.js';
import { diffWorkerChannel, diffWorkerHandler } from '../../../common/diff/diffWorker.js';

/** Runs the production protocol and algorithm over an asynchronous cloned test channel. */
export class DiffTestPort extends Disposable implements WebWorkerClientPort {
	private readonly responses = this._register(new Emitter<unknown>());
	private readonly requests = this._register(new Emitter<unknown>());
	public readonly onMessage = this.responses.event;
	public readonly onFailure = Event.None;

	constructor() {
		super();
		const port = Object.assign(toDisposable(() => {}), {
			onMessage: this.requests.event,
			send: (value: unknown): void => this.deliver(this.responses, value),
		});
		this._register(new WebWorkerServer(port, diffWorkerChannel, diffWorkerHandler));
	}

	public send(value: unknown): void {
		this.deliver(this.requests, value);
	}

	private deliver(emitter: Emitter<unknown>, value: unknown): void {
		const message = structuredClone(value);
		queueMicrotask(() => {
			if (!this.isDisposed) {
				emitter.fire(message);
			}
		});
	}
}
