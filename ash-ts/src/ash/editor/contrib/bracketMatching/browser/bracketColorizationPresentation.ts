import { type TextModel } from '../../../common/model/textModel.js';
import { Range } from '../../../common/core/range.js';
import { type BracketColorizationSource, type BracketColorizationSpan, type BracketGuide } from '../../../browser/viewParts/viewLines/viewLine.js';

/** Adapts common structural bracket levels into the editor's closed DOM vocabulary. */
export class LanguageBracketColorizationSource implements BracketColorizationSource {
	constructor(readonly textModel: TextModel, private readonly colorizeBrackets = true) {}

	getLineBrackets(lineIndex: number): readonly BracketColorizationSpan[] {
		if (!this.colorizeBrackets) return Object.freeze([]);
		const range = new Range(lineIndex + 1, 1, lineIndex + 1, this.textModel.getLineMaxColumn(lineIndex + 1));
		const brackets = this.textModel.bracketPairs.getBracketsInRange(range, true).toArray();
		return Object.freeze(brackets.flatMap(bracket => !bracket.isInvalid ? [Object.freeze({
			startColumn: bracket.range.startColumn - 1,
			endColumn: bracket.range.endColumn - 1,
			level: bracket.nestingLevel % 6 + 1,
		})] : []));
	}

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
