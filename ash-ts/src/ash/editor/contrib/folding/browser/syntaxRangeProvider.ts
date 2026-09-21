import { StandardTokenType } from "../../../common/encodedTokenAttributes.js";
import { EditorFoldingRangeSource, type EditorFoldingRange } from "./foldingRanges.js";
import { type ILanguageConfigurationService } from '../../../common/languages/languageConfigurationRegistry.js';
import { assertLanguageId } from '../../../common/languages/language.js';
import { type TextModel } from "../../../common/model/textModel.js";

/** Computes structural folds from model brackets and configured region markers. */
export function computeEditorLanguageFoldingRanges(model: TextModel, languageId: string, configurations: ILanguageConfigurationService): readonly EditorFoldingRange[] {
	assertLanguageId(languageId);
	if (!configurations || typeof configurations.getLanguageConfiguration !== "function") {
		throw new TypeError("Language folding requires language configurations");
	}
	const configuration = configurations.getLanguageConfiguration(languageId);
	const markerStarts: number[] = [];
	const ranges: EditorFoldingRange[] = [];
	let commentStart: number | undefined;
	const blockComment = configuration.comments;
	model.bracketPairs.getBracketPairsInRange(model.getFullModelRange()).forEach(pair => {
		if (pair.closingBracketRange && isFoldOpeningToken(model.getValueInRange(pair.openingBracketRange))) {
			appendRange(ranges, pair.openingBracketRange.startLineNumber - 1, pair.closingBracketRange.startLineNumber - 1);
		}
	});
	for (let lineIndex = 0; lineIndex < model.lineCount; lineIndex += 1) {
		const line = model.getLineContent(lineIndex + 1);
		const tokens = model.tokenization.getLineTokens(lineIndex + 1);
		if (blockComment?.blockCommentStartToken && blockComment.blockCommentEndToken) {
			for (let index = 0; index < tokens.getCount(); index++) {
				if (tokens.getStandardTokenType(index) !== StandardTokenType.Comment) continue;
				const text = line.slice(tokens.getStartOffset(index), tokens.getEndOffset(index));
				if (commentStart === undefined && text.startsWith(blockComment.blockCommentStartToken)) commentStart = lineIndex;
				if (commentStart !== undefined && text.endsWith(blockComment.blockCommentEndToken)) {
					appendRange(ranges, commentStart, lineIndex);
					commentStart = undefined;
				}
			}
		}
		if (matchesMarker(configuration.foldingRules.markers?.end, line)) {
			const start = markerStarts.pop();
			if (start !== undefined) appendRange(ranges, start, lineIndex);
		} else if (matchesMarker(configuration.foldingRules.markers?.start, line)) {
			markerStarts.push(lineIndex);
		}
	}
	return Object.freeze(normalizeFoldingRanges(ranges));
}

function matchesMarker(pattern: RegExp | undefined, line: string): boolean {
	if (!pattern) return false;
	// Configuration patterns are frozen at registration time. Recreate a
	// stateless matcher so global/sticky contributions cannot mutate `lastIndex`.
	return new RegExp(pattern.source, pattern.flags.replace(/[gy]/gu, "")).test(line);
}

/** Merges independently-derived provider ranges while retaining only nested or disjoint spans. */
export function mergeEditorFoldingRanges(...sources: readonly (readonly EditorFoldingRange[])[]): readonly EditorFoldingRange[] {
	if (sources.some(source => !Array.isArray(source))) throw new TypeError("Folding range sources must be arrays");
	const ranges = sources.flat().map(range => Object.freeze({
		startLineIndex: range.startLineIndex,
		endLineIndex: range.endLineIndex,
		collapsed: false,
		source: EditorFoldingRangeSource.Provider,
	}));
	return Object.freeze(normalizeFoldingRanges(ranges));
}

function isFoldOpeningToken(token: string): boolean {
	return token === "{" || token === "[";
}

function appendRange(ranges: EditorFoldingRange[], startLineIndex: number, endLineIndex: number): void {
	if (endLineIndex <= startLineIndex) return;
	ranges.push(Object.freeze({ startLineIndex, endLineIndex, collapsed: false, source: EditorFoldingRangeSource.Provider }));
}

function normalizeFoldingRanges(ranges: readonly EditorFoldingRange[]): readonly EditorFoldingRange[] {
	const ordered = [...ranges]
		.filter(range => Number.isSafeInteger(range.startLineIndex) && Number.isSafeInteger(range.endLineIndex) && range.startLineIndex >= 0 && range.endLineIndex > range.startLineIndex)
		.sort((left, right) => left.startLineIndex - right.startLineIndex || right.endLineIndex - left.endLineIndex);
	const result: EditorFoldingRange[] = [];
	const active: EditorFoldingRange[] = [];
	for (const range of ordered) {
		while (active.length > 0 && active.at(-1)!.endLineIndex < range.startLineIndex) active.pop();
		const enclosing = active.at(-1);
		if (enclosing && range.startLineIndex === enclosing.startLineIndex) continue;
		if (enclosing && range.endLineIndex > enclosing.endLineIndex) continue;
		const previous = result.at(-1);
		if (previous && previous.startLineIndex === range.startLineIndex && previous.endLineIndex === range.endLineIndex) continue;
		const normalized = Object.freeze({ ...range, collapsed: false, source: EditorFoldingRangeSource.Provider });
		result.push(normalized);
		active.push(normalized);
	}
	return result;
}
