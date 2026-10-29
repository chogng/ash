import { URI } from '../../../../base/common/uri.js';
import { Range } from '../../../../editor/common/core/range.js';
import type { IContentSearchQuery } from '../../../../platform/search/common/search.js';
import type { SearchResultImpl } from '../../search/browser/searchTreeModel/searchResult.js';

const header = '# Search: ';
const fileHeader = '# File: ';

/** The editable document is also the saved format; URIs keep multi-root results unambiguous. */
export function serializeSearchResultForEditor(query: IContentSearchQuery, result?: SearchResultImpl): string {
	const lines = [header + JSON.stringify({ version: 1, query }), ''];
	for (const file of result?.files ?? []) {
		lines.push(fileHeader + file.resource.toString());
		for (const match of file.matches) {
			const range = match.range;
			const preview = match.preview.slice(match.previewRange.start, match.previewRange.end).replace(/\r\n|\r|\n/g, ' ↵ ');
			lines.push(`  ${range.startLineNumber}:${range.startColumn}-${range.endLineNumber}:${range.endColumn}: ${preview}`);
		}
		lines.push('');
	}
	return lines.join('\n');
}

/** Validate user-edited and persisted headers at the document boundary. */
export function parseSearchEditor(text: string): IContentSearchQuery {
	const firstLine = text.split('\n', 1)[0]!;
	if (!firstLine.startsWith(header)) { throw new TypeError('Invalid search editor header'); }
	const value = JSON.parse(firstLine.slice(header.length)) as { version?: unknown; query?: unknown; };
	if (!value || value.version !== 1 || !value.query || typeof value.query !== 'object') { throw new TypeError('Invalid search editor format'); }
	const query = value.query as Partial<IContentSearchQuery>;
	if (typeof query.text !== 'string' || query.text.length > 16384 || query.text.includes('\0')
		|| !['literal', 'regex'].includes(query.patternKind!)
		|| !['sensitive', 'insensitive', 'smart'].includes(query.caseSensitivity!)
		|| (query.wholeWord !== undefined && typeof query.wholeWord !== 'boolean')
		|| !Array.isArray(query.includePatterns) || !query.includePatterns.every(pattern => typeof pattern === 'string')
		|| !Array.isArray(query.excludePatterns) || !query.excludePatterns.every(pattern => typeof pattern === 'string')
		|| (query.maxResults !== undefined && (!Number.isInteger(query.maxResults) || query.maxResults < 1 || query.maxResults > 5000))
		|| (query.freshness !== undefined && query.freshness !== 'current' && query.freshness !== 'indexed')) {
		throw new TypeError('Invalid search editor query');
	}
	return { text: query.text, patternKind: query.patternKind!, caseSensitivity: query.caseSensitivity!, wholeWord: query.wholeWord, includePatterns: query.includePatterns, excludePatterns: query.excludePatterns, maxResults: query.maxResults, freshness: query.freshness };
}

export function searchEditorLocation(text: string, lineNumber: number): { resource: URI; range: Range; } | undefined {
	const lines = text.split('\n');
	const row = /^ {2}(\d+):(\d+)-(\d+):(\d+): /.exec(lines[lineNumber - 1] ?? '');
	if (!row) { return undefined; }
	const coordinates = row.slice(1).map(Number);
	if (!coordinates.every(value => Number.isSafeInteger(value) && value > 0)) { return undefined; }
	const [startLine, startColumn, endLine, endColumn] = coordinates as [number, number, number, number];
	if (endLine < startLine || (endLine === startLine && endColumn < startColumn)) { return undefined; }
	for (let index = lineNumber - 2; index >= 0; index--) {
		if (lines[index]!.startsWith(fileHeader)) {
			return { resource: URI.parse(lines[index]!.slice(fileHeader.length), true), range: new Range(startLine, startColumn, endLine, endColumn) };
		}
	}
	return undefined;
}
