import { Range } from "../range.js";
import { ColumnRange } from "./columnRange.js";

export class RangeSingleLine {
	static fromRange(range: Range): RangeSingleLine | undefined {
		if (range.startLineNumber !== range.endLineNumber) return undefined;
		return new RangeSingleLine(range.startLineNumber, new ColumnRange(range.startColumn, range.endColumn));
	}

	constructor(readonly lineNumber: number, readonly columnRange: ColumnRange) {}

	toRange(): Range {
		return new Range(this.lineNumber, this.columnRange.startColumn, this.lineNumber, this.columnRange.endColumnExclusive);
	}
}
