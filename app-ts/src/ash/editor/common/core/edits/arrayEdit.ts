import { OffsetRange } from "../ranges/offsetRange.js";
import { BaseEdit, BaseReplacement } from "./edit.js";

/** A simultaneous edit over an array of values. */
export class ArrayEdit<T> extends BaseEdit<ArrayReplacement<T>, ArrayEdit<T>> {

	static readonly empty = new ArrayEdit<never>([]);

	static create<T>(replacements: readonly ArrayReplacement<T>[]): ArrayEdit<T> { return new ArrayEdit(replacements); }
	static single<T>(replacement: ArrayReplacement<T>): ArrayEdit<T> { return new ArrayEdit([replacement]); }
	static replace<T>(range: OffsetRange, value: readonly T[]): ArrayEdit<T> { return new ArrayEdit([new ArrayReplacement(range, value)]); }
	static insert<T>(offset: number, value: readonly T[]): ArrayEdit<T> { return ArrayEdit.replace(OffsetRange.emptyAt(offset), value); }
	static delete<T>(range: OffsetRange): ArrayEdit<T> { return ArrayEdit.replace(range, []); }

	protected _createNew(replacements: readonly ArrayReplacement<T>[]): ArrayEdit<T> { return new ArrayEdit(replacements); }

	apply(data: readonly T[]): readonly T[] {
		const result: T[] = [];
		let sourceOffset = 0;
		for (const replacement of this.replacements) {
			result.push(...data.slice(sourceOffset, replacement.replaceRange.start));
			result.push(...replacement.newValue);
			sourceOffset = replacement.replaceRange.endExclusive;
		}
		result.push(...data.slice(sourceOffset));
		return result;
	}

	inverse(original: readonly T[]): ArrayEdit<T> {
		const inverse: ArrayReplacement<T>[] = [];
		let delta = 0;
		for (const replacement of this.replacements) {
			inverse.push(new ArrayReplacement(OffsetRange.ofStartAndLength(replacement.replaceRange.start + delta, replacement.newValue.length), original.slice(replacement.replaceRange.start, replacement.replaceRange.endExclusive)));
			delta += replacement.getLengthDelta();
		}
		return new ArrayEdit(inverse);
	}
}

export class ArrayReplacement<T> extends BaseReplacement<ArrayReplacement<T>> {
	constructor(range: OffsetRange, readonly newValue: readonly T[]) { super(range); }
	getNewLength(): number { return this.newValue.length; }
	equals(other: ArrayReplacement<T>): boolean { return this.replaceRange.equals(other.replaceRange) && this.newValue.length === other.newValue.length && this.newValue.every((value, index) => value === other.newValue[index]); }
	tryJoinTouching(other: ArrayReplacement<T>): ArrayReplacement<T> | undefined { return new ArrayReplacement(this.replaceRange.joinRightTouching(other.replaceRange), [...this.newValue, ...other.newValue]); }
	slice(range: OffsetRange, rangeInReplacement: OffsetRange): ArrayReplacement<T> { return new ArrayReplacement(range, rangeInReplacement.slice(this.newValue)); }
}
