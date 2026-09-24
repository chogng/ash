import { LineRange } from "../ranges/lineRange.js";
import { OffsetRange } from "../ranges/offsetRange.js";
import { Position } from "../position.js";
import { Range } from "../range.js";
import { splitLines } from '../../../../base/common/strings.js';
import { PositionOffsetTransformer, PositionOffsetTransformerBase } from "./positionToOffsetImpl.js";
import { TextLength } from '../text/textLength.js';

/** A DOM-free text value that can expose slices in editor coordinates. */
export abstract class AbstractText {
	private _transformer: PositionOffsetTransformer | undefined;
	abstract readonly length: TextLength;
	abstract getValueOfRange(range: Range): string;

	get endPositionExclusive(): Position { return this.length.addToPosition(new Position(1, 1)); }
	get lineRange(): LineRange { return this.length.toLineRange(); }
	getValue(): string { return this.getValueOfRange(this.length.toRange()); }
	getValueOfOffsetRange(range: OffsetRange): string { return this.getValueOfRange(this.getTransformer().getRange(range)); }
	getLineLength(lineNumber: number): number { return this.getLineAt(lineNumber).length; }
	getLineAt(lineNumber: number): string { return this.getValueOfRange(new Range(lineNumber, 1, lineNumber, Number.MAX_SAFE_INTEGER)); }
	getLines(): string[] { return splitLines(this.getValue()); }
	getLinesOfRange(range: LineRange): string[] { return range.mapToLineArray(lineNumber => this.getLineAt(lineNumber)); }
	getTransformer(): PositionOffsetTransformerBase { return this._transformer ??= new PositionOffsetTransformer(this.getValue()); }
	equals(other: AbstractText): boolean { return this === other || this.getValue() === other.getValue(); }
}

/** An AbstractText view backed by a model-like line source. */
export class LineBasedText extends AbstractText {
	constructor(private readonly getLineContent: (lineNumber: number) => string, readonly lineCount: number) {
		super();
		if (!Number.isSafeInteger(lineCount) || lineCount < 1) throw new RangeError("A text source must contain at least one line");
	}

	get length(): TextLength {
		return new TextLength(this.lineCount - 1, this.getLineContent(this.lineCount).length);
	}

	getValueOfRange(range: Range): string {
		validateLineRange(range, this.lineCount);
		if (range.startLineNumber === range.endLineNumber) return this.getLineContent(range.startLineNumber).slice(range.startColumn - 1, range.endColumn - 1);
		let value = this.getLineContent(range.startLineNumber).slice(range.startColumn - 1);
		for (let lineNumber = range.startLineNumber + 1; lineNumber < range.endLineNumber; lineNumber += 1) value += `\n${this.getLineContent(lineNumber)}`;
		return `${value}\n${this.getLineContent(range.endLineNumber).slice(0, range.endColumn - 1)}`;
	}

	override getLineLength(lineNumber: number): number { return this.getLineContent(lineNumber).length; }
}

export class ArrayText extends LineBasedText {
	constructor(lines: string[]) {
		super(lineNumber => lines[lineNumber - 1], lines.length);
	}
}

/** A text view backed by one normalized JavaScript string. */
export class StringText extends AbstractText {
	private readonly _t;

	constructor(readonly value: string) {
		super();
		this._t = new PositionOffsetTransformer(this.value);
	}

	get length(): TextLength { return this._t.textLength; }
	getValueOfRange(range: Range): string { return this._t.getOffsetRange(range).substring(this.value); }
	override getTransformer() { return this._t; }
}

function validateLineRange(range: Range, lineCount: number): void {
	if (range.startLineNumber < 1 || range.endLineNumber > lineCount) throw new RangeError("Text range is outside the text source");
}
