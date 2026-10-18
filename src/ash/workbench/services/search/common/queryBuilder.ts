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
	includePattern?: string;
	excludePattern?: string;
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
			includePattern: patterns(options.includePattern),
			excludePattern: patterns(options.excludePattern),
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

function patterns(value: string | undefined): Record<string, boolean> | undefined {
	if (!value) { return undefined; }
	const items: string[] = [];
	let depth = 0;
	let start = 0;
	let escaped = false;
	for (let index = 0; index < value.length; index++) {
		const character = value[index];
		if (escaped) { escaped = false; continue; }
		if (character === '\\') { escaped = true; continue; }
		if (character === '{' || character === '[') depth++;
		else if (character === '}' || character === ']') depth = Math.max(0, depth - 1);
		else if (character === ',' && depth === 0) { items.push(value.slice(start, index)); start = index + 1; }
	}
	items.push(value.slice(start));
	return Object.fromEntries(items.map(pattern => pattern.trim()).filter(Boolean).map(pattern => [pattern, true]));
}
