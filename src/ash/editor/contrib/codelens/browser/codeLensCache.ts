import { DisposableStore, type IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { LRUCache } from '../../../../base/common/map.js';
import { URI } from '../../../../base/common/uri.js';
import { type IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { Position } from '../../../common/core/position.js';
import { Range, type IRange } from '../../../common/core/range.js';
import { type CodeLensProvider } from '../../../common/languages.js';
import { CodeLensModel, type CodeLensItem } from './codelens.js';

const StorageKey = 'codelens/cache2';

interface SerializedCacheEntry {
	readonly lineCount: number;
	readonly lines: readonly number[];
}

interface CacheEntry {
	readonly lineCount: number;
	readonly model: CodeLensModel;
}

const cachedCodeLensProvider: CodeLensProvider = {
	provideCodeLenses: () => { throw new Error('Cached CodeLens entries cannot provide results'); },
};

/** Owns the bounded non-executable cache and its optional workspace storage binding. */
class CodeLensCache {
	private readonly entries = new LRUCache<string, CacheEntry>(20, 0.75);
	private storageBinding: IDisposable | undefined;

	public put(resource: URI, lineCount: number, model: CodeLensModel): void {
		const key = resource.toString();
		const lenses = model.lenses.map(item => createCachedItem(item.symbol.range, item.symbol.command?.title));
		this.entries.set(key, { lineCount, model: createModel(lenses) });
	}

	public get(resource: URI, lineCount: number): CodeLensModel | undefined {
		const key = resource.toString();
		const entry = this.entries.get(key);
		if (!entry || entry.lineCount !== lineCount) return undefined;
		return entry.model;
	}

	public delete(resource: URI): void {
		this.entries.delete(resource.toString());
	}

	public bindStorage(storageService: IStorageService): IDisposable {
		if (this.storageBinding) throw new Error('CodeLens cache storage is already bound');
		this.restore(storageService.get(StorageKey, StorageScope.WORKSPACE, '{}'));
		const binding = new DisposableStore();
		this.storageBinding = binding;
		binding.add(storageService.onWillSaveState(() => this.store(storageService)));
		binding.add(storageService.onDidChangeValue(event => {
			if (event.external && event.scope === StorageScope.WORKSPACE && event.key === StorageKey) {
				this.restore(storageService.get(StorageKey, StorageScope.WORKSPACE, '{}'));
			}
		}));
		binding.add(toDisposable(() => {
			this.store(storageService);
			if (this.storageBinding === binding) this.storageBinding = undefined;
		}));
		return binding;
	}

	private store(storageService: IStorageService): void {
		const serialized: Record<string, SerializedCacheEntry> = Object.create(null);
		for (const [key, entry] of this.entries) {
			const lines = new Set(entry.model.lenses.map(item => item.symbol.range.startLineNumber));
			serialized[key] = { lineCount: entry.lineCount, lines: [...lines].sort((left, right) => left - right) };
		}
		storageService.store(StorageKey, JSON.stringify(serialized), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	private restore(raw: string): void {
		const restored = deserialize(raw);
		this.entries.clear();
		for (const [key, entry] of restored) this.entries.set(key, entry);
	}
}

export const codeLensCache = new CodeLensCache();

export function bindCodeLensCacheStorage(storageService: IStorageService): IDisposable {
	return codeLensCache.bindStorage(storageService);
}

function createCachedItem(range: IRange, title: string | undefined): CodeLensItem {
	return Object.freeze({
		symbol: Object.freeze({
			range,
			...(title ? { command: Object.freeze({ id: '', title }) } : {}),
		}),
		provider: cachedCodeLensProvider,
	});
}

function deserialize(raw: string): ReadonlyMap<string, CacheEntry> {
	const result = new Map<string, CacheEntry>();
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return result;
	}
	if (!isRecord(value)) return result;
	for (const [key, candidate] of Object.entries(value)) {
		if (!isSerializedCacheEntry(candidate)) continue;
		try {
			URI.parse(key);
		} catch {
			continue;
		}
		const lines = [...new Set(candidate.lines)].filter(line => line <= candidate.lineCount).sort((left, right) => left - right);
		const lenses = lines.map(line => createCachedItem(Range.fromPositions(new Position(line, 1)), undefined));
		result.set(key, { lineCount: candidate.lineCount, model: createModel(lenses) });
	}
	return result;
}

function createModel(items: readonly CodeLensItem[]): CodeLensModel {
	const model = new CodeLensModel();
	model.add({ lenses: items.map(item => item.symbol) }, cachedCodeLensProvider);
	return model;
}

function isSerializedCacheEntry(value: unknown): value is SerializedCacheEntry {
	if (!isRecord(value) || !Number.isSafeInteger(value.lineCount) || (value.lineCount as number) < 1 || !Array.isArray(value.lines)) return false;
	return value.lines.every(line => Number.isSafeInteger(line) && line >= 1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
