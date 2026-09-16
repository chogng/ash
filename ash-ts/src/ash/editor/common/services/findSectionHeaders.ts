import { regExpLeadsToEndlessLoop } from '../../../base/common/strings.js';
import { type IRange, Range } from '../core/range.js';
import { type FoldingRules } from '../languages/languageConfiguration.js';
import { isMultilineRegexSource } from '../model/textModelSearch.js';

export interface ISectionHeaderFinderTarget {
	getLineCount(): number;
	getLineContent(lineNumber: number): string;
}

export interface FindSectionHeaderOptions {
	foldingRules?: FoldingRules;
	findRegionSectionHeaders: boolean;
	findMarkSectionHeaders: boolean;
	markSectionHeaderRegex: string;
}

export interface SectionHeader {
	range: IRange;
	text: string;
	hasSeparatorLine: boolean;
	shouldBeInComments: boolean;
}

const trimDashesRegex = /^-+|-+$/g;
const CHUNK_SIZE = 100;
const MAX_SECTION_LINES = 5;

export function findSectionHeaders(model: ISectionHeaderFinderTarget, options: FindSectionHeaderOptions): SectionHeader[] {
	let headers: SectionHeader[] = [];
	if (options.findRegionSectionHeaders && options.foldingRules?.markers) headers = headers.concat(collectRegionHeaders(model, options));
	if (options.findMarkSectionHeaders) headers = headers.concat(collectMarkHeaders(model, options));
	return headers;
}

function collectRegionHeaders(model: ISectionHeaderFinderTarget, options: FindSectionHeaderOptions): SectionHeader[] {
	const headers: SectionHeader[] = [];
	for (let lineNumber = 1; lineNumber <= model.getLineCount(); lineNumber += 1) {
		const lineContent = model.getLineContent(lineNumber);
		const match = lineContent.match(options.foldingRules!.markers!.start);
		if (!match) continue;
		const range = new Range(lineNumber, match[0].length + 1, lineNumber, lineContent.length + 1);
		if (range.endColumn <= range.startColumn) continue;
		const header = { range, ...getHeaderText(lineContent.substring(match[0].length)), shouldBeInComments: false };
		if (header.text || header.hasSeparatorLine) headers.push(header);
	}
	return headers;
}

export function collectMarkHeaders(model: ISectionHeaderFinderTarget, options: FindSectionHeaderOptions): SectionHeader[] {
	const headers: SectionHeader[] = [];
	if (!options.markSectionHeaderRegex?.trim()) return headers;
	const multiline = isMultilineRegexSource(options.markSectionHeaderRegex);
	const regex = new RegExp(options.markSectionHeaderRegex, `gdm${multiline ? 's' : ''}`);
	if (regExpLeadsToEndlessLoop(regex)) return headers;
	const endLineNumber = model.getLineCount();
	for (let startLine = 1; startLine <= endLineNumber; startLine += CHUNK_SIZE - MAX_SECTION_LINES) {
		const endLine = Math.min(startLine + CHUNK_SIZE - 1, endLineNumber);
		const lines = Array.from({ length: endLine - startLine + 1 }, (_, index) => model.getLineContent(startLine + index));
		const text = lines.join('\n');
		regex.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = regex.exec(text)) !== null) {
			if (match[0].length === 0) {
				regex.lastIndex = match.index + 1;
				continue;
			}
			const precedingText = text.substring(0, match.index);
			const lineNumber = startLine + (precedingText.match(/\n/g) ?? []).length;
			const matchLines = match[0].split('\n');
			const startColumn = match.index - precedingText.lastIndexOf('\n');
			const lastMatchLine = matchLines[matchLines.length - 1]!;
			const range = new Range(
				lineNumber,
				startColumn,
				lineNumber + matchLines.length - 1,
				matchLines.length === 1 ? startColumn + match[0].length : lastMatchLine.length + 1,
			);
			const header = {
				range,
				text: (match.groups ?? {})['label'] ?? '',
				hasSeparatorLine: ((match.groups ?? {})['separator'] ?? '') !== '',
				shouldBeInComments: true,
			};
			if ((header.text || header.hasSeparatorLine) && (headers.at(-1)?.range.endLineNumber ?? -1) < header.range.startLineNumber) headers.push(header);
			regex.lastIndex = match.index + match[0].length;
		}
	}
	return headers;
}

function getHeaderText(text: string): { text: string; hasSeparatorLine: boolean } {
	text = text.trim();
	const hasSeparatorLine = text.startsWith('-');
	return { text: text.replace(trimDashesRegex, ''), hasSeparatorLine };
}
