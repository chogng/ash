import { URI } from "./uri.js";

/** Returns the value for a key, inserting the supplied value when the key is absent. */
export function getOrSet<K, V>(map: Map<K, V>, key: K, value: V): V {
	let result = map.get(key);
	if (result === undefined) {
		result = value;
		map.set(key, result);
	}

	return result;
}

/**
 * A bounded map ordered from least recently used to most recently used.
 *
 * Reading or replacing an entry marks it as recently used. When the limit is
 * exceeded, the oldest entries are removed until the configured trim ratio is
 * reached.
 */
export class LRUCache<K, V> implements Map<K, V> {
	private readonly entriesByAge = new Map<K, V>();
	private mutableLimit: number;
	private mutableRatio: number;

	readonly [Symbol.toStringTag] = "LRUCache";

	constructor(limit: number, ratio = 1) {
		this.mutableLimit = validateCacheLimit(limit);
		this.mutableRatio = validateCacheRatio(ratio);
	}

	get size(): number {
		return this.entriesByAge.size;
	}

	get limit(): number {
		return this.mutableLimit;
	}

	set limit(value: number) {
		this.mutableLimit = validateCacheLimit(value);
		this.trimIfNeeded();
	}

	get ratio(): number {
		return this.mutableRatio;
	}

	set ratio(value: number) {
		this.mutableRatio = validateCacheRatio(value);
		this.trimIfNeeded();
	}

	clear(): void {
		this.entriesByAge.clear();
	}

	delete(key: K): boolean {
		return this.entriesByAge.delete(key);
	}

	forEach(
		callback: (value: V, key: K, map: Map<K, V>) => void,
		thisArg?: unknown,
	): void {
		new Map(this.entriesByAge).forEach((value, key) => {
			callback.call(thisArg, value, key, this);
		});
	}

	get(key: K): V | undefined {
		if (!this.entriesByAge.has(key)) return undefined;
		const value = this.entriesByAge.get(key)!;
		this.entriesByAge.delete(key);
		this.entriesByAge.set(key, value);
		return value;
	}

	peek(key: K): V | undefined {
		return this.entriesByAge.get(key);
	}

	has(key: K): boolean {
		return this.entriesByAge.has(key);
	}

	set(key: K, value: V): this {
		this.entriesByAge.delete(key);
		this.entriesByAge.set(key, value);
		this.trimIfNeeded();
		return this;
	}

	entries(): MapIterator<[K, V]> {
		return new Map(this.entriesByAge).entries();
	}

	keys(): MapIterator<K> {
		return new Map(this.entriesByAge).keys();
	}

	values(): MapIterator<V> {
		return new Map(this.entriesByAge).values();
	}

	[Symbol.iterator](): MapIterator<[K, V]> {
		return this.entries();
	}

	private trimIfNeeded(): void {
		if (this.size <= this.mutableLimit) return;
		const targetSize = Math.round(this.mutableLimit * this.mutableRatio);
		while (this.size > targetSize) {
			const oldest = this.entriesByAge.keys().next();
			if (oldest.done) return;
			this.entriesByAge.delete(oldest.value);
		}
	}
}

function validateCacheLimit(value: number): number {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new RangeError("LRU cache limit must be a non-negative safe integer");
	}
	return value;
}

function validateCacheRatio(value: number): number {
	if (!Number.isFinite(value) || value < 0 || value > 1) {
		throw new RangeError("LRU cache ratio must be between zero and one");
	}
	return value;
}

/** Converts a URI into the string used by a resource collection. */
export type ResourceMapKeyFn = (resource: URI) => string;

interface ResourceMapEntry<T> {
	readonly resource: URI;
	readonly value: T;
}

function defaultResourceKey(resource: URI): string {
	return resource.toString();
}

/**
 * A map keyed by URI value instead of URI object identity.
 *
 * Exact serialized URI identity is used by default. Pass an `IExtUri`
 * comparison-key method when provider-specific casing or fragment handling is
 * required.
 */
export class ResourceMap<T> implements Map<URI, T> {
	private readonly _entries = new Map<string, ResourceMapEntry<T>>();
	private readonly toKey: ResourceMapKeyFn;

	readonly [Symbol.toStringTag] = "ResourceMap";

	constructor(toKey: ResourceMapKeyFn = defaultResourceKey) {
		this.toKey = toKey;
	}

	get size(): number {
		return this._entries.size;
	}

	has(resource: URI): boolean {
		return this._entries.has(this.toKey(resource));
	}

	get(resource: URI): T | undefined {
		return this._entries.get(this.toKey(resource))?.value;
	}

	set(resource: URI, value: T): this {
		this._entries.set(this.toKey(resource), { resource, value });
		return this;
	}

	delete(resource: URI): boolean {
		return this._entries.delete(this.toKey(resource));
	}

	clear(): void {
		this._entries.clear();
	}

	forEach(
		callback: (value: T, key: URI, map: Map<URI, T>) => void,
		thisArg?: unknown,
	): void {
		for (const entry of this._entries.values()) {
			callback.call(thisArg, entry.value, entry.resource, this);
		}
	}

	*keys(): MapIterator<URI> {
		for (const entry of this._entries.values()) {
			yield entry.resource;
		}
	}

	*values(): MapIterator<T> {
		for (const entry of this._entries.values()) {
			yield entry.value;
		}
	}

	*entries(): MapIterator<[URI, T]> {
		for (const entry of this._entries.values()) {
			yield [entry.resource, entry.value];
		}
	}

	[Symbol.iterator](): MapIterator<[URI, T]> {
		return this.entries();
	}
}

/** A set using the same URI key semantics as `ResourceMap`. */
export class ResourceSet implements Set<URI> {
	private readonly resources: ResourceMap<URI>;

	readonly [Symbol.toStringTag] = "ResourceSet";

	constructor(toKey: ResourceMapKeyFn = defaultResourceKey) {
		this.resources = new ResourceMap(toKey);
	}

	get size(): number {
		return this.resources.size;
	}

	has(resource: URI): boolean {
		return this.resources.has(resource);
	}

	add(resource: URI): this {
		this.resources.set(resource, resource);
		return this;
	}

	delete(resource: URI): boolean {
		return this.resources.delete(resource);
	}

	clear(): void {
		this.resources.clear();
	}

	forEach(
		callback: (value: URI, value2: URI, set: Set<URI>) => void,
		thisArg?: unknown,
	): void {
		this.resources.forEach((_value, resource) => {
			callback.call(thisArg, resource, resource, this);
		});
	}

	entries(): SetIterator<[URI, URI]> {
		return this.resources.entries();
	}

	keys(): SetIterator<URI> {
		return this.resources.keys();
	}

	values(): SetIterator<URI> {
		return this.resources.keys();
	}

	[Symbol.iterator](): SetIterator<URI> {
		return this.values();
	}
}

export type NKey = string | number | boolean;

interface NKeyMapNode<T> {
	readonly children: Map<NKey, NKeyMapNode<T>>;
	hasValue: boolean;
	value: T | undefined;
}

/** Stores values under fixed-length tuples without allocating composite keys. */
export class NKeyMap<TValue, TKeys extends readonly [NKey, ...NKey[]]> {
	private readonly root = createNKeyMapNode<TValue>();

	public set(value: TValue, ...keys: TKeys): void {
		const node = this.getOrCreateNode(keys);
		node.hasValue = true;
		node.value = value;
	}

	public get(...keys: TKeys): TValue | undefined {
		const node = this.getNode(keys);
		return node?.hasValue ? node.value : undefined;
	}

	public delete(...keys: TKeys): boolean {
		const path = this.getPath(keys);
		const node = path.at(-1)?.node;
		if (!node?.hasValue) return false;
		node.hasValue = false;
		node.value = undefined;
		this.prune(path);
		return true;
	}

	public deleteAll(...keys: Partial<TKeys>): boolean {
		if (keys.length === 0) {
			const hadValues = this.root.hasValue || this.root.children.size > 0;
			this.clear();
			return hadValues;
		}
		const path = this.getPath(keys as readonly NKey[]);
		if (path.length !== keys.length) return false;
		const last = path.at(-1)!;
		const deleted = last.parent.children.delete(last.key);
		if (deleted) this.prune(path.slice(0, -1));
		return deleted;
	}

	public clear(): void {
		this.root.children.clear();
		this.root.hasValue = false;
		this.root.value = undefined;
	}

	public *getAll(...keys: Partial<TKeys>): IterableIterator<TValue> {
		const node = keys.length === 0 ? this.root : this.getNode(keys as readonly NKey[]);
		if (node) yield* this.valuesFrom(node);
	}

	public *values(): IterableIterator<TValue> {
		yield* this.valuesFrom(this.root);
	}

	private getOrCreateNode(keys: readonly NKey[]): NKeyMapNode<TValue> {
		let node = this.root;
		for (const key of keys) {
			let child = node.children.get(key);
			if (!child) {
				child = createNKeyMapNode<TValue>();
				node.children.set(key, child);
			}
			node = child;
		}
		return node;
	}

	private getNode(keys: readonly NKey[]): NKeyMapNode<TValue> | undefined {
		let node = this.root;
		for (const key of keys) {
			const child = node.children.get(key);
			if (!child) return undefined;
			node = child;
		}
		return node;
	}

	private getPath(keys: readonly NKey[]): Array<{ readonly parent: NKeyMapNode<TValue>; readonly key: NKey; readonly node: NKeyMapNode<TValue> }> {
		const path: Array<{ readonly parent: NKeyMapNode<TValue>; readonly key: NKey; readonly node: NKeyMapNode<TValue> }> = [];
		let parent = this.root;
		for (const key of keys) {
			const node = parent.children.get(key);
			if (!node) break;
			path.push({ parent, key, node });
			parent = node;
		}
		return path;
	}

	private prune(path: readonly { readonly parent: NKeyMapNode<TValue>; readonly key: NKey; readonly node: NKeyMapNode<TValue> }[]): void {
		for (let index = path.length - 1; index >= 0; index -= 1) {
			const entry = path[index]!;
			if (entry.node.hasValue || entry.node.children.size > 0) return;
			entry.parent.children.delete(entry.key);
		}
	}

	private *valuesFrom(node: NKeyMapNode<TValue>): IterableIterator<TValue> {
		if (node.hasValue) yield node.value as TValue;
		for (const child of node.children.values()) yield* this.valuesFrom(child);
	}
}

function createNKeyMapNode<T>(): NKeyMapNode<T> {
	return { children: new Map(), hasValue: false, value: undefined };
}
