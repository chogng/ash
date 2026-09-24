export type IStringDictionary<T> = Record<string, T>;
export type INumberDictionary<T> = Record<number, T>;

export function groupBy<K extends PropertyKey, T>(items: readonly T[], keyOf: (item: T) => K): Partial<Record<K, T[]>> {
	const result: Partial<Record<K, T[]>> = Object.create(null);
	for (const item of items) (result[keyOf(item)] ??= []).push(item);
	return result;
}

export function groupByMap<K, T>(items: Iterable<T>, keyOf: (item: T) => K): Map<K, T[]> {
	const result = new Map<K, T[]>();
	for (const item of items) {
		const key = keyOf(item);
		const group = result.get(key);
		if (group) group.push(item);
		else result.set(key, [item]);
	}
	return result;
}

export function diffSets<T>(before: ReadonlySet<T>, after: ReadonlySet<T>): { readonly removed: T[]; readonly added: T[] } {
	return {
		removed: [...before].filter(item => !after.has(item)),
		added: [...after].filter(item => !before.has(item)),
	};
}

export function equalSets<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
	return left === right || left.size === right.size && [...left].every(item => right.has(item));
}

export function diffMaps<K, T>(before: ReadonlyMap<K, T>, after: ReadonlyMap<K, T>): { readonly removed: T[]; readonly added: T[] } {
	return {
		removed: [...before].filter(([key]) => !after.has(key)).map(([, value]) => value),
		added: [...after].filter(([key]) => !before.has(key)).map(([, value]) => value),
	};
}

export function intersection<T>(left: ReadonlySet<T>, right: Iterable<T>): Set<T> {
	const result = new Set<T>();
	for (const item of right) if (left.has(item)) result.add(item);
	return result;
}

/** A Set whose equality is defined by a stable key instead of object identity. */
export class SetWithKey<T> implements Set<T> {
	private readonly valuesByKey = new Map<unknown, T>();
	readonly [Symbol.toStringTag] = 'SetWithKey';

	constructor(values: Iterable<T>, private readonly toKey: (value: T) => unknown) {
		for (const value of values) this.add(value);
	}

	get size(): number { return this.valuesByKey.size; }
	add(value: T): this { this.valuesByKey.set(this.toKey(value), value); return this; }
	clear(): void { this.valuesByKey.clear(); }
	delete(value: T): boolean { return this.valuesByKey.delete(this.toKey(value)); }
	has(value: T): boolean { return this.valuesByKey.has(this.toKey(value)); }
	keys(): SetIterator<T> { return this.values(); }
	values(): SetIterator<T> { return this.valuesByKey.values(); }
	*entries(): SetIterator<[T, T]> { for (const value of this.valuesByKey.values()) yield [value, value]; }
	forEach(callback: (value: T, valueAgain: T, set: Set<T>) => void, thisArgument?: unknown): void {
		for (const value of this.valuesByKey.values()) callback.call(thisArgument, value, value, this);
	}
	[Symbol.iterator](): SetIterator<T> { return this.values(); }
}
