import { Range } from "../range.js";
import { OffsetRange } from "./offsetRange.js";

/** A one-based half-open range of columns on one physical line. */
export class ColumnRange {
	static fromOffsetRange(range: OffsetRange): ColumnRange { return new ColumnRange(range.start + 1, range.endExclusive + 1); }

	constructor(readonly startColumn: number, readonly endColumnExclusive: number) {
		if (startColumn < 1 || startColumn > endColumnExclusive) throw new RangeError("Invalid column range");
	}

	toRange(lineNumber: number): Range { return new Range(lineNumber, this.startColumn, lineNumber, this.endColumnExclusive); }
	toZeroBasedOffsetRange(): OffsetRange { return new OffsetRange(this.startColumn - 1, this.endColumnExclusive - 1); }
	equals(other: ColumnRange): boolean { return this.startColumn === other.startColumn && this.endColumnExclusive === other.endColumnExclusive; }
}
