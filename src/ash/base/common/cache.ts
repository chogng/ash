import { CancellationToken, CancellationTokenSource } from './cancellation.js';
import { type IDisposable } from './lifecycle.js';

export interface CacheResult<T> extends IDisposable {
	promise: Promise<T>;
}

export class Cache<T> {
	private result: CacheResult<T> | null = null;

	constructor(private task: (ct: CancellationToken) => Promise<T>) {}

	get(): CacheResult<T> {
		if (this.result) return this.result;

		const cts = new CancellationTokenSource();
		const promise = this.task(cts.token);
		this.result = {
			promise,
			dispose: () => {
				this.result = null;
				cts.cancel();
				cts.dispose();
			},
			[Symbol.dispose]: () => {
				this.result?.dispose();
			},
		};
		return this.result;
	}
}

export function identity<T>(value: T): T {
	return value;
}

interface ICacheOptions<TArg> {
	getCacheKey: (arg: TArg) => unknown;
}

/** Uses a one-entry LRU cache to memoize a parameterized function. */
export class LRUCachedFunction<TArg, TComputed> {
	private lastCache: TComputed | undefined;
	private lastArgKey: unknown | undefined;
	private readonly fn: (arg: TArg) => TComputed;
	private readonly computeKey: (arg: TArg) => unknown;

	constructor(fn: (arg: TArg) => TComputed);
	constructor(options: ICacheOptions<TArg>, fn: (arg: TArg) => TComputed);
	constructor(arg1: ICacheOptions<TArg> | ((arg: TArg) => TComputed), arg2?: (arg: TArg) => TComputed) {
		if (typeof arg1 === 'function') {
			this.fn = arg1;
			this.computeKey = identity;
		} else {
			this.fn = arg2!;
			this.computeKey = arg1.getCacheKey;
		}
	}

	get(arg: TArg): TComputed {
		const key = this.computeKey(arg);
		if (this.lastArgKey !== key) {
			this.lastArgKey = key;
			this.lastCache = this.fn(arg);
		}
		return this.lastCache!;
	}
}

/** Uses an unbounded cache to memoize a parameterized function. */
export class CachedFunction<TArg, TComputed> {
	private readonly map = new Map<TArg, TComputed>();
	private readonly mapByKey = new Map<unknown, TComputed>();
	private readonly fn: (arg: TArg) => TComputed;
	private readonly computeKey: (arg: TArg) => unknown;

	get cachedValues(): ReadonlyMap<TArg, TComputed> {
		return this.map;
	}

	constructor(fn: (arg: TArg) => TComputed);
	constructor(options: ICacheOptions<TArg>, fn: (arg: TArg) => TComputed);
	constructor(arg1: ICacheOptions<TArg> | ((arg: TArg) => TComputed), arg2?: (arg: TArg) => TComputed) {
		if (typeof arg1 === 'function') {
			this.fn = arg1;
			this.computeKey = identity;
		} else {
			this.fn = arg2!;
			this.computeKey = arg1.getCacheKey;
		}
	}

	get(arg: TArg): TComputed {
		const key = this.computeKey(arg);
		if (this.mapByKey.has(key)) return this.mapByKey.get(key)!;

		const value = this.fn(arg);
		this.map.set(arg, value);
		this.mapByKey.set(key, value);
		return value;
	}
}

/** Uses an unbounded weak cache to memoize a parameterized function. */
export class WeakCachedFunction<TArg, TComputed> {
	private readonly map = new WeakMap<WeakKey, TComputed>();
	private readonly fn: (arg: TArg) => TComputed;
	private readonly computeKey: (arg: TArg) => unknown;

	constructor(fn: (arg: TArg) => TComputed);
	constructor(options: ICacheOptions<TArg>, fn: (arg: TArg) => TComputed);
	constructor(arg1: ICacheOptions<TArg> | ((arg: TArg) => TComputed), arg2?: (arg: TArg) => TComputed) {
		if (typeof arg1 === 'function') {
			this.fn = arg1;
			this.computeKey = identity;
		} else {
			this.fn = arg2!;
			this.computeKey = arg1.getCacheKey;
		}
	}

	get(arg: TArg): TComputed {
		const key = this.computeKey(arg) as WeakKey;
		if (this.map.has(key)) return this.map.get(key)!;

		const value = this.fn(arg);
		this.map.set(key, value);
		return value;
	}
}
