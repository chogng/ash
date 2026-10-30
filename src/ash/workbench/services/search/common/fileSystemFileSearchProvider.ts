import { raceCancellationError } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import type { URI } from '../../../../base/common/uri.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { BrowserFileSearchService } from '../../../../platform/search/browser/browserFileSearchService.js';
import { localize } from '../../../../nls.js';
import type { IFileQuery, ISearchComplete, ISearchResultProvider } from './search.js';

/** Adapts provider-backed directory discovery to Workbench filename queries. */
export class FileSystemFileSearchProvider extends Disposable implements ISearchResultProvider {
	private readonly discovery: BrowserFileSearchService;
	private readonly active = new Set<AbortController>();

	constructor(@IInstantiationService instantiationService: IInstantiationService) {
		super();
		this.discovery = instantiationService.createInstance(BrowserFileSearchService);
	}

	public async fileSearch(query: IFileQuery, token: CancellationToken = CancellationToken.None): Promise<ISearchComplete> {
		if (this.isDisposed || token.isCancellationRequested) { throw new CancellationError(); }
		const limit = query.maxResults ?? 2_000;
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5_000) { throw new RangeError(localize('search.invalidResultLimit', 'Search result limit must be between 1 and 5000.')); }
		const controller = new AbortController();
		this.active.add(controller);
		using cancellation = token.onCancellationRequested(() => controller.abort());
		const includePatterns = Object.keys(query.includePattern ?? {}).filter(pattern => query.includePattern![pattern]);
		const excludePatterns = Object.keys(query.excludePattern ?? {}).filter(pattern => query.excludePattern![pattern]);
		try {
			const candidates = new Map<string, { resource: URI; path: string; score: number; }>();
			let limitHit = false;
			for (const folder of query.folderQueries) {
				const directory = { resource: folder.folder, target: { type: 'workspace' as const, dirId: folder.folder.toString() } };
				const maxResults = Math.min(5_000, limit + 1);
				const pending = query.shouldGlobMatchFilePattern
					? this.discovery.glob(directory, { includePatterns, excludePatterns, requiredPattern: query.filePattern, maxResults }, controller.signal)
					: this.discovery.fuzzy(directory, { query: query.filePattern ?? '', includePatterns, excludePatterns, maxResults }, controller.signal);
				const result = await raceCancellationError(pending, controller.signal);
				limitHit ||= result.totalMatches > limit;
				for (const match of result.matches) { candidates.set(match.resource.toString(), { ...match, score: match.score ?? 0 }); }
			}
			if (controller.signal.aborted) { throw new CancellationError(); }
			const sorted = [...candidates.values()].sort((a, b) => query.sortByScore ? b.score - a.score || a.path.localeCompare(b.path) : a.path.localeCompare(b.path));
			return { results: sorted.slice(0, limit).map(({ resource }) => ({ resource })), limitHit: limitHit || sorted.length > limit, messages: [] };
		} finally { this.active.delete(controller); }
	}

	protected override disposeCore(): void {
		for (const controller of this.active) { controller.abort(); }
		this.active.clear();
		super.disposeCore();
	}
}
