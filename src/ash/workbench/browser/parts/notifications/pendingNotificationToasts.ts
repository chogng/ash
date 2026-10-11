import { Disposable, DisposableMap, DisposableStore, type IDisposable } from '../../../../base/common/lifecycle.js';

/** Owns cancellable creation work until the toast surface accepts its resources. */
export class PendingNotificationToasts<T> extends Disposable {
	private readonly pending = this._register(new DisposableMap<T, DisposableStore>());

	constructor(
		private readonly isCurrent: (item: T) => boolean,
		private readonly scheduler: (callback: () => void) => IDisposable,
	) {
		super();
	}

	public add(item: T, render: (item: T, resources: DisposableStore) => void): void {
		const resources = this.pending.set(item, new DisposableStore());
		const scheduled = this.scheduler(() => {
			if (this.pending.get(item) !== resources) {
				return;
			}
			const lifetime = this.pending.deleteAndLeak(item);
			if (!lifetime) {
				return;
			}
			if (!this.isCurrent(item)) {
				lifetime.dispose();
				return;
			}
			try {
				render(item, lifetime);
			} catch (error) {
				lifetime.dispose();
				throw error;
			}
		});
		// A controlled scheduler may already have transferred or disposed this lifetime.
		if (resources.isDisposed) {
			scheduled.dispose();
		} else {
			resources.add(scheduled);
		}
	}

	public remove(item: T): void {
		this.pending.deleteAndDispose(item);
	}

	public clear(): void {
		this.pending.clearAndDisposeAll();
	}
}
