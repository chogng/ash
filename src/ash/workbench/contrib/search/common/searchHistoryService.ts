import { Emitter, type Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

export interface ISearchHistoryValues {
	search?: string[];
	replace?: string[];
	include?: string[];
	exclude?: string[];
}

export interface ISearchHistoryService {
	readonly onDidClearHistory: Event<void>;
	load(): ISearchHistoryValues;
	save(history: ISearchHistoryValues): void;
	clearHistory(): void;
}

export const ISearchHistoryService = createServiceIdentifier<ISearchHistoryService>('searchHistoryService');

/** Workspace-scoped history; the inputs own navigation and drafts. */
export class SearchHistoryService extends Disposable implements ISearchHistoryService {
	public static readonly SEARCH_HISTORY_KEY = 'workbench.search.history';
	private readonly clearEmitter = this._register(new Emitter<void>());
	public readonly onDidClearHistory = this.clearEmitter.event;

	constructor(@IStorageService private readonly storage: IStorageService) { super(); }

	public load(): ISearchHistoryValues {
		const raw = this.storage.get(SearchHistoryService.SEARCH_HISTORY_KEY, StorageScope.WORKSPACE);
		if (raw === undefined) { return {}; }
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { throw new TypeError('Invalid search history'); }
		const history: ISearchHistoryValues = {};
		for (const key of ['search', 'replace', 'include', 'exclude'] as const) {
			const values = (parsed as Record<string, unknown>)[key];
			if (values === undefined) { continue; }
			if (!Array.isArray(values) || values.some(value => typeof value !== 'string')) { throw new TypeError('Invalid search history values'); }
			history[key] = [...new Set<string>(values)].slice(-100);
		}
		return history;
	}

	public save(history: ISearchHistoryValues): void {
		this.storage.store(SearchHistoryService.SEARCH_HISTORY_KEY, JSON.stringify(history), StorageScope.WORKSPACE, StorageTarget.USER);
	}

	public clearHistory(): void {
		this.storage.remove(SearchHistoryService.SEARCH_HISTORY_KEY, StorageScope.WORKSPACE);
		this.clearEmitter.fire();
	}
}
