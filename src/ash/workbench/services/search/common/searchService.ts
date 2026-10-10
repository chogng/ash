import { CancellationToken } from '../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { match } from '../../../../base/common/glob.js';
import { escapeRegExpCharacters } from '../../../../base/common/strings.js';
import { extUri } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { USUAL_WORD_SEPARATORS } from '../../../../editor/common/core/wordHelper.js';
import { IContentSearchService, type ContentSearchMatch, type IContentSearchQuery } from '../../../../platform/search/common/search.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IFileSearchService } from '../../../../platform/search/common/fileSearch.js';
import { IFileTextModelService } from '../../textmodelResolver/common/textModelResourceService.js';
import { localize } from '../../../../nls.js';
import type { IFileMatch, IFileQuery, ISearchComplete, ISearchProgressItem, ISearchService, ISearchRange, ITextQuery, ITextSearchMatch } from './search.js';
import { editorMatchesToTextSearchResults } from './searchHelpers.js';

const DEFAULT_MAX_RESULTS = 2_000;

/** Owns one workspace query's model snapshot, directory aggregation and result budget. */
export class SearchService implements ISearchService {
	constructor(
		@IContentSearchService private readonly contentSearch: IContentSearchService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IFileTextModelService private readonly models: IFileTextModelService,
		@IFileSearchService private readonly fileSearchProvider: IFileSearchService,
	) { }

	public async fileSearch(query: IFileQuery, token: CancellationToken = CancellationToken.None): Promise<ISearchComplete> {
		const controller = new AbortController();
		using cancellation = token.onCancellationRequested(() => controller.abort());
		const checkCancellation = (): void => { if (token.isCancellationRequested) { throw new CancellationError(); } };
		checkCancellation();
		const limit = query.maxResults ?? DEFAULT_MAX_RESULTS;
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5_000) { throw new RangeError(localize('search.invalidResultLimit', 'Search result limit must be between 1 and 5000.')); }
		const folders = this.workspace.getWorkspace().folders;
		const matches = new Map<string, { resource: URI; score: number; folderIndex: number; path: string; }>();
		let limitHit = false;
		for (const folderQuery of query.folderQueries) {
			checkCancellation();
			const folder = folders.find(folder => extUri.isEqual(folder.uri, folderQuery.folder));
			if (!folder) { throw new RangeError(localize('search.folderOutsideWorkspace', 'Search folder is outside the current workspace.')); }
			const directory = { resource: folder.uri, target: { type: 'workspace' as const, dirId: folder.id } };
			// Each root supplies its best candidates before the Workbench applies one global limit.
			const maxResults = Math.min(5_000, limit + 1);
			const found = query.shouldGlobMatchFilePattern
				? await this.fileSearchProvider.glob(directory, { includePatterns: query.filePattern ? [query.filePattern] : [], excludePatterns: [], maxResults }, controller.signal)
				: await this.fileSearchProvider.fuzzy(directory, { query: query.filePattern ?? '', maxResults }, controller.signal);
			checkCancellation();
			limitHit ||= found.totalMatches > found.matches.length;
			for (const candidate of found.matches) {
				const key = extUri.getComparisonKey(candidate.resource);
				const retained = matches.get(key);
				const score = candidate.score ?? 0;
				if (!retained || score > retained.score) { matches.set(key, { resource: candidate.resource, score, folderIndex: folder.index, path: candidate.path }); }
			}
		}
		const ordered = [...matches.values()].sort((left, right) => {
			if (query.sortByScore && left.score !== right.score) { return right.score - left.score; }
			return left.folderIndex - right.folderIndex || left.path.localeCompare(right.path);
		});
		return { results: ordered.slice(0, limit).map(match => ({ resource: match.resource })), limitHit: limitHit || ordered.length > limit, messages: [] };
	}

	public async textSearch(query: ITextQuery, token: CancellationToken = CancellationToken.None, onProgress?: (result: ISearchProgressItem) => void): Promise<ISearchComplete> {
		const controller = new AbortController();
		using cancellation = token.onCancellationRequested(() => controller.abort());
		const checkCancellation = (): void => {
			if (token.isCancellationRequested) { throw new CancellationError(); }
		};
		checkCancellation();
		const workspaceFolders = this.workspace.getWorkspace().folders;
		const folders = query.folderQueries.map(folderQuery => {
			const folder = workspaceFolders.find(folder => extUri.isEqual(folder.uri, folderQuery.folder));
			if (!folder) { throw new RangeError(localize('search.folderOutsideWorkspace', 'Search folder is outside the current workspace.')); }
			return folder;
		});
		const complete: ISearchComplete = { results: [], limitHit: false, messages: [] };
		if (!query.contentPattern.pattern) { return complete; }
		const limit = query.maxResults ?? DEFAULT_MAX_RESULTS;
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5_000) { throw new RangeError(localize('search.invalidResultLimit', 'Search result limit must be between 1 and 5000.')); }
		const directoryQuery: IContentSearchQuery = {
			text: query.contentPattern.pattern,
			patternKind: query.contentPattern.isRegExp ? 'regex' : 'literal',
			wholeWord: query.contentPattern.isWordMatch,
			caseSensitivity: query.contentPattern.isCaseSensitive ? 'sensitive' : 'insensitive',
			includePatterns: Object.keys(query.includePattern ?? {}).filter(pattern => query.includePattern![pattern] === true),
			excludePatterns: Object.keys(query.excludePattern ?? {}).filter(pattern => query.excludePattern![pattern] === true),
			freshness: 'current',
		};
		const overridden = new Set<string>();
		const extraResources = new Set(query.extraFileResources?.map(resource => extUri.getComparisonKey(resource)));
		let searchedModel = false;
		const files = new Map<string, IFileMatch>();
		const seenRanges = new Map<string, string>();
		let active = true;
		let resultCount = 0;
		const limitReached = new Error('Search result budget reached');
		const publish = (file: IFileMatch, directoryId: string): void => {
			checkCancellation();
			const key = extUri.getComparisonKey(file.resource);
			const results: ITextSearchMatch[] = [];
			const progress: ITextSearchMatch[] = [];
			let exceeded = false;
			for (const result of file.results ?? []) {
				const available = limit - resultCount;
				const replays: ITextSearchMatch['rangeLocations'] = [];
				const unique = result.rangeLocations.filter(location => {
					const rangeKey = JSON.stringify([key, location.source.startLineNumber, location.source.startColumn, location.source.endLineNumber, location.source.endColumn]);
					const owner = seenRanges.get(rangeKey);
					if (owner !== undefined) {
						// A provider replay may restore a dismissed UI row; overlapping roots do not republish it.
						if (owner === directoryId) { replays.push(location); }
						return false;
					}
					seenRanges.set(rangeKey, directoryId);
					return true;
				});
				if (unique.length > available) { complete.limitHit = true; exceeded = true; }
				const ranges = unique.slice(0, available);
				if (ranges.length) {
					results.push({ ...result, rangeLocations: ranges });
					resultCount += ranges.length;
				}
				if (ranges.length || replays.length) { progress.push({ ...result, rangeLocations: [...ranges, ...replays] }); }
			}
			if (!results.length) {
				if (progress.length) { onProgress?.({ resource: file.resource, results: progress }); checkCancellation(); }
				if (exceeded) { throw limitReached; }
				return;
			}
			const existing = files.get(key);
			if (existing) { existing.results!.push(...results); }
			else {
				const retained = { resource: file.resource, results: [...results] };
				files.set(key, retained);
				complete.results.push(retained);
			}
			onProgress?.({ resource: file.resource, results: progress });
			checkCancellation();
			if (exceeded) { throw limitReached; }
		};
		try {
			// Capture model results before awaiting disk. A zero-match model still suppresses stale disk hits.
			for (const model of this.models.getModels()) {
				checkCancellation();
				const folder = [...folders].sort((a, b) => b.uri.path.length - a.uri.path.length).find(folder => extUri.isEqualOrParent(model.uri, folder.uri));
				if (!folder && !extraResources.has(extUri.getComparisonKey(model.uri))) { continue; }
				const path = folder ? model.uri.path.slice(folder.uri.path.replace(/\/$/, '').length + 1) : model.uri.path.replace(/^\//, '');
				if (!included(path, directoryQuery)) { continue; }
				searchedModel = true;
				overridden.add(extUri.getComparisonKey(model.uri));
				const multiline = /[\r\n]/.test(directoryQuery.text);
				const text = directoryQuery.text.replace(/\r\n|\r/g, '\n');
				const expression = multiline ? (directoryQuery.patternKind === 'regex' ? text : escapeRegExpCharacters(text)).replaceAll('\n', '\\r?\\n') : text;
				const matches = model.findMatches(expression, false, multiline || directoryQuery.patternKind === 'regex', query.contentPattern.isCaseSensitive ?? false, directoryQuery.wholeWord ? query.contentPattern.wordSeparators ?? USUAL_WORD_SEPARATORS : null, false, limit - resultCount + 1);
				publish({ resource: model.uri, results: editorMatchesToTextSearchResults(matches, model) }, folder?.id ?? extUri.getComparisonKey(model.uri));
			}
			for (const folder of folders) {
				checkCancellation();
				const response = await this.contentSearch.search(folder, { ...directoryQuery, maxResults: overridden.size ? 5_000 : Math.max(1, limit - resultCount) }, {
					signal: controller.signal,
					onProgress: matches => {
						if (!active || token.isCancellationRequested) { return; }
						for (const content of matches) {
							const resource = URI.joinPath(folder.uri, content.path);
							if (!overridden.has(extUri.getComparisonKey(resource))) {
								publish({ resource, results: [textMatch(content)] }, folder.id);
							}
						}
					},
				});
				checkCancellation();
				complete.limitHit ||= response.limitHit;
				if (response.error) { complete.messages.push({ text: response.error }); }
			}
		} catch (error) {
			checkCancellation();
			if (error !== limitReached) { throw error; }
		} finally { active = false; }
		if (!folders.length && !searchedModel) { complete.messages.push({ text: localize('search.openFolder', 'Open a folder to search files.') }); }
		return complete;
	}
}

function included(path: string, query: IContentSearchQuery): boolean {
	const matches = (pattern: string, value: string): boolean => match(pattern, value) || pattern.startsWith('**/') && match(pattern.slice(3), value);
	if (query.excludePatterns.some(pattern => {
		const segments = path.split('/');
		return segments.some((_, index) => matches(pattern, segments.slice(0, index + 1).join('/')) || matches(pattern, segments.slice(0, index + 1).join('/') + '/'));
	})) { return false; }
	return !query.includePatterns.length || query.includePatterns.some(pattern => matches(pattern, path));
}

function textMatch(content: ContentSearchMatch): ITextSearchMatch {
	return {
		previewText: content.preview,
		rangeLocations: content.ranges.map(range => {
			const start = content.preview.slice(0, range.start).split(/\r\n|\r|\n/);
			const end = content.preview.slice(0, range.end).split(/\r\n|\r|\n/);
			const preview: ISearchRange = { startLineNumber: start.length - 1, startColumn: start.at(-1)!.length, endLineNumber: end.length - 1, endColumn: end.at(-1)!.length };
			return { preview, source: { ...preview, startLineNumber: content.lineNumber + preview.startLineNumber - 1, endLineNumber: content.lineNumber + preview.endLineNumber - 1 } };
		}),
	};
}
