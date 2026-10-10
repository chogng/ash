import type { IExpression } from '../../../../base/common/glob.js';
import type { URI } from '../../../../base/common/uri.js';
import { QueryType, type IFileQuery, type IPatternInfo, type ITextQuery } from './search.js';

export interface ITextQueryBuilderOptions {
	includePattern?: string;
	excludePattern?: string;
	maxResults?: number;
	extraFileResources?: URI[];
}

export interface IFileQueryBuilderOptions {
	filePattern?: string;
	shouldGlobMatchFilePattern?: boolean;
	sortByScore?: boolean;
	maxResults?: number;
}

/** Freezes UI query inputs before workspace execution starts. */
export class QueryBuilder {
	public file(folderResources: URI[], options: IFileQueryBuilderOptions = {}): IFileQuery {
		return {
			type: QueryType.File,
			folderQueries: folderResources.map(folder => ({ folder })),
			filePattern: options.filePattern?.trim(),
			shouldGlobMatchFilePattern: options.shouldGlobMatchFilePattern,
			sortByScore: options.sortByScore,
			maxResults: options.maxResults,
		};
	}

	public text(contentPattern: IPatternInfo, folderResources: URI[] = [], options: ITextQueryBuilderOptions = {}): ITextQuery {
		return {
			type: QueryType.Text,
			contentPattern: { ...contentPattern },
			folderQueries: folderResources.map(folder => ({ folder })),
			includePattern: patterns(options.includePattern),
			excludePattern: patterns(options.excludePattern),
			maxResults: options.maxResults,
			extraFileResources: options.extraFileResources?.slice(),
		};
	}
}

function patterns(value: string | undefined): IExpression | undefined {
	if (!value) { return undefined; }
	return Object.fromEntries(value.split(',').map(pattern => pattern.trim()).filter(Boolean).map(pattern => [pattern, true]));
}
