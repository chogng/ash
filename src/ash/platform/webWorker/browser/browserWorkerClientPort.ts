import { Emitter, type Event } from '../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { toError } from '../../../base/common/errors.js';
import { addDisposableListener } from '../../../base/browser/dom.js';

/** Owns one browser Worker and exposes its structured-clone message channel. */
export class BrowserWorkerClientPort extends Disposable {
	private readonly messageEmitter = this._register(new Emitter<unknown>());
	private readonly failureEmitter = this._register(new Emitter<unknown>());

	public readonly onMessage: Event<unknown> = this.messageEmitter.event;
	public readonly onFailure: Event<unknown> = this.failureEmitter.event;
	private worker: Worker | undefined;
	private startupError: Error | undefined;
	private readonly queued: { message: unknown; transfer: Transferable[] }[] = [];

	constructor(worker: Worker | Promise<Worker>) {
		super();
		this._register(
			toDisposable(() => {
				this.queued.length = 0;
			}),
		);
		if (typeof (worker as Promise<Worker>).then === 'function') {
			void Promise.resolve(worker)
				.then(worker => {
					if (this.isDisposed) {
						worker.terminate();
						return;
					}
					this.attach(worker);
					for (const queued of this.queued.splice(0)) worker.postMessage(queued.message, queued.transfer);
				})
				.catch(error => {
					if (this.isDisposed) return;
					this.queued.length = 0;
					this.startupError = toError(error);
					this.failureEmitter.fire(this.startupError);
				});
		} else {
			this.attach(worker as Worker);
		}
	}

	private attach(worker: Worker): void {
		this.worker = worker;
		const handleMessage = (event: MessageEvent<unknown>): void => this.messageEmitter.fire(event.data);
		const handleError = (event: ErrorEvent): void => this.failureEmitter.fire(event.error ?? new Error(event.message));
		const handleMessageError = (): void => this.failureEmitter.fire(new TypeError('Worker returned an unreadable message'));
		this._register(addDisposableListener(worker, 'message', handleMessage));
		this._register(addDisposableListener(worker, 'error', handleError));
		this._register(addDisposableListener(worker, 'messageerror', handleMessageError));
		this._register(toDisposable(() => worker.terminate()));
	}

	public send(message: unknown, transfer: readonly Transferable[] = []): void {
		this.assertNotDisposed();
		if (this.startupError) throw this.startupError;
		if (this.worker) this.worker.postMessage(message, [...transfer]);
		else this.queued.push({ message, transfer: [...transfer] });
	}
}
