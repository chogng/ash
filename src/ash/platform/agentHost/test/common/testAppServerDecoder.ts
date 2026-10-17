import { Emitter } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { WebWorkerServer, type WebWorkerClientPort } from '../../../../base/common/worker/webWorker.js';
import { appServerDecodeChannel, appServerDecodeHandler } from '../../browser/appServerProtocolDecoding.js';

/** Exercises the production Worker channel with manually released, cloned jobs. */
export class TestAppServerDecodePort extends Disposable implements WebWorkerClientPort {
	private readonly requests = this._register(new Emitter<unknown>());
	private readonly responses = this._register(new Emitter<unknown>());
	private readonly failures = this._register(new Emitter<unknown>());
	public readonly onMessage = this.responses.event;
	public readonly onFailure = this.failures.event;
	public readonly jobs: unknown[] = [];
	constructor() {
		super();
		this._register(new WebWorkerServer({
			onMessage: this.requests.event,
			send: value => this.responses.fire(structuredClone(value)),
			...toDisposable(() => { }),
		}, appServerDecodeChannel, appServerDecodeHandler));
	}
	public send(value: unknown): void { this.jobs.push(structuredClone(value)); }
	public fail(error: Error): void { this.failures.fire(error); }
	public async release(): Promise<void> {
		if (!this.jobs.length) throw new Error('No pending decode job');
		this.requests.fire(this.jobs.shift());
		await new Promise<void>(resolve => setImmediate(resolve));
	}
}
