import { OffsetRange } from "../ranges/offsetRange.js";

/** Common contract for a replacement whose input and output have measurable length. */
export abstract class BaseReplacement<TSelf extends BaseReplacement<TSelf>> {
	constructor(readonly replaceRange: OffsetRange) {}

	abstract getNewLength(): number;
	abstract tryJoinTouching(other: TSelf): TSelf | undefined;
	abstract slice(newReplaceRange: OffsetRange, rangeInReplacement?: OffsetRange): TSelf;
	abstract equals(other: TSelf): boolean;

	delta(offset: number): TSelf { return this.slice(this.replaceRange.delta(offset), new OffsetRange(0, this.getNewLength())); }
	getLengthDelta(): number { return this.getNewLength() - this.replaceRange.length; }
	get isEmpty() { return this.replaceRange.isEmpty && this.getNewLength() === 0; }
	getRangeAfterReplace(): OffsetRange { return new OffsetRange(this.replaceRange.start, this.replaceRange.start + this.getNewLength()); }
	toString(): string { return `{ ${this.replaceRange.toString()} -> ${this.getNewLength()} }`; }
}

/** A sorted, disjoint set of replacements applied simultaneously. */
export abstract class BaseEdit<T extends BaseReplacement<T>, TEdit extends BaseEdit<T, TEdit>> {
	constructor(readonly replacements: readonly T[]) {
		let previousEnd = -1;
		for (const replacement of replacements) {
			if (replacement.replaceRange.start < previousEnd) throw new RangeError("Edits must be sorted and disjoint");
			previousEnd = replacement.replaceRange.endExclusive;
		}
	}

	protected abstract _createNew(replacements: readonly T[]): TEdit;

	equals(other: TEdit): boolean {
		return this.replacements.length === other.replacements.length && this.replacements.every((replacement, index) => replacement.equals(other.replacements[index]!));
	}

	isEmpty(): boolean { return this.replacements.length === 0; }
	getLengthDelta(): number { return this.replacements.reduce((sum, replacement) => sum + replacement.getLengthDelta(), 0); }
	getNewDataLength(dataLength: number): number { return dataLength + this.getLengthDelta(); }
	toString() { return `[${this.replacements.map(replacement => replacement.toString()).join(", ")}]`; }

	normalize(): TEdit {
		const normalized: T[] = [];
		let previous: T | undefined;
		for (const replacement of this.replacements) {
			if (replacement.isEmpty) continue;
			if (previous && previous.replaceRange.endExclusive === replacement.replaceRange.start) {
				const joined = previous.tryJoinTouching(replacement);
				if (joined) {
					previous = joined;
					continue;
				}
			}
			if (previous) normalized.push(previous);
			previous = replacement;
		}
		if (previous) normalized.push(previous);
		return this._createNew(normalized);
	}

	/** Composes this edit with an edit expressed in the result coordinate space. */
	compose(other: TEdit): TEdit {
		const first = this.normalize();
		const second = other.normalize();
		if (first.isEmpty()) return second;
		if (second.isEmpty()) return first;

		const pending = [...first.replacements];
		const result: T[] = [];
		let delta = 0;

		for (const secondReplacement of second.replacements) {
			while (true) {
				const firstReplacement = pending[0];
				if (!firstReplacement || firstReplacement.replaceRange.start + delta + firstReplacement.getNewLength() >= secondReplacement.replaceRange.start) break;
				pending.shift();
				result.push(firstReplacement);
				delta += firstReplacement.getLengthDelta();
			}

			const deltaBeforeIntersecting = delta;
			let firstIntersecting: T | undefined;
			let lastIntersecting: T | undefined;
			while (true) {
				const firstReplacement = pending[0];
				if (!firstReplacement || firstReplacement.replaceRange.start + delta > secondReplacement.replaceRange.endExclusive) break;
				firstIntersecting ??= firstReplacement;
				lastIntersecting = firstReplacement;
				pending.shift();
				delta += firstReplacement.getLengthDelta();
			}

			if (!firstIntersecting) {
				result.push(secondReplacement.delta(-delta));
				continue;
			}

			const newReplaceRangeStart = Math.min(firstIntersecting.replaceRange.start, secondReplacement.replaceRange.start - deltaBeforeIntersecting);
			const prefixLength = secondReplacement.replaceRange.start - (firstIntersecting.replaceRange.start + deltaBeforeIntersecting);
			if (prefixLength > 0) result.push(firstIntersecting.slice(OffsetRange.emptyAt(newReplaceRangeStart), new OffsetRange(0, prefixLength)));
			if (!lastIntersecting) throw new Error("Edit composition invariant violated");

			const suffixLength = lastIntersecting.replaceRange.endExclusive + delta - secondReplacement.replaceRange.endExclusive;
			if (suffixLength > 0) {
				const suffix = lastIntersecting.slice(OffsetRange.ofStartAndLength(lastIntersecting.replaceRange.endExclusive, 0), new OffsetRange(lastIntersecting.getNewLength() - suffixLength, lastIntersecting.getNewLength()));
				pending.unshift(suffix);
				delta -= suffix.getLengthDelta();
			}

			const newReplaceRange = new OffsetRange(newReplaceRangeStart, secondReplacement.replaceRange.endExclusive - delta);
			result.push(secondReplacement.slice(newReplaceRange, new OffsetRange(0, secondReplacement.getNewLength())));
		}

		result.push(...pending);
		return this._createNew(result).normalize();
	}

	decomposeSplit(shouldBeInE1: (repl: T) => boolean): { e1: TEdit; e2: TEdit } {
		const e1: T[] = [];
		const e2: T[] = [];
		let secondDelta = 0;
		for (const replacement of this.replacements) {
			if (shouldBeInE1(replacement)) {
				e1.push(replacement);
				secondDelta += replacement.getLengthDelta();
			} else {
				e2.push(replacement.slice(replacement.replaceRange.delta(secondDelta), new OffsetRange(0, replacement.getNewLength())));
			}
		}
		return { e1: this._createNew(e1), e2: this._createNew(e2) };
	}

	getNewRanges(): OffsetRange[] {
		const result: OffsetRange[] = [];
		let delta = 0;
		for (const replacement of this.replacements) {
			result.push(OffsetRange.ofStartAndLength(replacement.replaceRange.start + delta, replacement.getNewLength()));
			delta += replacement.getLengthDelta();
		}
		return result;
	}

	getJoinedReplaceRange(): OffsetRange | undefined {
		if (this.replacements.length === 0) return undefined;
		return this.replacements[0]!.replaceRange.join(this.replacements.at(-1)!.replaceRange);
	}

	applyToOffset(originalOffset: number): number {
		let delta = 0;
		for (const replacement of this.replacements) {
			if (replacement.replaceRange.start > originalOffset) break;
			if (originalOffset < replacement.replaceRange.endExclusive) return replacement.replaceRange.start + delta;
			delta += replacement.getLengthDelta();
		}
		return originalOffset + delta;
	}

	applyToOffsetRange(originalRange: OffsetRange): OffsetRange { return new OffsetRange(this.applyToOffset(originalRange.start), this.applyToOffset(originalRange.endExclusive)); }

	applyInverseToOffset(newOffset: number): number {
		let delta = 0;
		for (const replacement of this.replacements) {
			const newStart = replacement.replaceRange.start + delta;
			const newEnd = newStart + replacement.getNewLength();
			if (newOffset < newStart) break;
			if (newOffset < newEnd) return replacement.replaceRange.start;
			delta += replacement.getLengthDelta();
		}
		return newOffset - delta;
	}

	applyToOffsetOrUndefined(originalOffset: number): number | undefined {
		let delta = 0;
		for (const replacement of this.replacements) {
			if (replacement.replaceRange.start > originalOffset) break;
			if (originalOffset < replacement.replaceRange.endExclusive) return undefined;
			delta += replacement.getLengthDelta();
		}
		return originalOffset + delta;
	}

	applyToOffsetRangeOrUndefined(originalRange: OffsetRange): OffsetRange | undefined {
		const start = this.applyToOffsetOrUndefined(originalRange.start);
		const end = this.applyToOffsetOrUndefined(originalRange.endExclusive);
		return start === undefined || end === undefined ? undefined : new OffsetRange(start, end);
	}
}

export type AnyReplacement = BaseReplacement<AnyReplacement>;
export type AnyEdit = BaseEdit<AnyReplacement, AnyEdit>;

export class Edit<T extends BaseReplacement<T>> extends BaseEdit<T, Edit<T>> {
	static readonly empty = new Edit<never>([]);
	static create<T extends BaseReplacement<T>>(replacements: readonly T[]): Edit<T> { return new Edit(replacements); }
	static single<T extends BaseReplacement<T>>(replacement: T): Edit<T> { return new Edit([replacement]); }
	protected _createNew(replacements: readonly T[]): Edit<T> { return new Edit(replacements); }
}

/** A length-only replacement carrying an annotation through edit algebra. */
export class AnnotationReplacement<TAnnotation> extends BaseReplacement<AnnotationReplacement<TAnnotation>> {
	constructor(range: OffsetRange, readonly newLength: number, readonly annotation: TAnnotation) {
		super(range);
		if (!Number.isSafeInteger(newLength) || newLength < 0) throw new RangeError("Replacement length must be non-negative");
	}

	getNewLength(): number { return this.newLength; }
	equals(other: AnnotationReplacement<TAnnotation>): boolean { return this.replaceRange.equals(other.replaceRange) && this.newLength === other.newLength && this.annotation === other.annotation; }
	tryJoinTouching(other: AnnotationReplacement<TAnnotation>): AnnotationReplacement<TAnnotation> | undefined {
		return this.annotation === other.annotation ? new AnnotationReplacement(this.replaceRange.joinRightTouching(other.replaceRange), this.newLength + other.newLength, this.annotation) : undefined;
	}
	slice(range: OffsetRange, rangeInReplacement?: OffsetRange): AnnotationReplacement<TAnnotation> { return new AnnotationReplacement(range, rangeInReplacement?.length ?? this.newLength, this.annotation); }
}
