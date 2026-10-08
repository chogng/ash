import { match } from '../../../base/common/glob.js';
import { CancellationError } from '../../../base/common/errors.js';
import type { URI } from '../../../base/common/uri.js';
import { FileKind, IFileService } from '../../files/common/files.js';
import type { FileSearchDirectory, FileSearchQuery, FileSearchResult, IFileSearchService } from '../common/fileSearch.js';

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
}
