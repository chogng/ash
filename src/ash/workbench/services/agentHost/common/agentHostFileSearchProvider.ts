import { raceCancellationError } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { extUri } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileSearchService } from '../../../../platform/search/common/fileSearch.js';
import { IWorkspaceContextService, type IWorkspace } from '../../../../platform/workspace/common/workspace.js';
import { localize } from '../../../../nls.js';
import type { IFileQuery, ISearchComplete, ISearchResultProvider } from '../../search/common/search.js';

const DEFAULT_MAX_RESULTS = 2_000;

/** Executes Workbench filename queries against the host's authorized directory search. */
export class AgentHostFileSearchProvider extends Disposable implements ISearchResultProvider {
	private readonly active = new Map<AbortController, IWorkspace>();

	constructor(
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IFileSearchService private readonly backend: IFileSearchService,
	) {
		super();
		this._register(workspace.onDidChangeWorkspace(() => {
			// Earlier listeners can replace the workspace again before this queued event is delivered.
			const current = workspace.getWorkspace();
			for (const [controller, snapshot] of this.active) {
				if (snapshot !== current) { controller.abort(); }
			}
		}));
	}

	public async fileSearch(query: IFileQuery, token: CancellationToken = CancellationToken.None): Promise<ISearchComplete> {
		if (this.isDisposed || token.isCancellationRequested) { throw new CancellationError(); }
		const snapshot = this.workspace.getWorkspace();
		const controller = new AbortController();
		using cancellation = token.onCancellationRequested(() => controller.abort());
		this.active.set(controller, snapshot);
		try {
			const limit = query.maxResults ?? DEFAULT_MAX_RESULTS;
			if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5_000) { throw new RangeError(localize('search.invalidResultLimit', 'Search result limit must be between 1 and 5000.')); }
			const workspaceFolders = snapshot.folders;
			const folders = query.folderQueries.map(folderQuery => {
				const folder = workspaceFolders.find(folder => extUri.isEqual(folder.uri, folderQuery.folder));
				if (!folder) { throw new RangeError(localize('search.folderOutsideWorkspace', 'Search folder is outside the current workspace.')); }
				return folder;
			});
			const candidates = new Map<string, { resource: URI; score: number; folderIndex: number; path: string; }>();
			const includePatterns = Object.keys(query.includePattern ?? {}).filter(pattern => query.includePattern![pattern] === true);
			const excludePatterns = Object.keys(query.excludePattern ?? {}).filter(pattern => query.excludePattern![pattern] === true);
			let limitHit = false;
			for (const folder of folders) {
				if (controller.signal.aborted) { throw new CancellationError(); }
				const directory = { resource: folder.uri, target: { type: 'workspace' as const, dirId: folder.id } };
				// Each root supplies its best candidates before applying the global result budget.
				const maxResults = Math.min(5_000, limit + 1);
				const pending = query.shouldGlobMatchFilePattern
					? this.backend.glob(directory, { includePatterns: includePatterns.length ? includePatterns : query.filePattern ? [query.filePattern] : [], excludePatterns, ...(includePatterns.length && query.filePattern ? { requiredPattern: query.filePattern } : {}), maxResults }, controller.signal)
					: this.backend.fuzzy(directory, { query: query.filePattern ?? '', ...(includePatterns.length ? { includePatterns } : {}), ...(excludePatterns.length ? { excludePatterns } : {}), maxResults }, controller.signal);
				const found = await raceCancellationError(pending, controller.signal);
				if (controller.signal.aborted) { throw new CancellationError(); }
				limitHit ||= found.totalMatches > found.matches.length;
				for (const candidate of found.matches) {
					const key = extUri.getComparisonKey(candidate.resource);
					const retained = candidates.get(key);
					const score = candidate.score ?? 0;
					if (!retained || score > retained.score) {
						candidates.set(key, { resource: candidate.resource, score, folderIndex: folder.index, path: candidate.path });
					}
				}
			}
			const ordered = [...candidates.values()].sort((left, right) => {
				if (query.sortByScore && left.score !== right.score) { return right.score - left.score; }
				return left.folderIndex - right.folderIndex || left.path.localeCompare(right.path);
			});
			return { results: ordered.slice(0, limit).map(candidate => ({ resource: candidate.resource })), limitHit: limitHit || ordered.length > limit, messages: [] };
		} finally {
			this.active.delete(controller);
		}
	}

	protected override disposeCore(): void {
		for (const controller of this.active.keys()) { controller.abort(); }
		this.active.clear();
		super.disposeCore();
	}
}
