import { Disposable, MutableDisposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { observableValue, type IObservable } from '../../../../../../base/common/observable.js';

/** Serializes mutations from the composer’s model pickers while the host owns the selected model. */
export class ChatInputModelSelectionController extends Disposable {
	private readonly selecting = observableValue(this, false);
	readonly isSelecting: IObservable<boolean> = this.selecting;
	private readonly pending = this._register(new MutableDisposable());

	async run(lifetime: AbortSignal | undefined, apply: () => Promise<unknown>): Promise<boolean> {
		if (this.isDisposed || lifetime?.aborted || this.pending.value) return false;
		const release = () => {
			if (this.pending.value === operation) this.pending.clear();
		};
		const operation = toDisposable(() => {
			lifetime?.removeEventListener('abort', release);
			this.selecting.set(false, undefined);
		});
		this.pending.value = operation;
		lifetime?.addEventListener('abort', release, { once: true });
		this.selecting.set(true, undefined);
		try {
			if (this.pending.value !== operation) return false;
			await apply();
			return this.pending.value === operation;
		} catch (error) {
			if (this.pending.value !== operation) return false;
			throw error;
		} finally {
			release();
		}
	}
}
