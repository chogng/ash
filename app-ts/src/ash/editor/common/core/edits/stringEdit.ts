import { commonPrefixLength, commonSuffixLength } from "../../../../base/common/strings.js";
import { OffsetRange } from "../ranges/offsetRange.js";
import { StringText } from "../text/abstractText.js";
import { BaseEdit, BaseReplacement } from "./edit.js";

/** String-specialized edit operations, including inverse and rebase helpers. */
export abstract class BaseStringEdit<T extends BaseStringReplacement<T> = BaseStringReplacement<any>, TEdit extends BaseStringEdit<T, TEdit> = BaseStringEdit<any, any>> extends BaseEdit<T, TEdit> {
	get TReplacement(): T {
		throw new Error('TReplacement is not defined for BaseStringEdit');
	}

	static trySwap(first: BaseStringEdit, second: BaseStringEdit): { e1: StringEdit; e2: StringEdit } | undefined {
		const firstInverse = first.inverseOnSlice((start, endEx) => " ".repeat(endEx - start));
		const rebasedFirst = second.tryRebase(firstInverse);
		if (!rebasedFirst) return undefined;
		const rebasedSecond = first.tryRebase(rebasedFirst);
		return rebasedSecond ? { e1: rebasedFirst, e2: rebasedSecond } : undefined;
	}

	apply(base: string): string {
		const result: string[] = [];
		let sourceOffset = 0;
		for (const replacement of this.replacements) {
			result.push(base.slice(sourceOffset, replacement.replaceRange.start), replacement.newText);
			sourceOffset = replacement.replaceRange.endExclusive;
		}
		result.push(base.slice(sourceOffset));
		return result.join("");
	}

	applyOnText(text: StringText): StringText { return new StringText(this.apply(text.value)); }

	inverseOnSlice(getOriginalSlice: (start: number, endEx: number) => string): StringEdit {
		const inverse: StringReplacement[] = [];
		let delta = 0;
		for (const replacement of this.replacements) {
			inverse.push(new StringReplacement(OffsetRange.ofStartAndLength(replacement.replaceRange.start + delta, replacement.newText.length), getOriginalSlice(replacement.replaceRange.start, replacement.replaceRange.endExclusive)));
			delta += replacement.getLengthDelta();
		}
		return new StringEdit(inverse);
	}

	inverse(original: string): StringEdit { return this.inverseOnSlice((start, endExclusive) => original.slice(start, endExclusive)); }

	tryRebase(base: StringEdit): StringEdit | undefined { return this._tryRebase(base, true); }
	rebaseSkipConflicting(base: StringEdit): StringEdit { return this._tryRebase(base, false)!; }

	private _tryRebase(base: StringEdit, failOnConflict: boolean): StringEdit | undefined {
		const rebased: StringReplacement[] = [];
		let baseIndex = 0;
		let ownIndex = 0;
		let delta = 0;
		while (ownIndex < this.replacements.length) {
			const own = this.replacements[ownIndex]!;
			const baseReplacement = base.replacements[baseIndex];
			if (!baseReplacement) {
				rebased.push(new StringReplacement(own.replaceRange.delta(delta), own.newText));
				ownIndex += 1;
			} else if (own.replaceRange.intersects(baseReplacement.replaceRange) || areConcurrentInserts(own.replaceRange, baseReplacement.replaceRange) || isInsertStrictlyInsideRange(own.replaceRange, baseReplacement.replaceRange) || isInsertStrictlyInsideRange(baseReplacement.replaceRange, own.replaceRange)) {
				ownIndex += 1;
				if (failOnConflict) return undefined;
			} else if (own.replaceRange.start < baseReplacement.replaceRange.start || own.replaceRange.isEmpty && own.replaceRange.start === baseReplacement.replaceRange.start) {
				rebased.push(new StringReplacement(own.replaceRange.delta(delta), own.newText));
				ownIndex += 1;
			} else {
				baseIndex += 1;
				delta += baseReplacement.getLengthDelta();
			}
		}
		return new StringEdit(rebased);
	}

	removeCommonSuffixAndPrefix(source: string): TEdit { return this._createNew(this.replacements.map(replacement => replacement.removeCommonSuffixAndPrefix(source))).normalize(); }
	removeCommonSuffixPrefix(source: string): StringEdit {
		return new StringEdit(this.replacements.map(replacement => replacement.removeCommonSuffixPrefix(source)).filter(replacement => !replacement.isEmpty));
	}
	normalizeOnSource(source: string): StringEdit {
		const normalized = StringReplacement.replace(OffsetRange.ofLength(source.length), this.apply(source)).removeCommonSuffixAndPrefix(source);
		return normalized.isEmpty ? StringEdit.empty : normalized.toEdit();
	}
	normalizeEOL(eol: '\r\n' | '\n'): StringEdit { return new StringEdit(this.replacements.map(replacement => replacement.normalizeEOL(eol))); }
	toJson(): ISerializedStringEdit { return this.replacements.map(replacement => replacement.toJson()); }
	isNeutralOn(source: string): boolean { return this.replacements.every(replacement => replacement.isNeutralOn(source)); }
	mapData<TData extends IEditData<TData>>(map: (replacement: T) => TData): AnnotatedStringEdit<TData> {
		return new AnnotatedStringEdit(this.replacements.map(replacement => new AnnotatedStringReplacement(replacement.replaceRange, replacement.newText, map(replacement))));
	}

	static composeOrUndefined<T extends BaseStringEdit<any, any>>(edits: readonly T[]): T | undefined {
		if (edits.length === 0) return undefined;
		let result = edits[0]!;
		for (let index = 1; index < edits.length; index += 1) result = result.compose(edits[index]!) as T;
		return result;
	}
}

export abstract class BaseStringReplacement<T extends BaseStringReplacement<T> = BaseStringReplacement<any>> extends BaseReplacement<T> {
	constructor(range: OffsetRange, readonly newText: string) { super(range); }
	getNewLength(): number { return this.newText.length; }
	replace(value: string): string { return value.slice(0, this.replaceRange.start) + this.newText + value.slice(this.replaceRange.endExclusive); }
	isNeutralOn(value: string): boolean { return this.newText === this.replaceRange.substring(value); }
	removeCommonSuffixAndPrefix(source: string): T { return this.removeCommonSuffix(source).removeCommonPrefix(source); }
	removeCommonPrefix(source: string): T {
		const oldText = this.replaceRange.substring(source);
		const prefixLength = commonPrefixLength(oldText, this.newText);
		return this.slice(this.replaceRange.deltaStart(prefixLength), new OffsetRange(prefixLength, this.newText.length));
	}
	removeCommonSuffix(source: string): T {
		const oldText = this.replaceRange.substring(source);
		const suffixLength = commonSuffixLength(oldText, this.newText);
		return this.slice(this.replaceRange.deltaEnd(-suffixLength), new OffsetRange(0, this.newText.length - suffixLength));
	}
	normalizeEOL(eol: '\r\n' | '\n'): StringReplacement { return new StringReplacement(this.replaceRange, this.newText.replace(/\r\n|\n/g, eol)); }
	removeCommonSuffixPrefix(source: string): StringReplacement {
		const oldText = this.replaceRange.substring(source);
		const prefixLength = commonPrefixLength(oldText, this.newText);
		const suffixLength = Math.min(oldText.length - prefixLength, this.newText.length - prefixLength, commonSuffixLength(oldText, this.newText));
		return new StringReplacement(new OffsetRange(this.replaceRange.start + prefixLength, this.replaceRange.endExclusive - suffixLength), this.newText.substring(prefixLength, this.newText.length - suffixLength));
	}
	toEdit(): StringEdit { return new StringEdit([this as unknown as StringReplacement]); }
	toJson(): ISerializedStringReplacement { return { txt: this.newText, pos: this.replaceRange.start, len: this.replaceRange.length }; }
	toString(): string { return `${this.replaceRange.toString()} -> ${JSON.stringify(this.newText)}`; }
}

export class StringEdit extends BaseStringEdit<StringReplacement, StringEdit> {
	static readonly empty = new StringEdit([]);
	static create(replacements: readonly StringReplacement[]): StringEdit { return new StringEdit(replacements); }
	static single(replacement: StringReplacement): StringEdit { return new StringEdit([replacement]); }
	static replace(range: OffsetRange, text: string): StringEdit { return new StringEdit([new StringReplacement(range, text)]); }
	static insert(offset: number, text: string): StringEdit { return StringEdit.replace(OffsetRange.emptyAt(offset), text); }
	static delete(range: OffsetRange): StringEdit { return StringEdit.replace(range, ""); }
	static parse(value: string): StringEdit {
		const replacements: StringReplacement[] = [];
		const matcher = /\[(\d+),\s*(\d+)\)\s*->\s*"((?:\\.|[^"\\])*)"/g;
		for (const match of value.matchAll(matcher)) replacements.push(new StringReplacement(new OffsetRange(Number(match[1]), Number(match[2])), JSON.parse(`"${match[3]}"`)));
		return new StringEdit(replacements);
	}
	static fromJson(value: ISerializedStringEdit): StringEdit { return new StringEdit(value.map(StringReplacement.fromJson)); }
	static compose(edits: readonly StringEdit[]): StringEdit { return edits.reduce((result, edit) => result.compose(edit), StringEdit.empty); }
	static composeSequentialReplacements(replacements: readonly StringReplacement[]): StringEdit {
		let result = StringEdit.empty;
		let batch: StringReplacement[] = [];
		for (const replacement of replacements) {
			const previous = batch.at(-1);
			if (!previous || replacement.replaceRange.isBefore(previous.replaceRange)) batch.push(replacement);
			else {
				result = result.compose(new StringEdit(batch.reverse()));
				batch = [replacement];
			}
		}
		return result.compose(new StringEdit(batch.reverse()));
	}

	constructor(replacements: readonly StringReplacement[]) { super(replacements); }
	protected _createNew(replacements: readonly StringReplacement[]): StringEdit { return new StringEdit(replacements); }
}

export type ISerializedStringEdit = ISerializedStringReplacement[];
export interface ISerializedStringReplacement { readonly txt: string; readonly pos: number; readonly len: number; }

export class StringReplacement extends BaseStringReplacement<StringReplacement> {
	static insert(offset: number, text: string): StringReplacement { return new StringReplacement(OffsetRange.emptyAt(offset), text); }
	static replace(range: OffsetRange, text: string): StringReplacement { return new StringReplacement(range, text); }
	static delete(range: OffsetRange): StringReplacement { return new StringReplacement(range, ""); }
	static fromJson(value: ISerializedStringReplacement): StringReplacement { return new StringReplacement(OffsetRange.ofStartAndLength(value.pos, value.len), value.txt); }

	equals(other: StringReplacement): boolean { return this.replaceRange.equals(other.replaceRange) && this.newText === other.newText; }
	tryJoinTouching(other: StringReplacement): StringReplacement | undefined { return new StringReplacement(this.replaceRange.joinRightTouching(other.replaceRange), this.newText + other.newText); }
	slice(range: OffsetRange, rangeInReplacement?: OffsetRange): StringReplacement { return new StringReplacement(range, rangeInReplacement?.substring(this.newText) ?? this.newText); }
}

export function applyEditsToRanges(sortedRanges: OffsetRange[], edit: StringEdit): OffsetRange[] {
	const pending = [...sortedRanges];
	const result: OffsetRange[] = [];
	let delta = 0;
	for (const replacement of edit.replacements) {
		while (pending.length > 0 && pending[0]!.endExclusive < replacement.replaceRange.start) result.push(pending.shift()!.delta(delta));
		const intersecting: OffsetRange[] = [];
		while (pending.length > 0 && pending[0]!.intersectsOrTouches(replacement.replaceRange)) intersecting.push(pending.shift()!);
		for (let index = intersecting.length - 1; index >= 0; index -= 1) {
			let range = intersecting[index]!;
			const overlap = range.intersect(replacement.replaceRange)?.length ?? 0;
			range = range.deltaEnd(-overlap + (index === 0 ? replacement.newText.length : 0));
			const ahead = range.start - replacement.replaceRange.start;
			if (ahead > 0) range = range.delta(-ahead);
			if (index !== 0) range = range.delta(replacement.newText.length);
			range = range.delta(-replacement.getLengthDelta());
			pending.unshift(range);
		}
		delta += replacement.getLengthDelta();
	}
	while (pending.length > 0) result.push(pending.shift()!.delta(delta));
	return result;
}

export interface IEditData<T> { join(other: T): T | undefined; }
export class VoidEditData implements IEditData<VoidEditData> { join(_other: VoidEditData): VoidEditData | undefined { return this; } }

export class AnnotatedStringEdit<T extends IEditData<T>> extends BaseStringEdit<AnnotatedStringReplacement<T>, AnnotatedStringEdit<T>> {
	static readonly empty = new AnnotatedStringEdit<never>([]);
	static create<T extends IEditData<T>>(replacements: readonly AnnotatedStringReplacement<T>[]): AnnotatedStringEdit<T> { return new AnnotatedStringEdit(replacements); }
	static single<T extends IEditData<T>>(replacement: AnnotatedStringReplacement<T>): AnnotatedStringEdit<T> { return new AnnotatedStringEdit([replacement]); }
	static replace<T extends IEditData<T>>(range: OffsetRange, text: string, data: T): AnnotatedStringEdit<T> { return new AnnotatedStringEdit([new AnnotatedStringReplacement(range, text, data)]); }
	static insert<T extends IEditData<T>>(offset: number, text: string, data: T): AnnotatedStringEdit<T> { return AnnotatedStringEdit.replace(OffsetRange.emptyAt(offset), text, data); }
	static delete<T extends IEditData<T>>(range: OffsetRange, data: T): AnnotatedStringEdit<T> { return AnnotatedStringEdit.replace(range, "", data); }
	static compose<T extends IEditData<T>>(edits: readonly AnnotatedStringEdit<T>[]): AnnotatedStringEdit<T> { return edits.reduce((result, edit) => result.compose(edit), AnnotatedStringEdit.empty as AnnotatedStringEdit<T>); }
	constructor(replacements: readonly AnnotatedStringReplacement<T>[]) { super(replacements); }
	protected _createNew(replacements: readonly AnnotatedStringReplacement<T>[]): AnnotatedStringEdit<T> { return new AnnotatedStringEdit(replacements); }
	toStringEdit(filter?: (replacement: AnnotatedStringReplacement<T>) => boolean): StringEdit { return new StringEdit(this.replacements.filter(replacement => !filter || filter(replacement)).map(replacement => new StringReplacement(replacement.replaceRange, replacement.newText))); }
}

export class AnnotatedStringReplacement<T extends IEditData<T>> extends BaseStringReplacement<AnnotatedStringReplacement<T>> {
	static insert<T extends IEditData<T>>(offset: number, text: string, data: T): AnnotatedStringReplacement<T> { return new AnnotatedStringReplacement(OffsetRange.emptyAt(offset), text, data); }
	static replace<T extends IEditData<T>>(range: OffsetRange, text: string, data: T): AnnotatedStringReplacement<T> { return new AnnotatedStringReplacement(range, text, data); }
	static delete<T extends IEditData<T>>(range: OffsetRange, data: T): AnnotatedStringReplacement<T> { return new AnnotatedStringReplacement(range, '', data); }
	constructor(range: OffsetRange, newText: string, readonly data: T) { super(range, newText); }
	equals(other: AnnotatedStringReplacement<T>): boolean { return this.replaceRange.equals(other.replaceRange) && this.newText === other.newText && this.data === other.data; }
	tryJoinTouching(other: AnnotatedStringReplacement<T>): AnnotatedStringReplacement<T> | undefined { const data = this.data.join(other.data); return data === undefined ? undefined : new AnnotatedStringReplacement(this.replaceRange.joinRightTouching(other.replaceRange), this.newText + other.newText, data); }
	slice(range: OffsetRange, rangeInReplacement?: OffsetRange): AnnotatedStringReplacement<T> { return new AnnotatedStringReplacement(range, rangeInReplacement?.substring(this.newText) ?? this.newText, this.data); }
}

function areConcurrentInserts(left: OffsetRange, right: OffsetRange): boolean { return left.isEmpty && right.isEmpty && left.start === right.start; }
function isInsertStrictlyInsideRange(insert: OffsetRange, range: OffsetRange): boolean { return insert.isEmpty && range.start < insert.start && insert.start < range.endExclusive; }
