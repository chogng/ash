import { LineRange } from "../ranges/lineRange.js";
import { splitLines } from '../../../../base/common/strings.js';
import { Position } from "../position.js";
import { Range } from "../range.js";
import { AbstractText } from "../text/abstractText.js";
import { BaseStringEdit, StringEdit, StringReplacement } from "./stringEdit.js";
import { TextEdit, TextReplacement } from "./textEdit.js";

/** A line-oriented edit used by diff, folding, and line operations. */
export class LineEdit {
	static readonly empty = new LineEdit([]);
	static deserialize(data: SerializedLineEdit): LineEdit { return new LineEdit(data.map(replacement => LineReplacement.deserialize(replacement))); }
	static fromTextEdit(edit: TextEdit, initialValue: AbstractText): LineEdit {
		const result: LineReplacement[] = [];
		let current: TextReplacement[] = [];
		for (let index = 0; index < edit.replacements.length; index += 1) {
			const replacement = edit.replacements[index]!;
			current.push(replacement);
			const next = edit.replacements[index + 1];
			if (next && next.range.startLineNumber === replacement.range.endLineNumber) continue;
			const combined = TextReplacement.joinReplacements(current, initialValue);
			result.push(LineReplacement.fromSingleTextEdit(combined, initialValue));
			current = [];
		}
		return new LineEdit(result);
	}
	static fromStringEdit(edit: BaseStringEdit, initialValue: AbstractText): LineEdit { return LineEdit.fromTextEdit(TextEdit.fromStringEdit(edit, initialValue), initialValue); }
	static createFromUnsorted(edits: readonly LineReplacement[]): LineEdit { return new LineEdit([...edits].sort((left, right) => left.lineRange.startLineNumber - right.lineRange.startLineNumber)); }

	constructor(readonly replacements: readonly LineReplacement[]) {
		for (let index = 1; index < replacements.length; index += 1) if (replacements[index - 1]!.lineRange.endLineNumberExclusive > replacements[index]!.lineRange.startLineNumber) throw new RangeError("Line edits must be sorted and disjoint");
	}

	isEmpty(): boolean { return this.replacements.length === 0; }
	apply(lines: string[]): string[] {
		const result: string[] = [];
		let sourceLineIndex = 0;
		for (const replacement of this.replacements) {
			if (replacement.lineRange.endLineNumberExclusive > lines.length + 1) throw new RangeError("Line edit is outside the text source");
			while (sourceLineIndex < replacement.lineRange.startLineNumber - 1) result.push(lines[sourceLineIndex++]!);
			result.push(...replacement.newLines);
			sourceLineIndex = replacement.lineRange.endLineNumberExclusive - 1;
		}
		while (sourceLineIndex < lines.length) result.push(lines[sourceLineIndex++]!);
		return result;
	}

	inverse(originalLines: string[]): LineEdit {
		const inverse: LineReplacement[] = [];
		let delta = 0;
		for (const replacement of this.replacements) {
			inverse.push(new LineReplacement(new LineRange(replacement.lineRange.startLineNumber + delta, replacement.lineRange.startLineNumber + delta + replacement.newLines.length), originalLines.slice(replacement.lineRange.startLineNumber - 1, replacement.lineRange.endLineNumberExclusive - 1)));
			delta += replacement.newLines.length - replacement.lineRange.length;
		}
		return new LineEdit(inverse);
	}

	toEdit(initialValue: AbstractText): StringEdit { return new StringEdit(this.replacements.map(replacement => replacement.toSingleEdit(initialValue))); }
	serialize(): SerializedLineEdit { return this.replacements.map(replacement => replacement.serialize()); }
	getNewLineRanges(): LineRange[] { let delta = 0; return this.replacements.map(replacement => { const range = LineRange.ofLength(replacement.lineRange.startLineNumber + delta, replacement.newLines.length); delta += replacement.newLines.length - replacement.lineRange.length; return range; }); }
	mapLineNumber(lineNumber: number): number { let delta = 0; for (const replacement of this.replacements) { if (replacement.lineRange.endLineNumberExclusive > lineNumber) break; delta += replacement.newLines.length - replacement.lineRange.length; } return lineNumber + delta; }
	mapLineRange(range: LineRange): LineRange { return new LineRange(this.mapLineNumber(range.startLineNumber), this.mapLineNumber(range.endLineNumberExclusive)); }
	mapBackLineRange(range: LineRange, originalLines: string[]): LineRange { return this.inverse(originalLines).mapLineRange(range); }
	rebase(base: LineEdit): LineEdit { return new LineEdit(this.replacements.map(replacement => new LineReplacement(base.mapLineRange(replacement.lineRange), replacement.newLines))); }
	touches(other: LineEdit): boolean { return this.replacements.some(left => other.replacements.some(right => left.lineRange.intersectsOrTouches(right.lineRange))); }
	humanReadablePatch(originalLines: string[]): string {
		const result: string[] = [];
		let lineDelta = 0;
		for (const replacement of this.replacements) {
			for (let lineNumber = replacement.lineRange.startLineNumber; lineNumber < replacement.lineRange.endLineNumberExclusive; lineNumber += 1) {
				result.push(`- ${lineNumber.toString().padStart(3, ' ')}     ${originalLines[lineNumber - 1] ?? '[[[[[ WARNING: LINE DOES NOT EXIST ]]]]]'}`);
			}
			for (let index = 0; index < replacement.newLines.length; index += 1) {
				result.push(`+     ${(replacement.lineRange.startLineNumber + lineDelta + index).toString().padStart(3, ' ')} ${replacement.newLines[index]}`);
			}
			lineDelta += replacement.newLines.length - replacement.lineRange.length;
		}
		return result.join('\n');
	}
	toString(): string { return this.replacements.map(replacement => replacement.toString()).join(","); }
}

export type SerializedLineEdit = SerializedLineReplacement[];

export class LineReplacement {
	constructor(readonly lineRange: LineRange, readonly newLines: readonly string[]) {}

	static deserialize(value: SerializedLineReplacement): LineReplacement { return new LineReplacement(new LineRange(value[0], value[1]), value[2]); }
	static fromSingleTextEdit(edit: TextReplacement, initialValue: AbstractText): LineReplacement {

		const newLines = splitLines(edit.text);
		const prefix = initialValue.getLineAt(edit.range.startLineNumber).slice(0, edit.range.startColumn - 1);
		const suffix = initialValue.getLineAt(edit.range.endLineNumber).slice(edit.range.endColumn - 1);
		newLines[0] = prefix + newLines[0]!;
		newLines[newLines.length - 1] = newLines.at(-1)! + suffix;
		let startLine = edit.range.startLineNumber;
		let endLineExclusive = edit.range.endLineNumber + 1;
		if (edit.range.startColumn === initialValue.getLineLength(edit.range.startLineNumber) + 1 && newLines[0] === prefix) {
			startLine += 1;
			newLines.shift();
		}
		if (newLines.length > 0 && startLine < endLineExclusive && edit.range.endColumn === 1 && newLines.at(-1) === suffix) {
			endLineExclusive -= 1;
			newLines.pop();
		}
		return new LineReplacement(new LineRange(startLine, endLineExclusive), newLines);
	}

	toSingleTextEdit(initialValue: AbstractText): TextReplacement {
		const totalLines = initialValue.length.lineCount + 1;
		if (this.lineRange.endLineNumberExclusive > totalLines + 1) throw new RangeError("Line replacement is outside the text source");
		if (this.lineRange.isEmpty) {
			if (this.newLines.length === 0) return new TextReplacement(Range.fromPositions(new Position(this.lineRange.startLineNumber, 1)), "");
			if (this.lineRange.startLineNumber === totalLines + 1) {
				return new TextReplacement(Range.fromPositions(new Position(totalLines, initialValue.getLineLength(totalLines) + 1)), `\n${this.newLines.join("\n")}`);
			}
			return new TextReplacement(Range.fromPositions(new Position(this.lineRange.startLineNumber, 1)), `${this.newLines.join("\n")}\n`);
		}
		if (this.newLines.length === 0) {
			if (this.lineRange.endLineNumberExclusive === totalLines + 1) {
				const start = this.lineRange.startLineNumber === 1
					? new Position(1, 1)
					: new Position(this.lineRange.startLineNumber - 1, initialValue.getLineLength(this.lineRange.startLineNumber - 1) + 1);
				const end = new Position(totalLines, initialValue.getLineLength(totalLines) + 1);
				return new TextReplacement(Range.fromPositions(start, end), "");
			}
			return new TextReplacement(new Range(this.lineRange.startLineNumber, 1, this.lineRange.endLineNumberExclusive, 1), "");
		}
		const endLineNumber = this.lineRange.endLineNumberExclusive - 1;
		return new TextReplacement(new Range(this.lineRange.startLineNumber, 1, endLineNumber, initialValue.getLineLength(endLineNumber) + 1), this.newLines.join("\n"));
	}

	toSingleEdit(initialValue: AbstractText): StringReplacement {
		const replacement = this.toSingleTextEdit(initialValue);
		return new StringReplacement(initialValue.getTransformer().getOffsetRange(replacement.range), replacement.text);
	}

	serialize(): SerializedLineReplacement { return [this.lineRange.startLineNumber, this.lineRange.endLineNumberExclusive, this.newLines]; }
	removeCommonSuffixPrefixLines(initialValue: AbstractText): LineReplacement {
		let startLineNumber = this.lineRange.startLineNumber;
		let endLineNumberExclusive = this.lineRange.endLineNumberExclusive;
		let trimStartCount = 0;
		while (startLineNumber < endLineNumberExclusive && trimStartCount < this.newLines.length && this.newLines[trimStartCount] === initialValue.getLineAt(startLineNumber)) {
			startLineNumber += 1;
			trimStartCount += 1;
		}
		let trimEndCount = 0;
		while (startLineNumber < endLineNumberExclusive && trimStartCount + trimEndCount < this.newLines.length && this.newLines[this.newLines.length - trimEndCount - 1] === initialValue.getLineAt(endLineNumberExclusive - 1)) {
			endLineNumberExclusive -= 1;
			trimEndCount += 1;
		}
		if (trimStartCount === 0 && trimEndCount === 0) return this;
		return new LineReplacement(new LineRange(startLineNumber, endLineNumberExclusive), this.newLines.slice(trimStartCount, this.newLines.length - trimEndCount));
	}
	toLineEdit(): LineEdit { return new LineEdit([this]); }
	toString(): string { return `${this.lineRange.toString()} -> ${JSON.stringify(this.newLines)}`; }
}

export type SerializedLineReplacement = [startLineNumber: number, endLineNumber: number, newLines: readonly string[]];
