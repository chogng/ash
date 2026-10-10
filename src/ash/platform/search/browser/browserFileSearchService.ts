import { match } from '../../../base/common/glob.js';
import { CancellationError, illegalArgument } from '../../../base/common/errors.js';
import type { URI } from '../../../base/common/uri.js';
import { FileKind, IFileService } from '../../files/common/files.js';
import type { FileFuzzyQuery, FileSearchDirectory, FileSearchQuery, FileSearchResult, IFileSearchService } from '../common/fileSearch.js';

/** Discovers only browser-granted resources when this runtime has no App Server. */
export class BrowserFileSearchService implements IFileSearchService {
	constructor(@IFileService private readonly files: Pick<IFileService, 'readDirectory'>) { }

	public async glob(directory: FileSearchDirectory, query: FileSearchQuery, signal?: AbortSignal): Promise<FileSearchResult> {
		const matches: { path: string; resource: URI; }[] = [];
		let totalMatches = 0;
		const checkCancellation = (): void => { if (signal?.aborted) { throw new CancellationError(); } };
		const matchesPattern = (pattern: string, path: string): boolean => match(pattern, path) || (pattern.startsWith('**/') && match(pattern.slice(3), path));
		const visit = async (directory: URI, prefix: string): Promise<void> => {
			checkCancellation();
			for (const entry of await this.files.readDirectory(directory)) {
				checkCancellation();
				const path = prefix + entry.name;
				if (query.excludePatterns.some(pattern => matchesPattern(pattern, path) || matchesPattern(pattern, path + '/'))) { continue; }
				if (entry.kind === FileKind.Directory) { await visit(entry.resource, path + '/'); }
				else if (entry.kind === FileKind.File && (!query.includePatterns.length || query.includePatterns.some(pattern => matchesPattern(pattern, path)))) {
					totalMatches++;
					if (matches.length < query.maxResults) { matches.push({ path, resource: entry.resource }); }
				}
			}
		};
		await visit(directory.resource, '');
		checkCancellation();
		return { matches, totalMatches };
	}

	public async fuzzy(directory: FileSearchDirectory, query: FileFuzzyQuery, signal?: AbortSignal): Promise<FileSearchResult> {
		if (new TextEncoder().encode(query.query).length > 1024 || query.query.includes('\0') || !Number.isInteger(query.maxResults) || query.maxResults < 1 || query.maxResults > 5000) {
			throw illegalArgument('query');
		}
		const tokens = query.query.toLocaleLowerCase('en-US').split(/\s+/).filter(Boolean);
		const matches: { path: string; resource: URI; score: number; }[] = [];
		let totalMatches = 0;
		const checkCancellation = (): void => { if (signal?.aborted) { throw new CancellationError(); } };
		const visit = async (directory: URI, prefix: string): Promise<void> => {
			checkCancellation();
			for (const entry of await this.files.readDirectory(directory)) {
				checkCancellation();
				const path = prefix + entry.name;
				if (entry.kind === FileKind.Directory) {
					if (!['.git', '.ash', 'node_modules', 'target'].includes(entry.name)) { await visit(entry.resource, path + '/'); }
				} else if (entry.kind === FileKind.File) {
					const score = scorePath(path, tokens);
					if (score === undefined) { continue; }
					totalMatches++;
					const candidate = { path, resource: entry.resource, score };
					let lower = 0;
					let upper = matches.length;
					while (lower < upper) {
						const middle = (lower + upper) >>> 1;
						const previous = matches[middle];
						if (previous.score > score || (previous.score === score && previous.path < path)) { lower = middle + 1; }
						else { upper = middle; }
					}
					if (lower < query.maxResults) { matches.splice(lower, 0, candidate); }
					if (matches.length > query.maxResults) { matches.pop(); }
				}
			}
		};
		await visit(directory.resource, '');
		checkCancellation();
		return { matches, totalMatches };
	}
}

// Browser-granted resources have no Rust engine; keep discovery and ranking within that grant.
function scorePath(path: string, tokens: readonly string[]): number | undefined {
	const value = path.toLocaleLowerCase('en-US');
	let score = -value.length / 100;
	for (const token of tokens) {
		let previous = -2;
		let start = 0;
		for (const character of token) {
			const index = value.indexOf(character, start);
			if (index < 0) { return undefined; }
			score += index === previous + 1 ? 8 : 2;
			if (index === 0 || /[._/ -]/.test(value[index - 1])) { score += 6; }
			previous = index;
			start = index + character.length;
		}
	}
	return score;
}
