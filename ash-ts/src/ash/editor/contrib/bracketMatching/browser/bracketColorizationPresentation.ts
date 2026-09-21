import { type TextModel } from '../../../common/model/textModel.js';
import { Range } from '../../../common/core/range.js';
import { CursorColumns } from '../../../common/core/cursorColumns.js';
import { type BracketGuideSource, type BracketGuide } from '../../../browser/viewParts/indentGuides/indentGuides.js';

/** Supplies bracket pairs to the browser's indentation-guide layout. */
export class LanguageBracketGuideSource implements BracketGuideSource {
	constructor(readonly textModel: TextModel) {}

	getBracketGuides(startLineIndex: number, endLineIndexInclusive: number): readonly BracketGuide[] {
		const range = new Range(startLineIndex + 1, 1, endLineIndexInclusive + 1, this.textModel.getLineMaxColumn(endLineIndexInclusive + 1));
		const pairs = this.textModel.bracketPairs.getBracketPairsInRangeWithMinIndentation(range).toArray();
		const { tabSize, bracketPairColorizationOptions } = this.textModel.getOptions();
		const independent = bracketPairColorizationOptions.independentColorPoolPerBracketType;
		const column = (range: Range): number => CursorColumns.visibleColumnFromColumn(this.textModel.getLineContent(range.startLineNumber), range.startColumn, tabSize);
		return Object.freeze(pairs.filter(bracket => bracket.closingBracketRange).map(bracket => Object.freeze({
			opening: bracket.openingBracketRange,
			closing: bracket.closingBracketRange!,
			visibleColumn: Math.min(column(bracket.openingBracketRange), column(bracket.closingBracketRange!), bracket.minVisibleColumnIndentation) + 1,
			level: (independent ? bracket.nestingLevelOfEqualBracketType : bracket.nestingLevel) % 6 + 1,
		})));
	}
}
