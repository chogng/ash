import { binarySearch2 } from '../../../common/arrays.js';

export interface IItem {
	size: number;
}

export interface IRangeMap {
	readonly size: number;
	readonly count: number;
	paddingTop: number;
	splice(index: number, deleteCount: number, items?: IItem[]): void;
	indexAt(position: number): number;
	indexAfter(position: number): number;
	positionAt(index: number): number;
}

/** Row geometry independent of rendering, identity and scroll state. */
export class RangeMap implements IRangeMap {
	private offsets: number[] = [0];

	constructor(public paddingTop = 0) {}

	get count(): number {
		return this.offsets.length - 1;
	}

	get size(): number {
		return this.paddingTop + this.offsets[this.count]!;
	}

	splice(index: number, deleteCount: number, items: IItem[] = []): void {
		const deleteEnd = Math.min(index + deleteCount, this.count);
		const next = this.offsets.slice(0, index + 1);
		for (const item of items) {
			next.push(next.at(-1)! + item.size);
		}
		// Unchanged rows retain their measured sizes; only their positions shift.
		const delta = next.at(-1)! - this.offsets[deleteEnd]!;
		for (let current = deleteEnd + 1; current < this.offsets.length; current++) {
			next.push(this.offsets[current]! + delta);
		}
		this.offsets = next;
	}

	indexAt(position: number): number {
		if (position < 0) return -1;
		const relativePosition = position - this.paddingTop;
		// A row's bottom edge belongs to the next row, so search for the first bottom beyond it.
		const result = binarySearch2(this.count, index => this.offsets[index + 1]! <= relativePosition ? -1 : 1);
		return -result - 1;
	}

	indexAfter(position: number): number {
		return Math.min(this.count, this.indexAt(position) + 1);
	}

	positionAt(index: number): number {
		return index < 0 || index >= this.count ? -1 : this.paddingTop + this.offsets[index]!;
	}
}
