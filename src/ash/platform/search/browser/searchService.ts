import type { IContentSearchApi } from "../common/searchApi.js";
import type { IContentSearchOptions, IContentSearchQuery, IContentSearchComplete, IContentSearchService } from "../common/search.js";
import type { IWorkspaceFolder } from "../../workspace/common/workspace.js";
import { raceCancellationError } from "../../../base/common/async.js";
import { FileKind, type IFileService } from '../../files/common/files.js';
import { match } from '../../../base/common/glob.js';
import { escapeRegExpCharacters } from '../../../base/common/strings.js';
import type { URI } from '../../../base/common/uri.js';

const DEFAULT_MAX_RESULTS = 2_000;
const RESULT_BATCH_SIZE = 100;
const IDLE_POLL_MILLIS = 20;

/** Searches only resources granted to the browser file provider, without a process or a server path. */
export class FileContentSearchService implements IContentSearchService {
	constructor(private readonly files: Pick<IFileService, 'readDirectory' | 'readFileBytes'>) { }

	async search(folder: IWorkspaceFolder, query: IContentSearchQuery, options: IContentSearchOptions = {}): Promise<IContentSearchComplete> {
		throwIfAborted(options.signal);
		if (!query.text) { return { resultCount: 0, limitHit: false, error: undefined }; }
		const sensitive = query.caseSensitivity === 'sensitive' || (query.caseSensitivity === 'smart' && /\p{Lu}/u.test(query.text));
		const pattern = query.text.replace(/\r\n|\r/g, '\n');
		const expression = new RegExp(query.patternKind === 'regex' ? pattern : escapeRegExpCharacters(pattern), sensitive ? 'gmu' : 'gmiu');
		const limit = query.maxResults ?? DEFAULT_MAX_RESULTS;
		let resultCount = 0;
		let limitHit = false;
		const matchesPattern = (pattern: string, path: string): boolean => match(pattern, path) || (pattern.startsWith('**/') && match(pattern.slice(3), path));
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
				content = content.replace(/\r\n|\r/g, '\n');
				const lineStarts = [0];
				for (let offset = content.indexOf('\n'); offset >= 0; offset = content.indexOf('\n', offset + 1)) { lineStarts.push(offset + 1); }
				let lineIndex = 0;
				const blocks = new Map<string, { lineNumber: number; preview: string; ranges: { start: number; end: number; }[]; }>();
				for (const found of content.matchAll(expression)) {
					throwIfAborted(options.signal);
					if (!found[0].length) { continue; }
					const start = found.index;
					const end = start + found[0].length;
					if (query.wholeWord && (/[\p{L}\p{N}_]$/u.test(content.slice(Math.max(0, start - 2), start)) || /^[\p{L}\p{N}_]/u.test(content.slice(end, end + 2)))) { continue; }
					while (lineIndex + 1 < lineStarts.length && lineStarts[lineIndex + 1]! <= start) { lineIndex++; }
					const blockStart = lineStarts[lineIndex]!;
					const nextLine = content.indexOf('\n', end);
					const blockEnd = nextLine < 0 ? content.length : nextLine;
					const key = `${blockStart}:${blockEnd}`;
					let block = blocks.get(key);
					if (!block) {
						if (resultCount === limit) { limitHit = true; break; }
						resultCount++;
						block = { lineNumber: lineIndex + 1, preview: content.slice(blockStart, blockEnd), ranges: [] };
						blocks.set(key, block);
					}
					block.ranges.push({ start: start - blockStart, end: end - blockStart });
				}
				const results = [...blocks.values()].map(block => ({ dirId: folder.id, dirName: folder.name, path, ...block }));
				for (let offset = 0; offset < results.length; offset += RESULT_BATCH_SIZE) {
					options.onProgress?.(results.slice(offset, offset + RESULT_BATCH_SIZE));
					throwIfAborted(options.signal);
				}
			}
		};
		await visit(folder.uri, '');
		return { resultCount, limitHit, error: undefined };
	}
}

/** Pulls bounded backend batches and exposes one cancellable renderer search. */
export class BrowserContentSearchService implements IContentSearchService {
	private readonly api: IContentSearchApi;

	constructor(api: IContentSearchApi) {
		this.api = api;
	}

	public async search(
		folder: IWorkspaceFolder,
		query: IContentSearchQuery,
		options: IContentSearchOptions = {},
	): Promise<IContentSearchComplete> {
		throwIfAborted(options.signal);
		const start = this.api.start({
			dirId: folder.id,
			query: query.wholeWord ? `\\b(?:${query.patternKind === 'regex' ? query.text : escapeRegExpCharacters(query.text.replace(/\r\n|\r/g, '\n')).replaceAll('\n', '\\r?\\n')})\\b` : query.text,
			patternKind: query.wholeWord ? 'regex' : query.patternKind,
			freshness: query.freshness ?? "current",
			caseSensitivity: query.caseSensitivity,
			includePatterns: [...query.includePatterns],
			excludePatterns: [...query.excludePatterns],
			maxResults: query.maxResults ?? DEFAULT_MAX_RESULTS,
		});
		let started: Awaited<typeof start>;
		try {
			started = await (options.signal ? raceCancellationError(start, options.signal) : start);
		} catch (error) {
			if (options.signal?.aborted) {
				// Cancellation ends renderer waiting now; a handle delivered later still belongs to this call.
				void start.then(job => this.api.cancel({ dirId: folder.id, searchId: job.searchId })).catch(() => { /* Failed starts have no handle; a closed connection already owns cleanup. */ });
			}
			throwIfAborted(options.signal);
			throw error;
		}
		let cursor = 0;
		try {
			while (true) {
				throwIfAborted(options.signal);
				const read = this.api.read({
					dirId: folder.id,
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
						dirId: folder.id, dirName: folder.name,
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
				dirId: folder.id,
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
