import { CharCode } from '../../../base/common/charCode.js';
import type { ITextBuffer } from '../model.js';

class SpacesDiffResult {
	spacesDiff = 0;
	looksLikeAlignment = false;
}

function spacesDiff(
	a: string,
	aLength: number,
	b: string,
	bLength: number,
	result: SpacesDiffResult,
): void {
	result.spacesDiff = 0;
	result.looksLikeAlignment = false;

	let sharedLength = 0;
	for (; sharedLength < aLength && sharedLength < bLength; sharedLength++) {
		if (a.charCodeAt(sharedLength) !== b.charCodeAt(sharedLength)) break;
	}

	let aSpacesCount = 0;
	let aTabsCount = 0;
	for (let index = sharedLength; index < aLength; index++) {
		if (a.charCodeAt(index) === CharCode.Space) aSpacesCount++;
		else aTabsCount++;
	}

	let bSpacesCount = 0;
	let bTabsCount = 0;
	for (let index = sharedLength; index < bLength; index++) {
		if (b.charCodeAt(index) === CharCode.Space) bSpacesCount++;
		else bTabsCount++;
	}

	if ((aSpacesCount > 0 && aTabsCount > 0) || (bSpacesCount > 0 && bTabsCount > 0)) return;

	const tabsDiff = Math.abs(aTabsCount - bTabsCount);
	const spacesCountDiff = Math.abs(aSpacesCount - bSpacesCount);
	if (tabsDiff === 0) {
		result.spacesDiff = spacesCountDiff;
		if (
			spacesCountDiff > 0
			&& bSpacesCount > 0
			&& bSpacesCount < a.length
			&& bSpacesCount < b.length
			&& b.charCodeAt(bSpacesCount) !== CharCode.Space
			&& a.charCodeAt(bSpacesCount - 1) === CharCode.Space
			&& a.charCodeAt(a.length - 1) === CharCode.Comma
		) {
			result.looksLikeAlignment = true;
		}
		return;
	}
	if (spacesCountDiff % tabsDiff === 0) result.spacesDiff = spacesCountDiff / tabsDiff;
}

export interface IGuessedIndentation {
	tabSize: number;
	insertSpaces: boolean;
}

/** Infers indentation from at most the first 10,000 physical lines. */
export function guessIndentation(
	source: ITextBuffer,
	defaultTabSize: number,
	defaultInsertSpaces: boolean,
): IGuessedIndentation {
	const linesCount = Math.min(source.getLineCount(), 10_000);
	let linesIndentedWithTabsCount = 0;
	let linesIndentedWithSpacesCount = 0;
	let previousLineText = '';
	let previousLineIndentation = 0;
	const allowedTabSizeGuesses = [2, 4, 6, 8, 3, 5, 7];
	const maximumTabSizeGuess = 8;
	const spacesDiffCount = [0, 0, 0, 0, 0, 0, 0, 0, 0];
	const temporaryResult = new SpacesDiffResult();

	for (let lineNumber = 1; lineNumber <= linesCount; lineNumber++) {
		const currentLineLength = source.getLineLength(lineNumber);
		const currentLineText = source.getLineContent(lineNumber);
		let currentLineHasContent = false;
		let currentLineIndentation = 0;
		let currentLineSpacesCount = 0;
		let currentLineTabsCount = 0;

		for (let columnIndex = 0; columnIndex < currentLineLength; columnIndex++) {
			const character = currentLineText.charCodeAt(columnIndex);
			if (character === CharCode.Tab) currentLineTabsCount++;
			else if (character === CharCode.Space) currentLineSpacesCount++;
			else {
				currentLineHasContent = true;
				currentLineIndentation = columnIndex;
				break;
			}
		}

		if (!currentLineHasContent) continue;
		if (currentLineTabsCount > 0) linesIndentedWithTabsCount++;
		else if (currentLineSpacesCount > 1) linesIndentedWithSpacesCount++;

		spacesDiff(previousLineText, previousLineIndentation, currentLineText, currentLineIndentation, temporaryResult);
		if (
			temporaryResult.looksLikeAlignment
			&& !(defaultInsertSpaces && defaultTabSize === temporaryResult.spacesDiff)
		) continue;

		if (temporaryResult.spacesDiff <= maximumTabSizeGuess) {
			spacesDiffCount[temporaryResult.spacesDiff]++;
		}
		previousLineText = currentLineText;
		previousLineIndentation = currentLineIndentation;
	}

	let insertSpaces = defaultInsertSpaces;
	if (linesIndentedWithTabsCount !== linesIndentedWithSpacesCount) {
		insertSpaces = linesIndentedWithTabsCount < linesIndentedWithSpacesCount;
	}

	let tabSize = defaultTabSize;
	if (insertSpaces) {
		let tabSizeScore = 0;
		for (const possibleTabSize of allowedTabSizeGuesses) {
			const possibleTabSizeScore = spacesDiffCount[possibleTabSize];
			if (possibleTabSizeScore > tabSizeScore) {
				tabSizeScore = possibleTabSizeScore;
				tabSize = possibleTabSize;
			}
		}
		if (
			tabSize === 4
			&& spacesDiffCount[4] > 0
			&& spacesDiffCount[2] > 0
			&& spacesDiffCount[2] >= spacesDiffCount[4] * 2 / 3
		) tabSize = 2;
	}

	return { insertSpaces, tabSize };
}
