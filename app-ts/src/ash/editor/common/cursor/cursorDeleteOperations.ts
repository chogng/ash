import * as strings from '../../../base/common/strings.js';
import { ReplaceCommand } from '../commands/replaceCommand.js';
import { type EditorAutoClosingEditStrategy, type EditorAutoClosingStrategy } from '../config/editorOptions.js';
import { CursorConfiguration, EditOperationResult, EditOperationType, type ICursorSimpleModel, isQuote } from '../cursorCommon.js';
import { CursorColumns } from '../core/cursorColumns.js';
import { Selection } from '../core/selection.js';
import { Position } from '../core/position.js';
import { Range } from '../core/range.js';
import { type ICommand } from '../editorCommon.js';
import { type StandardAutoClosingPairConditional } from '../languages/languageConfiguration.js';
import { MoveOperations } from './cursorMoveOperations.js';

export class DeleteOperations {
	public static deleteRight(prevEditOperationType: EditOperationType, config: CursorConfiguration, model: ICursorSimpleModel, selections: Selection[]): [boolean, Array<ICommand | null>] {
		const commands: Array<ICommand | null> = [];
		let shouldPushStackElementBefore = prevEditOperationType !== EditOperationType.DeletingRight;
		for (let index = 0; index < selections.length; index += 1) {
			const range = deleteRightRange(selections[index]!, model, config);
			if (range.isEmpty()) {
				commands[index] = null;
				continue;
			}
			if (range.startLineNumber !== range.endLineNumber) shouldPushStackElementBefore = true;
			commands[index] = new ReplaceCommand(range, '');
		}
		return [shouldPushStackElementBefore, commands];
	}

	public static isAutoClosingPairDelete(
		autoClosingDelete: EditorAutoClosingEditStrategy,
		autoClosingBrackets: EditorAutoClosingStrategy,
		autoClosingQuotes: EditorAutoClosingStrategy,
		autoClosingPairsOpen: Map<string, StandardAutoClosingPairConditional[]>,
		model: ICursorSimpleModel,
		selections: Selection[],
		autoClosedCharacters: Range[],
	): boolean {
		if (autoClosingDelete === 'never' || (autoClosingBrackets === 'never' && autoClosingQuotes === 'never')) return false;
		return selections.every(selection => autoClosingPairAt(
			autoClosingDelete,
			autoClosingBrackets,
			autoClosingQuotes,
			autoClosingPairsOpen,
			model,
			selection,
			autoClosedCharacters,
		) !== undefined);
	}

	public static deleteLeft(prevEditOperationType: EditOperationType, config: CursorConfiguration, model: ICursorSimpleModel, selections: Selection[], autoClosedCharacters: Range[]): [boolean, Array<ICommand | null>] {
		if (this.isAutoClosingPairDelete(config.autoClosingDelete, config.autoClosingBrackets, config.autoClosingQuotes, config.autoClosingPairs.autoClosingPairsOpenByEnd, model, selections, autoClosedCharacters)) {
			return [true, selections.map(selection => {
				const position = selection.getPosition();
				const pair = autoClosingPairAt(config.autoClosingDelete, config.autoClosingBrackets, config.autoClosingQuotes, config.autoClosingPairs.autoClosingPairsOpenByEnd, model, selection, autoClosedCharacters)!;
				return new ReplaceCommand(new Range(position.lineNumber, position.column - pair.open.length, position.lineNumber, position.column + pair.close.length), '');
			})];
		}

		const commands: Array<ICommand | null> = [];
		let shouldPushStackElementBefore = prevEditOperationType !== EditOperationType.DeletingLeft;
		for (let index = 0; index < selections.length; index += 1) {
			const range = deleteLeftRange(selections[index]!, model, config);
			if (range.isEmpty()) {
				commands[index] = null;
				continue;
			}
			if (range.startLineNumber !== range.endLineNumber) shouldPushStackElementBefore = true;
			commands[index] = new ReplaceCommand(range, '');
		}
		return [shouldPushStackElementBefore, commands];
	}

	public static cut(config: CursorConfiguration, model: ICursorSimpleModel, selections: Selection[]): EditOperationResult {
		const commands: Array<ICommand | null> = [];
		let previousRange: Range | undefined;
		const ordered = selections.map((selection, index) => ({ selection, index }))
			.sort((left, right) => Position.compare(left.selection.getStartPosition(), right.selection.getStartPosition()));
		for (const { selection, index } of ordered) {
			let range: Range | undefined;
			if (!selection.isEmpty()) {
				range = selection;
			} else if (config.emptySelectionClipboard) {
				const position = selection.getPosition();
				if (position.lineNumber < model.getLineCount()) {
					range = new Range(position.lineNumber, 1, position.lineNumber + 1, 1);
				} else if (position.lineNumber > 1 && previousRange?.endLineNumber !== position.lineNumber) {
					range = new Range(position.lineNumber - 1, model.getLineMaxColumn(position.lineNumber - 1), position.lineNumber, model.getLineMaxColumn(position.lineNumber));
				} else {
					range = new Range(position.lineNumber, 1, position.lineNumber, model.getLineMaxColumn(position.lineNumber));
				}
				previousRange = range;
			}
			commands[index] = range && !range.isEmpty() ? new ReplaceCommand(range, '') : null;
		}
		return new EditOperationResult(EditOperationType.Other, commands, {
			shouldPushStackElementBefore: true,
			shouldPushStackElementAfter: true,
		});
	}
}

function autoClosingPairAt(
	autoClosingDelete: EditorAutoClosingEditStrategy,
	autoClosingBrackets: EditorAutoClosingStrategy,
	autoClosingQuotes: EditorAutoClosingStrategy,
	autoClosingPairsOpen: Map<string, StandardAutoClosingPairConditional[]>,
	model: ICursorSimpleModel,
	selection: Selection,
	autoClosedCharacters: Range[],
): StandardAutoClosingPairConditional | undefined {
	if (!selection.isEmpty()) return undefined;
	const position = selection.getPosition();
	const line = model.getLineContent(position.lineNumber);
	if (position.column < 2 || position.column > line.length) return undefined;
	const openEnd = line.charAt(position.column - 2);
	const candidates = autoClosingPairsOpen.get(openEnd);
	const pair = candidates?.find(candidate =>
		line.slice(0, position.column - 1).endsWith(candidate.open)
		&& line.slice(position.column - 1).startsWith(candidate.close),
	);
	if (!pair) return undefined;
	if (isQuote(pair.open) ? autoClosingQuotes === 'never' : autoClosingBrackets === 'never') return undefined;
	if (autoClosingDelete === 'always') return pair;
	return autoClosedCharacters.some(range => range.startLineNumber === position.lineNumber && range.startColumn === position.column)
		? pair
		: undefined;
}

function deleteRightRange(selection: Selection, model: ICursorSimpleModel, config: CursorConfiguration): Range {
	if (!selection.isEmpty()) return selection;
	const position = selection.getPosition();
	const next = MoveOperations.right(config, model, position);
	if (config.trimWhitespaceOnDelete && next.lineNumber !== position.lineNumber) {
		const currentLineHasContent = model.getLineFirstNonWhitespaceColumn(position.lineNumber) > 0;
		const firstContentColumn = model.getLineFirstNonWhitespaceColumn(next.lineNumber);
		if (currentLineHasContent && firstContentColumn > 0) {
			return new Range(position.lineNumber, position.column, next.lineNumber, firstContentColumn);
		}
	}
	return new Range(position.lineNumber, position.column, next.lineNumber, next.column);
}

function deleteLeftRange(selection: Selection, model: ICursorSimpleModel, config: CursorConfiguration): Range {
	if (!selection.isEmpty()) return selection;
	const position = selection.getPosition();
	if (config.useTabStops && position.column > 1) {
		const line = model.getLineContent(position.lineNumber);
		const firstContentIndex = strings.firstNonWhitespaceIndex(line);
		const indentationEndColumn = firstContentIndex === -1 ? line.length + 1 : firstContentIndex + 1;
		if (position.column <= indentationEndColumn) {
			const visibleColumn = config.visibleColumnFromColumn(model, position);
			const previousTabStop = CursorColumns.prevIndentTabStop(visibleColumn, config.indentSize);
			const column = config.columnFromVisibleColumn(model, position.lineNumber, previousTabStop);
			return new Range(position.lineNumber, column, position.lineNumber, position.column);
		}
	}
	let previous = position;
	if (position.column > 1) {
		const offset = strings.getLeftDeleteOffset(position.column - 1, model.getLineContent(position.lineNumber));
		previous = position.with(undefined, offset + 1);
	} else if (position.lineNumber > 1) {
		previous = new Position(position.lineNumber - 1, model.getLineMaxColumn(position.lineNumber - 1));
	}
	return Range.fromPositions(previous, position);
}
