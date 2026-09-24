import { LineRange } from "../ranges/lineRange.js";
import { OffsetRange } from "../ranges/offsetRange.js";
import { Position } from "../position.js";
import { Range } from "../range.js";

/**
 * A non-negative text length represented as line breaks plus the final column.
 *
 * The representation is the same as the length of a text fragment: `lineCount`
 * is the number of `\n` characters and `columnCount` is the UTF-16 length after
 * the final line break. It is therefore safe to add lengths without knowing
 * the original line contents.
 */
export class TextLength {
	static readonly zero = new TextLength(0, 0);

	static lengthDiffNonNegative(start: TextLength, end: TextLength): TextLength {
		if (end.isLessThan(start)) return TextLength.zero;
		return start.lineCount === end.lineCount ? new TextLength(0, end.columnCount - start.columnCount) : new TextLength(end.lineCount - start.lineCount, end.columnCount);
	}

	static betweenPositions(start: Position, end: Position): TextLength {
		if (end.isBefore(start)) throw new RangeError("TextLength end must not precede its start");
		return start.lineNumber === end.lineNumber
			? new TextLength(0, end.column - start.column)
			: new TextLength(end.lineNumber - start.lineNumber, end.column - 1);
	}

	static fromPosition(position: Position): TextLength { return new TextLength(position.lineNumber - 1, position.column - 1); }
	static ofRange(range: Range) { return TextLength.betweenPositions(range.getStartPosition(), range.getEndPosition()); }
	static ofText(text: string): TextLength {
		let lineCount = 0;
		let columnCount = 0;
		for (const character of text) {
			if (character === '\n') {
				lineCount += 1;
				columnCount = 0;
			} else {
				columnCount += character.length;
			}
		}
		return new TextLength(lineCount, columnCount);
	}

	static ofSubstr(text: string, range: OffsetRange): TextLength { return TextLength.ofText(range.substring(text)); }
	static sum<T>(values: readonly T[], getLength: (f: T) => TextLength): TextLength {
		return values.reduce((length, value) => length.add(getLength(value)), TextLength.zero);
	}

	constructor(readonly lineCount: number, readonly columnCount: number) {
		if (!Number.isSafeInteger(lineCount) || !Number.isSafeInteger(columnCount) || lineCount < 0 || columnCount < 0) {
			throw new RangeError("TextLength values must be non-negative safe integers");
		}
	}

	isZero() { return this.lineCount === 0 && this.columnCount === 0; }
	isLessThan(other: TextLength): boolean { return this.compare(other) < 0; }
	isGreaterThan(other: TextLength): boolean { return this.compare(other) > 0; }
	isGreaterThanOrEqualTo(other: TextLength): boolean { return this.compare(other) >= 0; }
	equals(other: TextLength): boolean { return this.lineCount === other.lineCount && this.columnCount === other.columnCount; }
	compare(other: TextLength): number { return this.lineCount - other.lineCount || this.columnCount - other.columnCount; }

	add(other: TextLength): TextLength {
		return other.lineCount === 0
			? new TextLength(this.lineCount, this.columnCount + other.columnCount)
			: new TextLength(this.lineCount + other.lineCount, other.columnCount);
	}

	addToPosition(position: Position): Position {
		return this.lineCount === 0
			? new Position(position.lineNumber, position.column + this.columnCount)
			: new Position(position.lineNumber + this.lineCount, this.columnCount + 1);
	}

	addToRange(range: Range): Range { return Range.fromPositions(this.addToPosition(range.getStartPosition()), this.addToPosition(range.getEndPosition())); }
	createRange(start: Position): Range { return Range.fromPositions(start, this.addToPosition(start)); }
	toRange(): Range { return this.createRange(new Position(1, 1)); }
	toLineRange(): LineRange { return LineRange.ofLength(1, this.lineCount + 1); }
	toString() { return `${this.lineCount},${this.columnCount}`; }
}
