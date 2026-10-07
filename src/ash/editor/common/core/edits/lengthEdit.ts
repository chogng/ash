import { OffsetRange } from "../ranges/offsetRange.js";
import { AnyEdit, BaseEdit, BaseReplacement } from "./edit.js";

/** An edit that records only how many values each range produces. */
export class LengthEdit extends BaseEdit<LengthReplacement, LengthEdit> {
	static readonly empty = new LengthEdit([]);
	static fromEdit(edit: AnyEdit): LengthEdit { return new LengthEdit(edit.replacements.map(replacement => new LengthReplacement(replacement.replaceRange, replacement.getNewLength()))); }
	static create(replacements: readonly LengthReplacement[]): LengthEdit { return new LengthEdit(replacements); }
	static single(replacement: LengthReplacement): LengthEdit { return new LengthEdit([replacement]); }
	static replace(range: OffsetRange, newLength: number): LengthEdit { return new LengthEdit([new LengthReplacement(range, newLength)]); }
	static insert(offset: number, newLength: number): LengthEdit { return LengthEdit.replace(OffsetRange.emptyAt(offset), newLength); }
	static delete(range: OffsetRange): LengthEdit { return LengthEdit.replace(range, 0); }
	static compose(edits: readonly LengthEdit[]): LengthEdit { return edits.reduce((result, edit) => result.compose(edit), LengthEdit.empty); }

	protected _createNew(replacements: readonly LengthReplacement[]): LengthEdit { return new LengthEdit(replacements); }

	inverse(): LengthEdit {
		const inverse: LengthReplacement[] = [];
		let delta = 0;
		for (const replacement of this.replacements) {
			inverse.push(new LengthReplacement(OffsetRange.ofStartAndLength(replacement.replaceRange.start + delta, replacement.newLength), replacement.replaceRange.length));
			delta += replacement.getLengthDelta();
		}
		return new LengthEdit(inverse);
	}

	applyArray<T>(data: readonly T[], fillValue: T): T[] {
		const result = new Array<T>(this.getNewDataLength(data.length));
		let sourceOffset = 0;
		let targetOffset = 0;
		for (const replacement of this.replacements) {
			while (sourceOffset < replacement.replaceRange.start) result[targetOffset++] = data[sourceOffset++];
			sourceOffset = replacement.replaceRange.endExclusive;
			for (let index = 0; index < replacement.newLength; index += 1) result[targetOffset++] = fillValue;
		}
		while (sourceOffset < data.length) result[targetOffset++] = data[sourceOffset++];
		return result;
	}
}

export class LengthReplacement extends BaseReplacement<LengthReplacement> {
	static create(start: number, endExclusive: number, newLength: number): LengthReplacement { return new LengthReplacement(new OffsetRange(start, endExclusive), newLength); }

	constructor(range: OffsetRange, readonly newLength: number) {
		super(range);
		if (!Number.isSafeInteger(newLength) || newLength < 0) throw new RangeError("Replacement length must be non-negative");
	}

	getNewLength(): number { return this.newLength; }
	equals(other: LengthReplacement): boolean { return this.replaceRange.equals(other.replaceRange) && this.newLength === other.newLength; }
	tryJoinTouching(other: LengthReplacement): LengthReplacement | undefined { return new LengthReplacement(this.replaceRange.joinRightTouching(other.replaceRange), this.newLength + other.newLength); }
	slice(range: OffsetRange, rangeInReplacement: OffsetRange): LengthReplacement { return new LengthReplacement(range, rangeInReplacement.length); }
	toString() { return `[${this.replaceRange.start}, +${this.replaceRange.length}) -> +${this.newLength}}`; }
}
