import { commonPrefixLength, commonSuffixLength, isHighSurrogate, isLowSurrogate } from "../../../../base/common/strings.js";
import { Position } from "../position.js";
import { Range } from "../range.js";
import { TextLength } from "../text/textLength.js";
import { AbstractText, StringText } from "../text/abstractText.js";
import type { ISingleEditOperation } from "../editOperation.js";
import { BaseStringEdit, StringEdit, StringReplacement } from "./stringEdit.js";

/** A text-coordinate replacement using one-based editor positions. */
export class TextReplacement {
	static delete(range: Range): TextReplacement { return new TextReplacement(range, ""); }
	static joinReplacements(replacements: TextReplacement[], initialValue: AbstractText): TextReplacement {
		if (replacements.length === 0) throw new RangeError('Cannot join an empty replacement list');
		if (replacements.length === 1) return replacements[0]!;
		const start = replacements[0]!.range.getStartPosition();
		const end = replacements.at(-1)!.range.getEndPosition();
		let text = '';
		for (let index = 0; index < replacements.length; index += 1) {
			const replacement = replacements[index]!;
			text += replacement.text;
			const next = replacements[index + 1];
			if (next) text += initialValue.getValueOfRange(Range.fromPositions(replacement.range.getEndPosition(), next.range.getStartPosition()));
		}
		return new TextReplacement(Range.fromPositions(start, end), text);
	}
	static fromStringReplacement(replacement: StringReplacement, initialState: AbstractText): TextReplacement { return new TextReplacement(initialState.getTransformer().getRange(replacement.replaceRange), replacement.newText); }
	static equals(first: TextReplacement, second: TextReplacement) { return first.range.equalsRange(second.range) && first.text === second.text; }

	constructor(readonly range: Range, readonly text: string) {}

	get isEmpty(): boolean { return this.range.isEmpty() && this.text.length === 0; }
	equals(other: TextReplacement): boolean { return TextReplacement.equals(this, other); }
	toSingleEditOperation(): ISingleEditOperation { return { range: this.range, text: this.text }; }
	toEdit(): TextEdit { return new TextEdit([this]); }

	extendToCoverRange(range: Range, initialValue: AbstractText): TextReplacement {
		if (this.range.containsRange(range)) return this;
		const expanded = this.range.plusRange(range);
		const before = initialValue.getValueOfRange(Range.fromPositions(expanded.getStartPosition(), this.range.getStartPosition()));
		const after = initialValue.getValueOfRange(Range.fromPositions(this.range.getEndPosition(), expanded.getEndPosition()));
		return new TextReplacement(expanded, before + this.text + after);
	}

	extendToFullLine(initialValue: AbstractText): TextReplacement {
		const endLine = this.range.getEndPosition().lineNumber;
		return this.extendToCoverRange(new Range(this.range.startLineNumber, 1, endLine, initialValue.getLineLength(endLine) + 1), initialValue);
	}

	removeCommonPrefixAndSuffix(text: AbstractText): TextReplacement { return this.removeCommonPrefix(text).removeCommonSuffix(text); }
	removeCommonPrefix(text: AbstractText): TextReplacement {
		const oldText = text.getValueOfRange(this.range);
		let prefixLength = commonPrefixLength(oldText, this.text);
		if (splitsSurrogatePair(oldText, prefixLength) || splitsSurrogatePair(this.text, prefixLength)) prefixLength--;
		const start = TextLength.ofText(oldText.slice(0, prefixLength)).addToPosition(this.range.getStartPosition());
		return new TextReplacement(Range.fromPositions(start, this.range.getEndPosition()), this.text.slice(prefixLength));
	}
	removeCommonSuffix(text: AbstractText): TextReplacement {
		const oldText = text.getValueOfRange(this.range);
		let suffixLength = commonSuffixLength(oldText, this.text);
		if (splitsSurrogatePair(oldText, oldText.length - suffixLength) || splitsSurrogatePair(this.text, this.text.length - suffixLength)) suffixLength--;
		const end = TextLength.ofText(oldText.slice(0, oldText.length - suffixLength)).addToPosition(this.range.getStartPosition());
		return new TextReplacement(Range.fromPositions(this.range.getStartPosition(), end), this.text.slice(0, this.text.length - suffixLength));
	}
	isEffectiveDeletion(text: AbstractText): boolean {
		const oldText = text.getValueOfRange(this.range);
		const prefixLength = commonPrefixLength(oldText, this.text);
		const oldRemaining = oldText.slice(prefixLength);
		const newRemaining = this.text.slice(prefixLength);
		const suffixLength = commonSuffixLength(oldRemaining, newRemaining);
		return newRemaining.slice(0, newRemaining.length - suffixLength).length === 0;
	}
	toString(): string { return `${this.range.toString()} -> ${JSON.stringify(this.text)}`; }
}

/** A sorted, disjoint set of text-coordinate replacements. */
export class TextEdit {
	static replace(range: Range, text: string): TextEdit { return new TextEdit([new TextReplacement(range, text)]); }
	static delete(range: Range): TextEdit { return TextEdit.replace(range, ""); }
	static insert(position: Position, text: string): TextEdit { return TextEdit.replace(Range.fromPositions(position), text); }
	static fromStringEdit(edit: BaseStringEdit, initialState: AbstractText): TextEdit { return new TextEdit(edit.replacements.map(replacement => TextReplacement.fromStringReplacement(replacement, initialState))); }
	static fromParallelReplacementsUnsorted(replacements: readonly TextReplacement[]): TextEdit { return new TextEdit([...replacements].sort((left, right) => Position.compare(left.range.getStartPosition(), right.range.getStartPosition()))); }

	constructor(readonly replacements: readonly TextReplacement[]) {
		for (let index = 1; index < replacements.length; index += 1) {
			if (Position.isBefore(replacements[index]!.range.getStartPosition(), replacements[index - 1]!.range.getEndPosition())) throw new RangeError("Text edits must be sorted and disjoint");
		}
	}

	normalize(): TextEdit {
		const normalized: TextReplacement[] = [];
		for (const replacement of this.replacements) {
			const previous = normalized.at(-1);
			if (previous && previous.range.getEndPosition().equals(replacement.range.getStartPosition())) normalized[normalized.length - 1] = new TextReplacement(previous.range.plusRange(replacement.range), previous.text + replacement.text);
			else if (!replacement.isEmpty) normalized.push(replacement);
		}
		return new TextEdit(normalized);
	}

	apply(text: AbstractText): string {
		const transformer = text.getTransformer();
		const stringEdit = new StringEdit(this.replacements.map(replacement => new StringReplacement(transformer.getOffsetRange(replacement.range), replacement.text)));
		return stringEdit.apply(text.getValue());
	}

	applyToString(value: string): string { return this.apply(new StringText(value)); }
	inverse(document: AbstractText): TextEdit { const newRanges = this.getNewRanges(); return new TextEdit(this.replacements.map((replacement, index) => new TextReplacement(newRanges[index]!, document.getValueOfRange(replacement.range)))); }
	inverseMapPosition(positionAfterEdit: Position, document: AbstractText): Position | Range { return this.inverse(document).mapPosition(positionAfterEdit); }
	inverseMapRange(range: Range, document: AbstractText): Range { return this.inverse(document).mapRange(range); }

	mapPosition(position: Position): Position | Range {
		let lineDelta = 0;
		let columnDeltaLineNumber = 0;
		let columnDelta = 0;
		const mapProcessedPosition = (value: Position): Position => new Position(
			value.lineNumber + lineDelta,
			value.column + (value.lineNumber === columnDeltaLineNumber ? columnDelta : 0),
		);
		for (const replacement of this.replacements) {
			const start = replacement.range.getStartPosition();
			if (position.isBeforeOrEqual(start)) break;
			const end = replacement.range.getEndPosition();
			const length = TextLength.ofText(replacement.text);
			const mappedStart = mapProcessedPosition(start);
			const mappedEnd = length.addToPosition(mappedStart);
			if (position.isBefore(end)) return Range.fromPositions(mappedStart, length.addToPosition(mappedStart));
			lineDelta = mappedEnd.lineNumber - end.lineNumber;
			columnDeltaLineNumber = end.lineNumber;
			columnDelta = mappedEnd.column - end.column;
		}
		return mapProcessedPosition(position);
	}

	mapRange(range: Range): Range {
		const start = this.mapPosition(range.getStartPosition());
		const end = this.mapPosition(range.getEndPosition());
		return Range.fromPositions(start instanceof Position ? start : start.getStartPosition(), end instanceof Position ? end : end.getEndPosition());
	}

	getNewRanges(): Range[] {
		return this.replacements.map(replacement => {
			const start = this.mapPosition(replacement.range.getStartPosition());
			const startPosition = start instanceof Position ? start : start.getStartPosition();
			return Range.fromPositions(startPosition, TextLength.ofText(replacement.text).addToPosition(startPosition));
		});
	}

	toReplacement(initialValue: AbstractText): TextReplacement {
		if (this.replacements.length === 0) throw new RangeError("Cannot convert an empty edit to a replacement");
		if (this.replacements.length === 1) return this.replacements[0]!;
		const start = this.replacements[0]!.range.getStartPosition();
		const end = this.replacements.at(-1)!.range.getEndPosition();
		let text = "";
		for (let index = 0; index < this.replacements.length; index += 1) {
			const replacement = this.replacements[index]!;
			text += replacement.text;
			if (index + 1 < this.replacements.length) text += initialValue.getValueOfRange(Range.fromPositions(replacement.range.getEndPosition(), this.replacements[index + 1]!.range.getStartPosition()));
		}
		return new TextReplacement(Range.fromPositions(start, end), text);
	}

	/** Composes edits through a synthetic source whose line geometry covers both operands. */
	compose(other: TextEdit): TextEdit {
		const source = new StringText(createSyntheticSource(this, other));
		const first = toStringEdit(this, source);
		const afterFirst = new StringText(first.apply(source.value));
		const second = toStringEdit(other, afterFirst);
		return TextEdit.fromStringEdit(first.compose(second), source);
	}

	equals(other: TextEdit): boolean { return this.replacements.length === other.replacements.length && this.replacements.every((replacement, index) => replacement.equals(other.replacements[index]!)); }
	toString(initialValue: AbstractText | string | undefined): string {
		if (initialValue === undefined) return this.replacements.map(replacement => replacement.toString()).join('\n');
		const text = typeof initialValue === 'string' ? new StringText(initialValue) : initialValue;
		return this.replacements.map(replacement => {
			const oldText = text.getValueOfRange(replacement.range);
			return `${replacement.range.toString()} ${JSON.stringify(oldText)} -> ${JSON.stringify(replacement.text)}`;
		}).join('\n');
	}
}

function splitsSurrogatePair(text: string, offset: number): boolean {
	return isHighSurrogate(text.charCodeAt(offset - 1)) && isLowSurrogate(text.charCodeAt(offset));
}

function toStringEdit(edit: TextEdit, initialState: AbstractText): StringEdit {
	const transformer = initialState.getTransformer();
	return new StringEdit(edit.replacements.map(replacement => new StringReplacement(transformer.getOffsetRange(replacement.range), replacement.text)));
}

function createSyntheticSource(first: TextEdit, second: TextEdit): string {
	const replacements = [...first.replacements, ...second.replacements];
	const maxLine = replacements.reduce((max, replacement) => Math.max(max, replacement.range.getEndPosition().lineNumber), 0);
	const maxColumn = replacements.reduce((max, replacement) => Math.max(max, replacement.range.getEndPosition().column), 0);
	const insertedLength = replacements.reduce((sum, replacement) => sum + replacement.text.length, 0);
	const lineCount = maxLine + 2 + replacements.reduce((sum, replacement) => sum + countNewlines(replacement.text), 0);
	const lineLength = Math.max(1, maxColumn + insertedLength + 2);
	return Array.from({ length: lineCount }, () => "x".repeat(lineLength)).join("\n");
}

function countNewlines(value: string): number { let count = 0; for (const character of value) if (character === "\n") count += 1; return count; }
