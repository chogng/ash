import type { IContentSearchApi } from "../common/searchApi.js";
import type { IContentSearchOptions, IContentSearchQuery, IContentSearchComplete, IContentSearchService } from "../common/search.js";
import type { IWorkspaceContextService, IWorkspaceFolder } from "../../workspace/common/workspace.js";
import { raceCancellationError } from "../../../base/common/async.js";
import { FileKind, type IFileService } from '../../files/common/files.js';
import { match } from '../../../base/common/glob.js';
import { escapeRegExpCharacters } from '../../../base/common/strings.js';
import type { URI } from '../../../base/common/uri.js';
import { localize } from '../../../nls.js';

const DEFAULT_MAX_RESULTS = 2_000;
const RESULT_BATCH_SIZE = 100;
const IDLE_POLL_MILLIS = 20;

/** Searches only resources granted to the browser file provider, without a process or a server path. */
export class FileContentSearchService implements IContentSearchService {
	constructor(private readonly files: Pick<IFileService, 'readDirectory' | 'readFileBytes'>, private readonly workspaceContext: Pick<IWorkspaceContextService, 'getWorkspace'>) {}

	async search(query: IContentSearchQuery, options: IContentSearchOptions = {}): Promise<IContentSearchComplete> {
		throwIfAborted(options.signal);
		const folders = this.workspaceContext.getWorkspace().folders;
		if (!folders.length) { return { resultCount: 0, limitHit: false, error: localize('search.openFolder', 'Open a folder to search files.') }; }
		if (!query.text) { return { resultCount: 0, limitHit: false, error: undefined }; }
		const sensitive = query.caseSensitivity === 'sensitive' || (query.caseSensitivity === 'smart' && /[A-Z]/.test(query.text));
		const expression = new RegExp(query.patternKind === 'regex' ? query.text : escapeRegExpCharacters(query.text), sensitive ? 'gu' : 'giu');
		const limit = query.maxResults ?? DEFAULT_MAX_RESULTS;
		let resultCount = 0;
		let limitHit = false;
		const matchesPattern = (pattern: string, path: string): boolean => match(pattern, path) || (pattern.startsWith('**/') && match(pattern.slice(3), path));
		for (const folder of folders) {
			const visit = async (directory: URI, prefix: string): Promise<void> => {
				throwIfAborted(options.signal);
				for (const entry of await this.files.readDirectory(directory)) {
					throwIfAborted(options.signal);
					if (limitHit) { return; }
					const path = prefix + entry.name;
					if (query.excludePatterns.some(pattern => matchesPattern(pattern, path) || matchesPattern(pattern, path + '/'))) { continue; }
					if (entry.kind === FileKind.Directory) { await visit(entry.resource, path + '/'); continue; }
					if (entry.kind !== FileKind.File || (query.includePatterns.length && !query.includePatterns.some(pattern => matchesPattern(pattern, path)))) { continue; }
					const { bytes } = await this.files.readFileBytes(entry.resource);
					throwIfAborted(options.signal);
					if (bytes.includes(0)) { continue; }
					let content: string;
					try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { continue; } // Binary resources do not produce text matches.
					for (const [index, preview] of content.split(/\r\n|\r|\n/).entries()) {
						throwIfAborted(options.signal);
						const ranges = [...preview.matchAll(expression)].filter(result => result[0].length > 0).map(result => ({ start: result.index, end: result.index + result[0].length }));
						if (!ranges.length) { continue; }
						if (resultCount === limit) { limitHit = true; return; }
						resultCount++;
						options.onProgress?.([{ dirId: folder.id, dirName: folder.name, path, lineNumber: index + 1, preview, ranges }]);
					}
				}
			};
			await visit(folder.uri, '');
			if (limitHit) { break; }
		}
		return { resultCount, limitHit, error: undefined };
	}
}

/** Pulls bounded backend batches and exposes one cancellable renderer search. */
export class BrowserContentSearchService implements IContentSearchService {
	private readonly api: IContentSearchApi;

	constructor(api: IContentSearchApi, private readonly workspaceContext?: IWorkspaceContextService) {
		this.api = api;
	}

	async search(
		query: IContentSearchQuery,
		options: IContentSearchOptions = {},
	): Promise<IContentSearchComplete> {
		const folders = this.workspaceContext?.getWorkspace().folders;
		if (!folders) return this.searchFolder(undefined, query, options);
		if (folders.length === 0) return { resultCount: 0, limitHit: false, error: localize('search.openFolder', 'Open a folder to search files.') };
		let resultCount = 0;
		let limitHit = false;
		let error: string | undefined;
		const maxResults = query.maxResults ?? DEFAULT_MAX_RESULTS;
		for (const folder of folders) {
			const complete = await this.searchFolder(folder, { ...query, maxResults: maxResults - resultCount }, options);
			resultCount += complete.resultCount;
			limitHit ||= complete.limitHit;
			error ??= complete.error;
			if (resultCount >= maxResults) {
				limitHit = true;
				break;
			}
		}
		return { resultCount, limitHit, error };
	}

	private async searchFolder(
		folder: IWorkspaceFolder | undefined,
		query: IContentSearchQuery,
		options: IContentSearchOptions,
	): Promise<IContentSearchComplete> {
		throwIfAborted(options.signal);
		const started = await this.api.start({
			...(folder ? { dirId: folder.id } : {}),
			query: query.text,
			patternKind: query.patternKind,
			freshness: query.freshness ?? "current",
			caseSensitivity: query.caseSensitivity,
			includePatterns: [...query.includePatterns],
			excludePatterns: [...query.excludePatterns],
			maxResults: query.maxResults ?? DEFAULT_MAX_RESULTS,
		});
		let cursor = 0;
		try {
			while (true) {
				throwIfAborted(options.signal);
				const read = this.api.read({
					...(folder ? { dirId: folder.id } : {}),
					searchId: started.searchId,
					afterMatch: cursor,
					maxMatches: RESULT_BATCH_SIZE,
				});
				const snapshot = await (options.signal ? raceCancellationError(read, options.signal) : read);
				throwIfAborted(options.signal);
				if (snapshot.matches.length > 0) {
					cursor = snapshot.nextMatch;
					options.onProgress?.(snapshot.matches.map((match) => ({
						...match,
						...(folder ? { dirId: folder.id, dirName: folder.name } : {}),
						ranges: match.ranges.map((range) => ({ ...range })),
					})));
				}
				if (snapshot.completed) {
					return {
						resultCount: cursor,
						limitHit: snapshot.limitHit,
						error: snapshot.error ?? undefined,
					};
				}
				await waitForNextPoll(options.signal);
			}
		} catch (error) {
			throwIfAborted(options.signal);
			throw error;
		} finally {
			await this.api.cancel({
				...(folder ? { dirId: folder.id } : {}),
				searchId: started.searchId,
			}).catch(() => {
				// Cancellation is cleanup after completion or connection loss.
			});
		}
	}
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw abortError();
}

function waitForNextPoll(signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(abortError());
			return;
		}
		const onAbort = () => {
			clearTimeout(timeout);
			reject(abortError());
		};
		const timeout = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, IDLE_POLL_MILLIS);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function abortError(): DOMException {
	return new DOMException("Workspace search was cancelled", "AbortError");
}
