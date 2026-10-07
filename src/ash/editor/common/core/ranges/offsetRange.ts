export interface IOffsetRange {
	readonly start: number;
	readonly endExclusive: number;
}

/** A zero-based half-open range of UTF-16 offsets. */
export class OffsetRange implements IOffsetRange {
	static fromTo(start: number, endExclusive: number): OffsetRange { return new OffsetRange(start, endExclusive); }
	static ofLength(length: number): OffsetRange { return new OffsetRange(0, length); }
	static ofStartAndLength(start: number, length: number): OffsetRange { return new OffsetRange(start, start + length); }
	static emptyAt(offset: number): OffsetRange { return new OffsetRange(offset, offset); }
	static tryCreate(start: number, endExclusive: number): OffsetRange | undefined { return start <= endExclusive ? new OffsetRange(start, endExclusive) : undefined; }
	static equals(left: IOffsetRange, right: IOffsetRange): boolean { return left.start === right.start && left.endExclusive === right.endExclusive; }
	static addRange(range: OffsetRange, sortedRanges: OffsetRange[]): void {
		let start = 0;
		while (start < sortedRanges.length && sortedRanges[start]!.endExclusive < range.start) start += 1;
		let end = start;
		while (end < sortedRanges.length && sortedRanges[end]!.start <= range.endExclusive) end += 1;
		if (start === end) sortedRanges.splice(start, 0, range);
		else sortedRanges.splice(start, end - start, new OffsetRange(Math.min(range.start, sortedRanges[start]!.start), Math.max(range.endExclusive, sortedRanges[end - 1]!.endExclusive)));
	}

	constructor(readonly start: number, readonly endExclusive: number) {
		if (!Number.isSafeInteger(start) || !Number.isSafeInteger(endExclusive) || start < 0 || start > endExclusive) throw new RangeError("Invalid offset range");
	}

	get isEmpty(): boolean { return this.start === this.endExclusive; }
	get length(): number { return this.endExclusive - this.start; }
	contains(offset: number): boolean { return this.start <= offset && offset < this.endExclusive; }
	containsRange(other: OffsetRange): boolean { return this.start <= other.start && other.endExclusive <= this.endExclusive; }
	equals(other: OffsetRange): boolean { return OffsetRange.equals(this, other); }
	delta(offset: number): OffsetRange { return new OffsetRange(this.start + offset, this.endExclusive + offset); }
	deltaStart(offset: number): OffsetRange { return new OffsetRange(this.start + offset, this.endExclusive); }
	deltaEnd(offset: number): OffsetRange { return new OffsetRange(this.start, this.endExclusive + offset); }
	join(other: OffsetRange): OffsetRange { return new OffsetRange(Math.min(this.start, other.start), Math.max(this.endExclusive, other.endExclusive)); }
	intersect(other: OffsetRange): OffsetRange | undefined { const start = Math.max(this.start, other.start); const end = Math.min(this.endExclusive, other.endExclusive); return start <= end ? new OffsetRange(start, end) : undefined; }
	intersectionLength(other: OffsetRange): number { return Math.max(0, Math.min(this.endExclusive, other.endExclusive) - Math.max(this.start, other.start)); }
	intersects(other: OffsetRange): boolean { return Math.max(this.start, other.start) < Math.min(this.endExclusive, other.endExclusive); }
	intersectsOrTouches(other: OffsetRange): boolean { return Math.max(this.start, other.start) <= Math.min(this.endExclusive, other.endExclusive); }
	isBefore(other: OffsetRange): boolean { return this.endExclusive <= other.start; }
	isAfter(other: OffsetRange): boolean { return this.start >= other.endExclusive; }
	slice<T>(array: readonly T[]): T[] { return array.slice(this.start, this.endExclusive); }
	substring(value: string): string { return value.substring(this.start, this.endExclusive); }
	clip(value: number): number { if (this.isEmpty) throw new RangeError("Cannot clip to an empty range"); return Math.max(this.start, Math.min(this.endExclusive - 1, value)); }
	clipCyclic(value: number): number { if (this.isEmpty) throw new RangeError("Cannot clip to an empty range"); if (value < this.start) return this.endExclusive - ((this.start - value) % this.length); if (value >= this.endExclusive) return this.start + ((value - this.start) % this.length); return value; }
	map<T>(map: (offset: number) => T): T[] { const result: T[] = []; this.forEach(offset => result.push(map(offset))); return result; }
	forEach(callback: (offset: number) => void): void { for (let offset = this.start; offset < this.endExclusive; offset += 1) callback(offset); }
	withMargin(margin: number): OffsetRange;
	withMargin(startMargin: number, endMargin: number): OffsetRange;
	withMargin(startMargin: number, endMargin: number = startMargin): OffsetRange { return new OffsetRange(this.start - startMargin, this.endExclusive + endMargin); }
	joinRightTouching(other: OffsetRange): OffsetRange { if (this.endExclusive !== other.start) throw new RangeError("Offset ranges are not touching"); return new OffsetRange(this.start, other.endExclusive); }
	toString() { return `[${this.start}, ${this.endExclusive})`; }
}

export class OffsetRangeSet {
	private readonly _sortedRanges: OffsetRange[] = [];

	get ranges(): OffsetRange[] { return this._sortedRanges; }
	get length(): number { return this._sortedRanges.reduce((total, range) => total + range.length, 0); }

	addRange(range: OffsetRange): void {
		let start = 0;
		while (start < this._sortedRanges.length && this._sortedRanges[start].endExclusive < range.start) start += 1;
		let end = start;
		while (end < this._sortedRanges.length && this._sortedRanges[end].start <= range.endExclusive) end += 1;
		if (start === end) this._sortedRanges.splice(start, 0, range);
		else this._sortedRanges.splice(start, end - start, new OffsetRange(Math.min(range.start, this._sortedRanges[start].start), Math.max(range.endExclusive, this._sortedRanges[end - 1].endExclusive)));
	}

	intersectsStrict(other: OffsetRange): boolean { return this._sortedRanges.some(range => range.intersects(other)); }
	intersectWithRange(other: OffsetRange): OffsetRangeSet { const result = new OffsetRangeSet(); for (const range of this._sortedRanges) { const intersection = range.intersect(other); if (intersection) result.addRange(intersection); } return result; }
	intersectWithRangeLength(other: OffsetRange): number { return this.intersectWithRange(other).length; }
	toString(): string { return this._sortedRanges.map(range => range.toString()).join(", "); }
}
