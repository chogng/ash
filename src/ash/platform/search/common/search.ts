import type { IWorkspaceFolder } from '../../workspace/common/workspace.js';
import { createServiceIdentifier } from "../../instantiation/common/instantiation.js";

export type ContentSearchPatternKind = "literal" | "regex";
export type ContentSearchFreshness = "indexed" | "current";
export type ContentSearchCaseSensitivity = "smart" | "sensitive" | "insensitive";

export interface ContentSearchMatchRange {
	start: number;
	end: number;
}

export interface ContentSearchMatch {
	readonly dirId?: string;
	readonly dirName?: string;
	readonly path: string;
	readonly lineNumber: number;
	readonly preview: string;
	readonly ranges: readonly ContentSearchMatchRange[];
}

/** A content query applied to the selected directory. */
export interface IContentSearchQuery {
	readonly text: string;
	readonly wholeWord?: boolean;
	readonly patternKind: ContentSearchPatternKind;
	readonly caseSensitivity: ContentSearchCaseSensitivity;
	readonly includePatterns: readonly string[];
	readonly excludePatterns: readonly string[];
	readonly maxResults?: number;
	readonly freshness?: ContentSearchFreshness;
}

/** Terminal metadata returned after all available result batches are consumed. */
export interface IContentSearchComplete {
	readonly resultCount: number;
	readonly limitHit: boolean;
	readonly error: string | undefined;
}

/** Runtime controls for one cancellable directory search. */
export interface IContentSearchOptions {
	readonly signal?: AbortSignal;
	readonly onProgress?: (
		matches: readonly ContentSearchMatch[],
	) => void;
}

/** Renderer-facing directory search lifecycle independent of Electron IPC. */
export interface IContentSearchService {
	search(directory: IWorkspaceFolder, query: IContentSearchQuery, options?: IContentSearchOptions): Promise<IContentSearchComplete>;
}

export const IContentSearchService = createServiceIdentifier<IContentSearchService>("contentSearchService");

export type ContentSearchEngine = 'tgrep' | 'ripgrep';

export interface ContentSearchConfiguration {
	readonly revision: number;
	readonly engine: ContentSearchEngine;
}

/** Backend-owned indexed search preference; Current content searches always use ripgrep. */
export interface IContentSearchConfigurationService {
	read(): Promise<ContentSearchConfiguration>;
	configure(engine: ContentSearchEngine, expectedRevision: number): Promise<void>;
}

export const IContentSearchConfigurationService = createServiceIdentifier<IContentSearchConfigurationService>('contentSearchConfigurationService');
