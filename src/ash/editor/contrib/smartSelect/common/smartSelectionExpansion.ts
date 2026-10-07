import { Selection } from "../../../common/core/selection.js";
import { Position } from "../../../common/core/position.js";
import { Range } from "../../../common/core/range.js";
import { type TextModel } from "../../../common/model/textModel.js";

/** Expands one selection through word, parser, enclosing-pair, line, and document scopes. */
export function expandSmartSelection(model: TextModel, selection: Selection, syntaxRanges: readonly Range[] = []): Selection {
	const current = selection;
	const next = expandRange(model, current, syntaxRanges);
	return Selection.fromRange(next, selection.getDirection());
}

function expandRange(model: TextModel, range: Range, syntaxRanges: readonly Range[]): Range {
	if (range.isEmpty()) {
		const position = range.getStartPosition();
		const word = model.getWordAtPosition(position);
		if (word) return new Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
	}
	const structural = smallestStrictlyContainingRange(model, range, syntaxRanges);
	if (structural) return structural;
	const enclosing = findEnclosingPair(model, range);
	if (enclosing && !enclosing.equalsRange(range)) return enclosing;
	const lineStart = new Position(range.startLineNumber, 1);
	const lineEnd = new Position(range.endLineNumber, model.getLineContent(range.endLineNumber).length + 1);
	const lineRange = Range.fromPositions(lineStart, lineEnd);
	if (!lineRange.equalsRange(range)) return lineRange;
	return Range.fromPositions(new Position((0) + 1, (0) + 1), new Position((model.lineCount - 1) + 1, (model.getLineContent((model.lineCount - 1) + 1).length) + 1));
}

function smallestStrictlyContainingRange(model: TextModel, current: Range, ranges: readonly Range[]): Range | undefined {
	let best: Range | undefined;
	let bestLength = Number.POSITIVE_INFINITY;
	for (const candidate of ranges) {
		if (candidate.equalsRange(current) || !candidate.containsRange(current)) continue;
		const length = model.offsetAt(candidate.getEndPosition()) - model.offsetAt(candidate.getStartPosition());
		if (length < bestLength) {
			best = candidate;
			bestLength = length;
		}
	}
	return best;
}

function findEnclosingPair(model: TextModel, range: Range): Range | undefined {
	const pairs: readonly [string, string][] = [["(", ")"], ["[", "]"], ["{", "}"], ["\"", "\""], ["'", "'"]];
	const startOffset = model.offsetAt(range.getStartPosition());
	const endOffset = model.offsetAt(range.getEndPosition());
	const text = model.getText();
	let best: Range | undefined;
	let bestLength = Number.POSITIVE_INFINITY;
	for (const [open, close] of pairs) {
		let openOffset = text.lastIndexOf(open, Math.max(0, startOffset - 1));
		while (openOffset >= 0) {
			const closeOffset = text.indexOf(close, Math.max(openOffset + open.length, endOffset));
			if (closeOffset < 0) break;
			const candidate = Range.fromPositions(model.positionAt(openOffset), model.positionAt(closeOffset + close.length));
			const candidateLength = closeOffset + close.length - openOffset;
			if (candidate.containsRange(range) && candidateLength < bestLength) {
				best = candidate;
				bestLength = candidateLength;
			}
			openOffset = text.lastIndexOf(open, openOffset - 1);
		}
	}
	return best;
}
