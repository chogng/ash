import { URI } from '../../../../base/common/uri.js';
import { Range } from '../../../../editor/common/core/range.js';
import type { IContentSearchQuery } from '../../../../platform/search/common/search.js';
import type { SearchResultImpl } from '../../search/browser/searchTreeModel/searchResult.js';

const header = '# Search: ';
const fileHeader = '# File: ';
const resultsHeader = '# Results: ';
const version = 2;

export interface SearchEditorQuery extends IContentSearchQuery {
	/** Canonical workspace root URI when opened from a folder. */
	readonly workspaceRoot?: string;
	readonly contextLines?: number;
}

interface SearchEditorMatch {
	readonly start: number;
	readonly end: number;
	readonly source: Range;
}

interface SearchEditorFile {
	readonly label: string;
	readonly resource: string;
	readonly matches: Readonly<Record<number, readonly SearchEditorMatch[]>>;
}

export interface SearchEditorResults {
	readonly text: string;
	readonly files: readonly SearchEditorFile[];
}

const emptyResults: SearchEditorResults = { text: '', files: [] };

function fileLabel(path: string, labels: Set<string>): string {
	const name = path.replace(/\r\n|\r|\n/g, ' ↵ ');
	let label = name;
	for (let index = 2; labels.has(label); index++) { label = `${name} (${index})`; }
	labels.add(label);
	return label;
}

export function createSearchEditorResults(result: SearchResultImpl, contextLines = 0, context?: ReadonlyMap<string, ReadonlyMap<number, string>>): SearchEditorResults {
	const sections: string[] = [];
	const files: SearchEditorFile[] = [];
	const labels = new Set<string>();
	const multipleRoots = new Set(result.files.map(file => file.folder?.id)).size > 1;
	for (const file of [...result.files].sort((a, b) => a.path.localeCompare(b.path))) {
		const label = fileLabel(multipleRoots && file.folder ? `${file.folder.name}/${file.path}` : file.path, labels);
		const resource = file.resource.toString();
		const matches: Record<number, SearchEditorMatch[]> = {};
		const rows = new Map<number, string>();
		const sourceLines = context?.get(resource);
		for (const match of file.matches) {
			const preview = match.preview.split(/\r\n|\r|\n/);
			const before = match.preview.slice(0, match.previewRange.start).split(/\r\n|\r|\n/);
			const after = match.preview.slice(0, match.previewRange.end).split(/\r\n|\r|\n/);
			const firstPreviewLine = match.range.startLineNumber - before.length + 1;
			for (let line = match.range.startLineNumber - contextLines; line <= match.range.endLineNumber + contextLines; line++) {
				if (line < 1) continue;
				const previewLine = line - firstPreviewLine;
				const matched = line >= match.range.startLineNumber && line <= match.range.endLineNumber;
				const row = preview[previewLine] ?? sourceLines?.get(line);
				if (row === undefined) continue;
				if (matched || !rows.has(line)) rows.set(line, row);
				if (matched) {
					(matches[line] ??= []).push({
						start: line === match.range.startLineNumber ? before.at(-1)!.length : 0,
						end: line === match.range.endLineNumber ? after.at(-1)!.length : row.length,
						source: match.range,
					});
				}
			}
		}
		const numbers = [...rows.keys()].sort((a, b) => a - b);
		const width = String(numbers.at(-1) ?? 1).length;
		const lines = [`${label}:`];
		for (const line of numbers) {
			lines.push(`  ${String(line).padStart(width)}${matches[line] ? ': ' : '  '}${rows.get(line)}`);
		}
		files.push({ label, resource, matches });
		sections.push(lines.join('\n'));
	}
	return { text: sections.length ? sections.join('\n\n') + '\n' : '', files };
}

export function serializeSearchEditorQuery(query: SearchEditorQuery): string {
	return header + JSON.stringify({ version, query });
}

export function serializeSearchEditor(query: SearchEditorQuery, results: SearchEditorResults): string {
	return serializeSearchEditorQuery(query) + '\n' + resultsHeader + JSON.stringify(results.files) + '\n\n' + results.text;
}

export function serializeSearchResultForEditor(query: SearchEditorQuery, result?: SearchResultImpl): string {
	return serializeSearchEditor(query, result ? createSearchEditorResults(result) : emptyResults);
}

/** Search attachments retain the source URI and coordinate format consumed by chat. */
export function serializeSearchContextSnapshot(query: SearchEditorQuery, result: SearchResultImpl): string {
	const lines = [header + JSON.stringify({ version: 1, query }), ''];
	for (const file of result.files) {
		lines.push(fileHeader + file.resource.toString());
		for (const match of file.matches) {
			const { startLineNumber, startColumn, endLineNumber, endColumn } = match.range;
			const preview = match.preview.slice(match.previewRange.start, match.previewRange.end).replace(/\r\n|\r|\n/g, ' ↵ ');
			lines.push(`  ${startLineNumber}:${startColumn}-${endLineNumber}:${endColumn}: ${preview}`);
		}
		lines.push('');
	}
	return lines.join('\n');
}

function readHeader(text: string): { version: 1 | 2; query: Partial<SearchEditorQuery>; } {
	const firstLine = text.split(/\r?\n/, 1)[0]!;
	if (!firstLine.startsWith(header)) { throw new TypeError('Invalid search editor header'); }
	const value = JSON.parse(firstLine.slice(header.length)) as { version?: unknown; query?: unknown; };
	if (!value || (value.version !== 1 && value.version !== 2) || !value.query || typeof value.query !== 'object') {
		throw new TypeError('Invalid search editor format');
	}
	return { version: value.version, query: value.query as Partial<SearchEditorQuery> };
}

/** Validate user-edited and persisted headers at the document boundary. */
export function parseSearchEditor(text: string): SearchEditorQuery {
	const { query } = readHeader(text);
	if (typeof query.text !== 'string' || query.text.length > 16384 || query.text.includes('\0')
		|| !['literal', 'regex'].includes(query.patternKind!)
		|| !['sensitive', 'insensitive', 'smart'].includes(query.caseSensitivity!)
		|| (query.wholeWord !== undefined && typeof query.wholeWord !== 'boolean')
		|| !Array.isArray(query.includePatterns) || !query.includePatterns.every(pattern => typeof pattern === 'string')
		|| !Array.isArray(query.excludePatterns) || !query.excludePatterns.every(pattern => typeof pattern === 'string')
		|| (query.maxResults !== undefined && (!Number.isInteger(query.maxResults) || query.maxResults < 1 || query.maxResults > 5000))
		|| (query.freshness !== undefined && query.freshness !== 'current' && query.freshness !== 'indexed')
		|| (query.contextLines !== undefined && (!Number.isInteger(query.contextLines) || query.contextLines < 0 || query.contextLines > 20))
		|| (query.workspaceRoot !== undefined && (typeof query.workspaceRoot !== 'string' || !query.workspaceRoot))) {
		throw new TypeError('Invalid search editor query');
	}
	return {
		text: query.text, patternKind: query.patternKind!, caseSensitivity: query.caseSensitivity!, wholeWord: query.wholeWord,
		includePatterns: query.includePatterns, excludePatterns: query.excludePatterns, maxResults: query.maxResults, freshness: query.freshness,
		...(query.contextLines === undefined ? {} : { contextLines: query.contextLines }),
		...(query.workspaceRoot === undefined ? {} : { workspaceRoot: query.workspaceRoot }),
	};
}

const legacyRow = /^ {2}(\d+):(\d+)-(\d+):(\d+): (.*)$/;
const resultRow = /^ +([1-9]\d*)(: |  )/;

function readLegacyResults(lines: readonly string[], labelResource: (resource: URI) => string): SearchEditorResults {
	const files: SearchEditorFile[] = [];
	const labels = new Set<string>();
	let matches: Record<number, SearchEditorMatch[]> | undefined;
	const text = lines.map(line => {
		if (line.startsWith(fileHeader)) {
			const resource = URI.parse(line.slice(fileHeader.length), true);
			const label = fileLabel(labelResource(resource), labels);
			matches = {};
			files.push({ label, resource: resource.toString(), matches });
			return `${label}:`;
		}
		const match = legacyRow.exec(line);
		if (!match || !matches) return line;
		const [startLine, startColumn, endLine, endColumn] = match.slice(1, 5).map(Number) as [number, number, number, number];
		if (!match.slice(1, 5).every(value => Number.isSafeInteger(Number(value)) && Number(value) > 0) ||
			endLine < startLine || (endLine === startLine && endColumn < startColumn)) return line;
		(matches[startLine] ??= []).push({ start: 0, end: match[5]!.length, source: new Range(startLine, startColumn, endLine, endColumn) });
		return `  ${startLine}: ${match[5]}`;
	}).join('\n');
	return { text, files };
}

function validSource(range: unknown): range is Range {
	if (!range || typeof range !== 'object') return false;
	const source = range as Range;
	const { startLineNumber, startColumn, endLineNumber, endColumn } = source;
	return [startLineNumber, startColumn, endLineNumber, endColumn].every(value => Number.isSafeInteger(value) && value > 0)
		&& (endLineNumber > startLineNumber || (endLineNumber === startLineNumber && endColumn >= startColumn));
}

function validMatch(match: unknown): match is SearchEditorMatch {
	if (!match || typeof match !== 'object') return false;
	const { start, end, source } = match as SearchEditorMatch;
	return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end >= start && validSource(source);
}

function validFile(file: unknown): file is SearchEditorFile {
	if (!file || typeof file !== 'object') return false;
	const { label, resource, matches } = file as SearchEditorFile;
	if (typeof label !== 'string' || typeof resource !== 'string' || !matches || typeof matches !== 'object') return false;
	URI.parse(resource, true);
	return Object.entries(matches).every(([line, entries]) =>
		/^[1-9]\d*$/.test(line) && Number.isSafeInteger(Number(line)) && Array.isArray(entries) && entries.every(validMatch));
}

export function readSearchEditorResults(text: string, labelResource: (resource: URI) => string): SearchEditorResults & { legacy: boolean; } {
	const { version } = readHeader(text);
	const lines = text.split(/\r\n|\r|\n/);
	lines.shift();
	if (version === 1) {
		if (lines[0] === '') lines.shift();
		return { ...readLegacyResults(lines, labelResource), legacy: true };
	}
	const metadata = lines.shift();
	if (lines[0] === '') lines.shift();
	if (!metadata?.startsWith(resultsHeader)) throw new TypeError('Invalid search editor results');
	const files: unknown = JSON.parse(metadata.slice(resultsHeader.length));
	if (!Array.isArray(files) || !files.every(validFile)) throw new TypeError('Invalid search editor results');
	return { text: lines.join('\n'), files, legacy: false };
}

export function* searchEditorRows(results: SearchEditorResults) {
	const files = new Map(results.files.map(file => [`${file.label}:`, file]));
	let file: SearchEditorFile | undefined;
	for (const [index, text] of results.text.split('\n').entries()) {
		const header = files.get(text);
		if (header) {
			file = header;
			yield { line: index + 1, file, header: true as const, text };
			continue;
		}
		const row = resultRow.exec(text);
		if (!file || !row) continue;
		const number = Number(row[1]);
		if (!Number.isSafeInteger(number)) continue;
		yield { line: index + 1, file, header: false as const, number, text, offset: row[0].length, matches: row[2] === ': ' ? file.matches[number] ?? [] : [] };
	}
}
