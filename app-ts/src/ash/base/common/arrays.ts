export type Comparator<T> = (left: T, right: T) => number;

export type CompareResult = number;

export namespace CompareResult {
	export function isLessThan(result: CompareResult): boolean { return result < 0; }
	export function isLessThanOrEqual(result: CompareResult): boolean { return result <= 0; }
	export function isGreaterThan(result: CompareResult): boolean { return result > 0; }
	export function isNeitherLessOrGreaterThan(result: CompareResult): boolean { return result === 0; }
	export const greaterThan = 1;
	export const lessThan = -1;
	export const neitherLessOrGreaterThan = 0;
}

export const numberComparator: Comparator<number> = (left, right) => left - right;
export const booleanComparator: Comparator<boolean> = (left, right) => numberComparator(left ? 1 : 0, right ? 1 : 0);

export function equals<T>(left: readonly T[] | undefined, right: readonly T[] | undefined, itemEquals: (left: T, right: T) => boolean = strictEquals): boolean {
	if (left === right) return true;
	if (!left || !right) return false;
	return arraysEqual(left, right, itemEquals);
}

/** Binary-searches an indexed collection. A missing item is encoded as `-(insertionIndex + 1)`. */
export function binarySearch2(length: number, compareToKey: (index: number) => number): number {
	if (!Number.isSafeInteger(length) || length < 0) throw new RangeError('Binary-search length must be a non-negative safe integer');
	let low = 0;
	let high = length - 1;
	while (low <= high) {
		const middle = low + Math.floor((high - low) / 2);
		const comparison = compareToKey(middle);
		if (comparison < 0) low = middle + 1;
		else if (comparison > 0) high = middle - 1;
		else return middle;
	}
	return -(low + 1);
}

export function compareBy<T, K>(selector: (item: T) => K, comparator: Comparator<K>): Comparator<T> {
	return (left, right) => comparator(selector(left), selector(right));
}

export function pushMany<T>(target: T[], items: readonly T[]): void {
	for (const item of items) target.push(item);
}

export function sumBy<T>(items: readonly T[], selector: (item: T) => number): number {
	let result = 0;
	for (const item of items) result += selector(item);
	return result;
}

export function* groupAdjacentBy<T>(items: Iterable<T>, shouldGroup: (left: T, right: T) => boolean): IterableIterator<T[]> {
	let group: T[] = [];
	for (const item of items) {
		if (group.length > 0 && !shouldGroup(group[group.length - 1]!, item)) {
			yield group;
			group = [];
		}
		group.push(item);
	}
	if (group.length > 0) yield group;
}

/** Consumes values from the front of an array without repeatedly shifting it. */
export class ArrayQueue<T> {
	private firstIndex = 0;
	private lastIndex: number;

	constructor(private readonly items: readonly T[]) {
		this.lastIndex = items.length - 1;
	}

	get length(): number {
		return this.lastIndex - this.firstIndex + 1;
	}

	get first(): T | undefined {
		return this.peek();
	}

	takeWhile(predicate: (item: T) => boolean): T[] | null {
		const start = this.firstIndex;
		while (this.firstIndex <= this.lastIndex && predicate(this.items[this.firstIndex]!)) this.firstIndex += 1;
		return start === this.firstIndex ? null : this.items.slice(start, this.firstIndex);
	}

	takeFromEndWhile(predicate: (item: T) => boolean): T[] | null {
		const previousEnd = this.lastIndex;
		while (this.lastIndex >= this.firstIndex && predicate(this.items[this.lastIndex]!)) this.lastIndex -= 1;
		if (this.lastIndex === previousEnd) return null;
		const result = this.items.slice(this.lastIndex + 1, previousEnd + 1);
		return result;
	}

	peek(): T | undefined { return this.length === 0 ? undefined : this.items[this.firstIndex]; }
	peekLast(): T | undefined { return this.length === 0 ? undefined : this.items[this.lastIndex]; }
	dequeue(): T | undefined {
		if (this.length === 0) return undefined;
		const result = this.items[this.firstIndex];
		this.firstIndex += 1;
		return result;
	}
	removeLast(): T | undefined {
		if (this.length === 0) return undefined;
		const result = this.items[this.lastIndex];
		this.lastIndex -= 1;
		return result;
	}
	takeCount(count: number): T[] {
		if (!Number.isSafeInteger(count) || count < 0 || count > this.length) throw new RangeError('Queue count is outside the remaining items');
		const result = this.items.slice(this.firstIndex, this.firstIndex + count);
		this.firstIndex += count;
		return result;
	}
}

/** Compares two array-like sequences item by item. */
export function arraysEqual<T>(
	left: readonly T[],
	right: readonly T[],
	equals: (left: T, right: T) => boolean = strictEquals,
): boolean {
	if (left === right) return true;
	if (left.length !== right.length) return false;
	return left.every((value, index) => equals(value, right[index]!));
}

/** Returns whether the provided array has at least one element. */
export function isNonEmptyArray<T>(obj: T[] | undefined | null): obj is T[];
export function isNonEmptyArray<T>(obj: readonly T[] | undefined | null): obj is readonly T[];
export function isNonEmptyArray<T>(obj: T[] | readonly T[] | undefined | null): obj is T[] | readonly T[] {
	return Array.isArray(obj) && obj.length > 0;
}

/** Removes duplicate values while retaining the first value for each key. */
export function distinct<T>(array: ReadonlyArray<T>, keyFn: (value: T) => unknown = value => value): T[] {
	const seen = new Set<unknown>();
	return array.filter(element => {
		const key = keyFn(element);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/** Returns the number of equal items at the beginning of two sequences. */
export function commonPrefixLength<T>(
	left: readonly T[],
	right: readonly T[],
	equals: (left: T, right: T) => boolean = strictEquals,
): number {
	const limit = Math.min(left.length, right.length);
	let index = 0;
	while (index < limit && equals(left[index]!, right[index]!)) index += 1;
	return index;
}

/** Returns the number of equal trailing items without overlapping an already matched prefix. */
export function commonArraySuffixLength<T>(
	left: readonly T[],
	right: readonly T[],
	prefixLength = 0,
	equals: (left: T, right: T) => boolean = strictEquals,
): number {
	const limit = Math.min(left.length, right.length);
	if (!Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > limit) {
		throw new RangeError('Prefix length must be an integer within both sequences');
	}
	const maximumLength = limit - prefixLength;
	let length = 0;
	while (
		length < maximumLength &&
		equals(left[left.length - length - 1]!, right[right.length - length - 1]!)
	) {
		length += 1;
	}
	return length;
}

function strictEquals<T>(left: T, right: T): boolean {
	return left === right;
}

/** A callback-based lazy sequence that can stop iteration early. */
export class CallbackIterable<T> {
	public static readonly empty = new CallbackIterable<never>(_callback => {});

	constructor(public readonly iterate: (callback: (item: T) => boolean) => void) {}

	forEach(handler: (item: T) => void): void {
		this.iterate(item => { handler(item); return true; });
	}

	toArray(): T[] {
		const result: T[] = [];
		this.iterate(item => { result.push(item); return true; });
		return result;
	}

	filter(predicate: (item: T) => boolean): CallbackIterable<T> {
		return new CallbackIterable(callback => this.iterate(item => predicate(item) ? callback(item) : true));
	}

	map<TResult>(mapFn: (item: T) => TResult): CallbackIterable<TResult> {
		return new CallbackIterable<TResult>(callback => this.iterate(item => callback(mapFn(item))));
	}

	some(predicate: (item: T) => boolean): boolean {
		let result = false;
		this.iterate(item => { result = predicate(item); return !result; });
		return result;
	}

	findFirst(predicate: (item: T) => boolean): T | undefined {
		let result: T | undefined;
		this.iterate(item => {
			if (!predicate(item)) return true;
			result = item;
			return false;
		});
		return result;
	}

	findLast(predicate: (item: T) => boolean): T | undefined {
		let result: T | undefined;
		this.iterate(item => {
			if (predicate(item)) result = item;
			return true;
		});
		return result;
	}

	findLastMaxBy(comparator: Comparator<T>): T | undefined {
		let result: T | undefined;
		let first = true;
		this.iterate(item => {
			if (first || CompareResult.isGreaterThan(comparator(item, result!))) {
				first = false;
				result = item;
			}
			return true;
		});
		return result;
	}
}

export function arrayInsert<T>(target: T[], insertIndex: number, insertArr: T[]): T[] {
	const before = target.slice(0, insertIndex);
	const after = target.slice(insertIndex);
	return before.concat(insertArr, after);
}
