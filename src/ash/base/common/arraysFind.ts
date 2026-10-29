import type { Comparator } from './arrays.js';

export function findLast<T, R extends T>(array: readonly T[], predicate: (item: T, index: number) => item is R, fromIndex?: number): R | undefined;
export function findLast<T>(array: readonly T[], predicate: (item: T, index: number) => unknown, fromIndex?: number): T | undefined;
export function findLast<T>(array: readonly T[], predicate: (item: T, index: number) => unknown, fromIndex = array.length - 1): T | undefined {
	const index = findLastIdx(array, predicate, fromIndex);
	return index === -1 ? undefined : array[index];
}

export function findLastIdx<T>(array: readonly T[], predicate: (item: T, index: number) => unknown, fromIndex = array.length - 1): number {
	for (let index = Math.min(fromIndex, array.length - 1); index >= 0; index -= 1) {
		if (predicate(array[index]!, index)) return index;
	}
	return -1;
}

export function findFirst<T, R extends T>(array: readonly T[], predicate: (item: T, index: number) => item is R, fromIndex?: number): R | undefined;
export function findFirst<T>(array: readonly T[], predicate: (item: T, index: number) => unknown, fromIndex?: number): T | undefined;
export function findFirst<T>(array: readonly T[], predicate: (item: T, index: number) => unknown, fromIndex = 0): T | undefined {
	const index = findFirstIdx(array, predicate, fromIndex);
	return index === -1 ? undefined : array[index];
}

export function findFirstIdx<T>(array: readonly T[], predicate: (item: T, index: number) => unknown, fromIndex = 0): number {
	for (let index = Math.max(0, fromIndex); index < array.length; index += 1) {
		if (predicate(array[index]!, index)) return index;
	}
	return -1;
}

export function findLastMonotonous<T>(array: readonly T[], predicate: (item: T) => boolean): T | undefined {
	const index = findLastIdxMonotonous(array, predicate);
	return index === -1 ? undefined : array[index];
}

export function findLastIdxMonotonous<T>(array: readonly T[], predicate: (item: T) => boolean, startIndex = 0, endIndexExclusive = array.length): number {
	validateSearchBounds(array.length, startIndex, endIndexExclusive);
	let low = startIndex;
	let high = endIndexExclusive;
	while (low < high) {
		const middle = Math.floor((low + high) / 2);
		if (predicate(array[middle]!)) low = middle + 1;
		else high = middle;
	}
	return low - 1;
}

export function findFirstMonotonous<T>(array: readonly T[], predicate: (item: T) => boolean): T | undefined {
	const index = findFirstIdxMonotonousOrArrLen(array, predicate);
	return index === array.length ? undefined : array[index];
}

export function findFirstIdxMonotonousOrArrLen<T>(array: readonly T[], predicate: (item: T) => boolean, startIndex = 0, endIndexExclusive = array.length): number {
	validateSearchBounds(array.length, startIndex, endIndexExclusive);
	let low = startIndex;
	let high = endIndexExclusive;
	while (low < high) {
		const middle = Math.floor((low + high) / 2);
		if (predicate(array[middle]!)) high = middle;
		else low = middle + 1;
	}
	return low;
}

export function findFirstIdxMonotonous<T>(array: readonly T[], predicate: (item: T) => boolean, startIndex = 0, endIndexExclusive = array.length): number {
	const index = findFirstIdxMonotonousOrArrLen(array, predicate, startIndex, endIndexExclusive);
	return index === endIndexExclusive ? -1 : index;
}

export class MonotonousArray<T> {
	public static assertInvariants = false;
	private lastIndex = 0;
	private previousPredicate: ((item: T) => boolean) | undefined;

	constructor(private readonly array: readonly T[]) {}

	public findLastMonotonous(predicate: (item: T) => boolean): T | undefined {
		if (MonotonousArray.assertInvariants && this.previousPredicate) {
			for (const item of this.array) {
				if (this.previousPredicate(item) && !predicate(item)) throw new Error('The current predicate must not be stronger than the previous predicate');
			}
		}
		this.previousPredicate = predicate;
		const index = findLastIdxMonotonous(this.array, predicate, this.lastIndex);
		this.lastIndex = index + 1;
		return index === -1 ? undefined : this.array[index];
	}
}

export function findFirstMax<T>(array: readonly T[], comparator: Comparator<T>): T | undefined {
	if (array.length === 0) return undefined;
	let maximum = array[0]!;
	for (let index = 1; index < array.length; index += 1) {
		if (comparator(array[index]!, maximum) > 0) maximum = array[index]!;
	}
	return maximum;
}

export function findLastMax<T>(array: readonly T[], comparator: Comparator<T>): T | undefined {
	if (array.length === 0) return undefined;
	let maximum = array[0]!;
	for (let index = 1; index < array.length; index += 1) {
		if (comparator(array[index]!, maximum) >= 0) maximum = array[index]!;
	}
	return maximum;
}

export function findFirstMin<T>(array: readonly T[], comparator: Comparator<T>): T | undefined {
	return findFirstMax(array, (left, right) => -comparator(left, right));
}

export function findMaxIdx<T>(array: readonly T[], comparator: Comparator<T>): number {
	if (array.length === 0) return -1;
	let maximumIndex = 0;
	for (let index = 1; index < array.length; index += 1) {
		if (comparator(array[index]!, array[maximumIndex]!) > 0) maximumIndex = index;
	}
	return maximumIndex;
}

export function mapFindFirst<T, R>(items: Iterable<T>, map: (value: T) => R | undefined): R | undefined {
	for (const value of items) {
		const result = map(value);
		if (result !== undefined) return result;
	}
	return undefined;
}

function validateSearchBounds(length: number, startIndex: number, endIndexExclusive: number): void {
	if (!Number.isSafeInteger(startIndex) || !Number.isSafeInteger(endIndexExclusive) || startIndex < 0 || endIndexExclusive < startIndex || endIndexExclusive > length) {
		throw new RangeError('Array search bounds must be ordered indexes inside the array');
	}
}
