import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';
import type { URI } from '../../../base/common/uri.js';

export interface FileSearchDirectory {
	readonly resource: URI;
	readonly target: { readonly type: 'workspace'; readonly dirId: string; } | { readonly type: 'session'; readonly sessionId: string; readonly path: string; };
}

export interface FileSearchQuery {
	readonly includePatterns: readonly string[];
	readonly excludePatterns: readonly string[];
	readonly maxResults: number;
}

export interface FileSearchResult {
	readonly matches: readonly { readonly path: string; readonly resource: URI; }[];
	readonly totalMatches: number;
}

/** Cancellable path discovery within one workspace folder, independent of transport DTOs. */
export interface IFileSearchService {
	glob(directory: FileSearchDirectory, query: FileSearchQuery, signal?: AbortSignal): Promise<FileSearchResult>;
}

export const IFileSearchService = createServiceIdentifier<IFileSearchService>('fileSearchService');
