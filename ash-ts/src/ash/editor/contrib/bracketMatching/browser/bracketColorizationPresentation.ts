import { type TextModel } from '../../../common/model/textModel.js';
import { Range } from '../../../common/core/range.js';
import { type BracketGuideSource, type BracketGuide } from '../../../browser/viewParts/indentGuides/indentGuides.js';

/** Supplies bracket pairs to the browser's indentation-guide layout. */
export class LanguageBracketGuideSource implements BracketGuideSource {
	constructor(readonly textModel: TextModel) {}

	getBracketGuides(startLineIndex: number, endLineIndexInclusive: number): readonly BracketGuide[] {
		const range = new Range(startLineIndex + 1, 1, endLineIndexInclusive + 1, this.textModel.getLineMaxColumn(endLineIndexInclusive + 1));
		const pairs = this.textModel.bracketPairs.getBracketPairsInRange(range).toArray();
		return Object.freeze(pairs.filter(bracket => bracket.closingBracketRange).map(bracket => Object.freeze({
			opening: bracket.openingBracketRange,
			closing: bracket.closingBracketRange!,
			level: bracket.nestingLevel % 6 + 1,
		})));
	}
}
