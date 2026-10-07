import type { CancellationToken } from './cancellation.js';
import type { Event } from './event.js';

/** The model owns loaded values; resolving a visible index may extend its length. */
export interface IPagedModel<T> {
	readonly length: number;
	readonly onDidIncrementLength: Event<number>;
	isResolved(index: number): boolean;
	get(index: number): T;
	resolve(index: number, cancellationToken: CancellationToken): Promise<T>;
}
