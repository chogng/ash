import type { Comparator } from '../../../../base/common/arrays.js';
import { type IRange, Range } from '../range.js';
import { OffsetRange } from './offsetRange.js';

/** A one-based half-open range of line numbers. */
export class LineRange {
	public readonly startLineNumber: number;
	public readonly endLineNumberExclusive: number;
	static readonly compareByStart: Comparator<LineRange> = (left, right) => left.startLineNumber - right.startLineNumber;
	static ofLength(startLineNumber: number, length: number): LineRange { return new LineRange(startLineNumber, startLineNumber + length); }
	static fromRange(range: IRange): LineRange { return new LineRange(range.startLineNumber, range.endLineNumber); }
	static fromRangeInclusive(range: IRange): LineRange { return new LineRange(range.startLineNumber, range.endLineNumber + 1); }
	static joinMany(lineRanges: readonly (readonly LineRange[])[]): readonly LineRange[] { return lineRanges.reduce<LineRangeSet>((set, ranges) => set.getUnion(new LineRangeSet([...ranges])), new LineRangeSet()).ranges; }
	static join(ranges: LineRange[]): LineRange {
		if (ranges.length === 0) throw new RangeError('Cannot join an empty line range list');
		return new LineRange(Math.min(...ranges.map(range => range.startLineNumber)), Math.max(...ranges.map(range => range.endLineNumberExclusive)));
	}
	static deserialize(value: ISerializedLineRange): LineRange { return new LineRange(value[0], value[1]); }
	static subtract(left: LineRange, right: LineRange | undefined): LineRange[] {
		if (!right) return [left];
		if (right.endLineNumberExclusive <= left.startLineNumber || left.endLineNumberExclusive <= right.startLineNumber) return [left];
		const result: LineRange[] = [];
		if (left.startLineNumber < right.startLineNumber) result.push(new LineRange(left.startLineNumber, right.startLineNumber));
		if (right.endLineNumberExclusive < left.endLineNumberExclusive) result.push(new LineRange(right.endLineNumberExclusive, left.endLineNumberExclusive));
		return result;
	}

	constructor(startLineNumber: number, endLineNumberExclusive: number) {
		if (!Number.isSafeInteger(startLineNumber) || !Number.isSafeInteger(endLineNumberExclusive) || startLineNumber > endLineNumberExclusive) throw new RangeError('Invalid line range');
		this.startLineNumber = startLineNumber;
		this.endLineNumberExclusive = endLineNumberExclusive;
	}

	get length(): number { return this.endLineNumberExclusive - this.startLineNumber; }
	get isEmpty(): boolean { return this.length === 0; }
	contains(lineNumber: number): boolean { return this.startLineNumber <= lineNumber && lineNumber < this.endLineNumberExclusive; }
	containsRange(range: LineRange): boolean { return this.startLineNumber <= range.startLineNumber && range.endLineNumberExclusive <= this.endLineNumberExclusive; }
	delta(offset: number): LineRange { return new LineRange(this.startLineNumber + offset, this.endLineNumberExclusive + offset); }
	deltaLength(offset: number): LineRange { return new LineRange(this.startLineNumber, this.endLineNumberExclusive + offset); }
	join(other: LineRange): LineRange { return new LineRange(Math.min(this.startLineNumber, other.startLineNumber), Math.max(this.endLineNumberExclusive, other.endLineNumberExclusive)); }
	intersect(other: LineRange): LineRange | undefined { const start = Math.max(this.startLineNumber, other.startLineNumber); const end = Math.min(this.endLineNumberExclusive, other.endLineNumberExclusive); return start <= end ? new LineRange(start, end) : undefined; }
	intersectsStrict(other: LineRange): boolean { return this.startLineNumber < other.endLineNumberExclusive && other.startLineNumber < this.endLineNumberExclusive; }
	intersectsOrTouches(other: LineRange): boolean { return this.startLineNumber <= other.endLineNumberExclusive && other.startLineNumber <= this.endLineNumberExclusive; }
	equals(other: LineRange): boolean { return this.startLineNumber === other.startLineNumber && this.endLineNumberExclusive === other.endLineNumberExclusive; }
	toOffsetRange(): OffsetRange { return new OffsetRange(this.startLineNumber - 1, this.endLineNumberExclusive - 1); }
	toInclusiveRange(): Range | null { return this.isEmpty ? null : new Range(this.startLineNumber, 1, this.endLineNumberExclusive - 1, Number.MAX_SAFE_INTEGER); }
	toExclusiveRange(): Range { return new Range(this.startLineNumber, 1, this.endLineNumberExclusive, 1); }
	serialize(): ISerializedLineRange { return [this.startLineNumber, this.endLineNumberExclusive]; }
	mapToLineArray<T>(map: (lineNumber: number) => T): T[] { const result: T[] = []; this.forEach(lineNumber => result.push(map(lineNumber))); return result; }
	forEach(callback: (lineNumber: number) => void): void { for (let lineNumber = this.startLineNumber; lineNumber < this.endLineNumberExclusive; lineNumber += 1) callback(lineNumber); }
	distanceToRange(other: LineRange): number { if (this.endLineNumberExclusive <= other.startLineNumber) return other.startLineNumber - this.endLineNumberExclusive; if (other.endLineNumberExclusive <= this.startLineNumber) return this.startLineNumber - other.endLineNumberExclusive; return 0; }
	distanceToLine(lineNumber: number): number { if (this.contains(lineNumber)) return 0; return lineNumber < this.startLineNumber ? this.startLineNumber - lineNumber : lineNumber - this.endLineNumberExclusive; }
	addMargin(top: number, bottom: number): LineRange { return new LineRange(this.startLineNumber - top, this.endLineNumberExclusive + bottom); }
	toString(): string { return `[${this.startLineNumber},${this.endLineNumberExclusive})`; }
}

export class LineRangeSet {
	constructor(private readonly _normalizedRanges: LineRange[] = []) { this._normalizedRanges.sort((left, right) => left.startLineNumber - right.startLineNumber); }
	get ranges(): readonly LineRange[] { return this._normalizedRanges; }
	addRange(range: LineRange): void {
		if (range.isEmpty) return;
		const ranges = [...this._normalizedRanges, range].sort((left, right) => left.startLineNumber - right.startLineNumber);
		this._normalizedRanges.length = 0;
		for (const candidate of ranges) {
			const previous = this._normalizedRanges.at(-1);
			if (previous && previous.endLineNumberExclusive >= candidate.startLineNumber) this._normalizedRanges[this._normalizedRanges.length - 1] = previous.join(candidate);
			else this._normalizedRanges.push(candidate);
		}
	}
	contains(lineNumber: number): boolean { return this._normalizedRanges.some(range => range.contains(lineNumber)); }
	intersects(range: LineRange): boolean { return this._normalizedRanges.some(candidate => candidate.intersectsStrict(range)); }
	getUnion(other: LineRangeSet): LineRangeSet { const result = new LineRangeSet([...this.ranges]); for (const range of other.ranges) result.addRange(range); return result; }
	subtractFrom(range: LineRange): LineRangeSet { let result = [range]; for (const candidate of this._normalizedRanges) result = result.flatMap(current => LineRange.subtract(current, candidate)); return new LineRangeSet(result); }
	getIntersection(other: LineRangeSet): LineRangeSet { const result = new LineRangeSet(); for (const left of this._normalizedRanges) for (const right of other._normalizedRanges) { const intersection = left.intersect(right); if (intersection && !intersection.isEmpty) result.addRange(intersection); } return result; }
	getWithDelta(delta: number): LineRangeSet { return new LineRangeSet(this._normalizedRanges.map(range => range.delta(delta))); }
	toString() { return this._normalizedRanges.map(range => range.toString()).join(', '); }
}

export type ISerializedLineRange = [startLineNumber: number, endLineNumberExclusive: number];
