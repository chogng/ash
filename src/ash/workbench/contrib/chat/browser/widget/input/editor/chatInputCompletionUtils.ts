import type { Position } from '../../../../../../../editor/common/core/position.js';
import { Range } from '../../../../../../../editor/common/core/range.js';
import type { IWordAtPosition } from '../../../../../../../editor/common/core/wordHelper.js';
import type { ITextModel } from '../../../../../../../editor/common/model.js';

export interface IChatCompletionRangeResult {
	insert: Range;
	replace: Range;
	varWord: IWordAtPosition | null;
}

/** Keeps the typed prefix separate from the complete token that accepting a suggestion replaces. */
export function computeCompletionRanges(model: ITextModel, position: Position, reg: RegExp, onlyOnWordStart = false): IChatCompletionRangeResult | undefined {
	const line = model.getLineContent(position.lineNumber);
	const offset = position.column - 1;
	const pattern = new RegExp(reg.source, reg.flags.includes('g') ? reg.flags : `${reg.flags}g`);
	for (const match of line.matchAll(pattern)) {
		const start = match.index;
		const end = start + match[0].length;
		if (!match[0] || offset < start || offset > end) {
			continue;
		}
		if (onlyOnWordStart && start > 0 && !/\s/u.test(line[start - 1]!)) {
			return undefined;
		}
		return {
			insert: new Range(position.lineNumber, start + 1, position.lineNumber, position.column),
			replace: new Range(position.lineNumber, start + 1, position.lineNumber, end + 1),
			varWord: { word: match[0], startColumn: start + 1, endColumn: end + 1 },
		};
	}
	if (offset > 0 && !/\s/u.test(line[offset - 1]!)) {
		return undefined;
	}
	return { insert: Range.fromPositions(position), replace: Range.fromPositions(position), varWord: null };
}

export function getCompletionRangeWord(rangeResult: IChatCompletionRangeResult): string | undefined {
	return rangeResult.varWord?.word.substring(0, rangeResult.insert.endColumn - rangeResult.insert.startColumn);
}

/** Keeps host queries on advertised tokens, including arguments of a line-leading slash command. */
export function isAtTriggerCharacterToken(model: ITextModel, position: Position, triggerCharacters: readonly string[]): boolean {
	const prefix = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
	if (triggerCharacters.includes('/') && prefix.trimStart().startsWith('/')) {
		return true;
	}
	let start = prefix.length;
	while (start > 0 && !/\s/u.test(prefix[start - 1]!)) {
		start--;
	}
	return start < prefix.length && triggerCharacters.includes(prefix[start]!);
}
