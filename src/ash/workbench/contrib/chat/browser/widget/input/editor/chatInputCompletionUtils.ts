import type { Position } from '../../../../../../../editor/common/core/position.js';
import type { ITextModel } from '../../../../../../../editor/common/model.js';

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
