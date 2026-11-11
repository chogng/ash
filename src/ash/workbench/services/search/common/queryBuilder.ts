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
	return Object.fromEntries(splitGlobPatterns(value).map(pattern => [pattern, true]));
}

export function splitGlobPatterns(value: string): string[] {
	const items: string[] = [];
	let braces = 0;
	let characterClass = false;
	let start = 0;
	let escaped = false;
	for (let index = 0; index < value.length; index++) {
		const character = value[index];
		if (escaped) { escaped = false; continue; }
		if (character === '\\') { escaped = true; continue; }
		if (character === '[') characterClass = true;
		else if (character === ']') characterClass = false;
		else if (!characterClass) {
			if (character === '{') braces++;
			else if (character === '}') braces = Math.max(0, braces - 1);
			else if (character === ',' && braces === 0) { items.push(value.slice(start, index)); start = index + 1; }
		}
	}
	items.push(value.slice(start));
	return items.map(pattern => pattern.trim()).filter(Boolean);
}
