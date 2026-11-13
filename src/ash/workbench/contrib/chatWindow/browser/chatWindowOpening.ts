import { promiseWithResolvers } from '../../../../base/common/async.js';

/** Shares pending opens, including calls made synchronously as a popup is created. */
export class InFlightOperations<T, TKey = string> {
	private readonly pending = new Map<TKey, Promise<T>>();

	run(key: TKey, operation: () => Promise<T>): Promise<T> {
		const pending = this.pending.get(key);
		if (pending) return pending;

		const { promise, resolve, reject } = promiseWithResolvers<T>();
		this.pending.set(key, promise);
		try {
			void operation().then(resolve, reject);
		} catch (error) {
			reject(error);
		}
		const remove = () => { this.pending.delete(key); };
		void promise.then(remove, remove);
		return promise;
	}
}
