import type { ISpliceable } from '../../../common/sequence.js';

/** Applies the same edit to the owners of a list's parallel state, in registration order. */
export class CombinedSpliceable<T> implements ISpliceable<T> {
	constructor(private readonly spliceables: ISpliceable<T>[]) { }

	public splice(start: number, deleteCount: number, elements: readonly T[]): void {
		for (const spliceable of this.spliceables) {
			spliceable.splice(start, deleteCount, elements);
		}
	}
}
