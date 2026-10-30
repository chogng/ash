import type { CancellationToken } from '../../../../base/common/cancellation.js';
import type { IExpression } from '../../../../base/common/glob.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import type { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const ISearchService = createDecorator<ISearchService>('searchService');

export const enum SearchProviderType { file }

export interface ISearchService {
	registerSearchResultProvider(scheme: string, type: SearchProviderType, provider: ISearchResultProvider): IDisposable;
	fileSearch(query: IFileQuery, token?: CancellationToken): Promise<ISearchComplete>;
	textSearch(query: ITextQuery, token?: CancellationToken, onProgress?: (result: ISearchProgressItem) => void): Promise<ISearchComplete>;
}

/** A file-search implementation selected by the Workbench search service. */
export interface ISearchResultProvider {
	fileSearch(query: IFileQuery, token?: CancellationToken): Promise<ISearchComplete>;
}

export const enum QueryType {
	File = 1,
	Text = 2,
}

export interface IFileQuery {
	type: QueryType.File;
	folderQueries: IFolderQuery[];
	filePattern?: string;
	shouldGlobMatchFilePattern?: boolean;
	sortByScore?: boolean;
	maxResults?: number;
	includePattern?: Readonly<Record<string, boolean>>;
	excludePattern?: Readonly<Record<string, boolean>>;
}

export interface IPatternInfo {
	pattern: string;
	isRegExp?: boolean;
	isWordMatch?: boolean;
	wordSeparators?: string;
	isCaseSensitive?: boolean;
}

export interface IFolderQuery {
	folder: URI;
	folderName?: string;
}

export interface ITextQuery {
	type: QueryType.Text;
	contentPattern: IPatternInfo;
	folderQueries: IFolderQuery[];
	extraFileResources?: URI[];
	includePattern?: IExpression;
	excludePattern?: IExpression;
	maxResults?: number;
}

/** Search coordinates are zero-based UTF-16 positions in source and preview text. */
export interface ISearchRange {
	readonly startLineNumber: number;
	readonly startColumn: number;
	readonly endLineNumber: number;
	readonly endColumn: number;
}

export interface SearchRangeSetPairing {
	source: ISearchRange;
	preview: ISearchRange;
}

export interface ITextSearchMatch {
	rangeLocations: SearchRangeSetPairing[];
	previewText: string;
}

export interface IFileMatch {
	resource: URI;
	results?: ITextSearchMatch[];
}

export interface IProgressMessage {
	message: string;
}

export type ISearchProgressItem = IFileMatch | IProgressMessage;

export interface ISearchComplete {
	results: IFileMatch[];
	limitHit?: boolean;
	messages: { text: string; }[];
}
