import { Emitter, type Event } from '../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';

/** Owns one browser Worker and exposes its structured-clone message channel. */
export class BrowserWorkerClientPort extends Disposable {
	private readonly messageEmitter = this._register(new Emitter<unknown>());
	private readonly failureEmitter = this._register(new Emitter<unknown>());

	public readonly onMessage: Event<unknown> = this.messageEmitter.event;
	public readonly onFailure: Event<unknown> = this.failureEmitter.event;

	constructor(private readonly worker: Worker) {
		super();
		const handleMessage = (event: MessageEvent<unknown>): void => this.messageEmitter.fire(event.data);
		const handleError = (event: ErrorEvent): void => this.failureEmitter.fire(event.error ?? new Error(event.message));
		const handleMessageError = (): void => this.failureEmitter.fire(new TypeError('Worker returned an unreadable message'));
		worker.addEventListener('message', handleMessage);
		worker.addEventListener('error', handleError);
		worker.addEventListener('messageerror', handleMessageError);
		this._register(toDisposable(() => {
			worker.removeEventListener('message', handleMessage);
			worker.removeEventListener('error', handleError);
			worker.removeEventListener('messageerror', handleMessageError);
			worker.terminate();
		}));
	}

	public send(message: unknown, transfer: readonly Transferable[] = []): void {
		this.assertNotDisposed();
		this.worker.postMessage(message, [...transfer]);
	}
}
