import { ReplaceCommand, ReplaceCommandThatPreservesSelection, ReplaceCommandWithoutChangingPosition, ReplaceCommandWithOffsetCursorState, ReplaceOvertypeCommand, ReplaceOvertypeCommandOnCompositionEnd } from '../commands/replaceCommand.js';
import { ShiftCommand } from '../commands/shiftCommand.js';
import { type CursorConfiguration, EditOperationResult, EditOperationType, isQuote } from '../cursorCommon.js';
import { Selection } from '../core/selection.js';
import { type Position } from '../core/position.js';
import { Range } from '../core/range.js';
import { normalizeTextLineEndings } from '../core/textChange.js';

import { getTextGraphemeBoundaries } from '../core/textSegmentation.js';
import { MoveOperations } from './cursorMoveOperations.js';
import { type CompositionOutcome } from './cursorTypeOperations.js';
import { type ICommand, type ICursorStateComputerData, type IEditOperationBuilder } from '../editorCommon.js';
import { type ICursorSimpleModel } from '../cursorCommon.js';
import { type ITextModel } from '../model.js';

export interface SelectionEdit {
	readonly range: Range;
	readonly text: string;
	readonly anchorOffsetInText: number;
	readonly activeOffsetInText: number;
}

export class TypeWithoutInterceptorsOperation {
	public static getEdits(prevEditOperationType: EditOperationType, selections: Selection[], text: string): EditOperationResult {
		const normalized = normalizeTextLineEndings(text);
		const type = typingOperationType(normalized, prevEditOperationType);
		return new EditOperationResult(type, selections.map(selection => new ReplaceCommand(selection, normalized)), {
			shouldPushStackElementBefore: shouldSeparateTyping(prevEditOperationType, type),
			shouldPushStackElementAfter: false,
		});
	}
}

export class SimpleCharacterTypeOperation {
	public static getEdits(config: CursorConfiguration, prevEditOperationType: EditOperationType, selections: Selection[], text: string, isDoingComposition: boolean): EditOperationResult {
		const normalized = normalizeTextLineEndings(text);
		const type = typingOperationType(normalized, prevEditOperationType);
		const commands = selections.map(selection => config.inputMode === 'overtype' && !isDoingComposition
			? new GraphemeOvertypeCommand(selection, normalized)
			: new ReplaceCommand(selection, normalized));
		return new EditOperationResult(type, commands, {
			shouldPushStackElementBefore: shouldSeparateTyping(prevEditOperationType, type),
			shouldPushStackElementAfter: false,
		});
	}
}

/** Creates the canonical commands for inserting a blank line adjacent to each cursor line. */
export class EnterOperation {
	public static lineInsertBefore(_config: CursorConfiguration, model: ITextModel | null, selections: Selection[] | null): ICommand[] {
		if (!model || !selections) return [];
		return selections.map(selection => {
			const lineNumber = selection.positionLineNumber;
			if (lineNumber === 1) {
				return new ReplaceCommandWithoutChangingPosition(new Range(1, 1, 1, 1), '\n');
			}
			const previousLineNumber = lineNumber - 1;
			const column = model.getLineMaxColumn(previousLineNumber);
			return new ReplaceCommand(new Range(previousLineNumber, column, previousLineNumber, column), '\n');
		});
	}

	public static lineInsertAfter(_config: CursorConfiguration, model: ITextModel | null, selections: Selection[] | null): ICommand[] {
		if (!model || !selections) return [];
		return selections.map(selection => {
			const lineNumber = selection.positionLineNumber;
			const column = model.getLineMaxColumn(lineNumber);
			return new ReplaceCommand(new Range(lineNumber, column, lineNumber, column), '\n');
		});
	}
}

export class AutoClosingOvertypeOperation {
	public static getEdits(prevEditOperationType: EditOperationType, config: CursorConfiguration, model: ITextModel, selections: Selection[], autoClosedCharacters: Range[], text: string): EditOperationResult | undefined {
		const normalized = normalizeTextLineEndings(text);
		if (!canOvertypeAutoClosedCharacter(config, model, selections, autoClosedCharacters, normalized)) return undefined;
		return new EditOperationResult(EditOperationType.TypingOther, selections.map(selection => {
			const position = selection.getPosition();
			return new ReplaceCommand(new Range(position.lineNumber, position.column, position.lineNumber, position.column + normalized.length), normalized);
		}), {
			shouldPushStackElementBefore: shouldSeparateTyping(prevEditOperationType, EditOperationType.TypingOther),
			shouldPushStackElementAfter: false,
		});
	}
}

export class AutoClosingOvertypeWithInterceptorsOperation {
	public static getEdits(config: CursorConfiguration, model: ITextModel, selections: Selection[], autoClosedCharacters: Range[], text: string): EditOperationResult | undefined {
		if (!canOvertypeAutoClosedCharacter(config, model, selections, autoClosedCharacters, text)) return undefined;
		return new EditOperationResult(EditOperationType.TypingOther, selections.map(selection => {
			const position = selection.getPosition();
			return new ReplaceCommand(new Range(position.lineNumber, position.column, position.lineNumber, position.column + text.length), '');
		}), {
			shouldPushStackElementBefore: true,
			shouldPushStackElementAfter: false,
		});
	}
}

export class CompositionOperation {
	public static getEdits(prevEditOperationType: EditOperationType, _config: CursorConfiguration, model: ITextModel, selections: Selection[], text: string, replacePrevCharCnt: number, replaceNextCharCnt: number, positionDelta: number): EditOperationResult {
		const normalized = normalizeTextLineEndings(text);
		const commands = selections.map(selection => {
			if (!selection.isEmpty()) {
				return new ReplaceCommandWithOffsetCursorState(selection, normalized, 0, positionDelta);
			}
			const position = selection.getPosition();
			const startColumn = Math.max(1, position.column - replacePrevCharCnt);
			const endColumn = Math.min(model.getLineMaxColumn(position.lineNumber), position.column + replaceNextCharCnt);
			return new ReplaceCommandWithOffsetCursorState(new Range(position.lineNumber, startColumn, position.lineNumber, endColumn), normalized, 0, positionDelta);
		});
		return new EditOperationResult(EditOperationType.TypingOther, commands, {
			shouldPushStackElementBefore: shouldSeparateTyping(prevEditOperationType, EditOperationType.TypingOther),
			shouldPushStackElementAfter: false,
		});
	}
}

export class CompositionEndOvertypeOperation {
	public static getEdits(config: CursorConfiguration, compositions: CompositionOutcome[]): EditOperationResult | null {
		if (config.inputMode !== 'overtype') return null;
		return new EditOperationResult(
			EditOperationType.TypingOther,
			compositions.map(composition => new ReplaceOvertypeCommandOnCompositionEnd(composition.insertedTextRange)),
			{ shouldPushStackElementBefore: true, shouldPushStackElementAfter: false },
		);
	}
}

export class PasteOperation {
	public static getEdits(config: CursorConfiguration, model: ICursorSimpleModel, selections: Selection[], text: string, pasteOnNewLine: boolean, multicursorText: string[]): EditOperationResult {
		const normalized = normalizeTextLineEndings(text);
		const texts = this.distributePasteToCursors(config, selections, normalized, pasteOnNewLine, multicursorText);
		if (texts) selections.sort(Range.compareRangesUsingStarts);
		const commands = selections.map((selection, index): ICommand => {
			const value = texts?.[index] ?? normalized;
			if (pasteOnNewLine && selection.isEmpty() && value.endsWith('\n')) {
				return new ReplaceCommandThatPreservesSelection(new Range(selection.positionLineNumber, 1, selection.positionLineNumber, 1), value, selection, true);
			}
			return config.overtypeOnPaste && config.inputMode === 'overtype'
				? new ReplaceOvertypeCommand(selection, value)
				: new ReplaceCommand(selection, value);
		});
		return new EditOperationResult(EditOperationType.Other, commands, {
			shouldPushStackElementBefore: true,
			shouldPushStackElementAfter: true,
		});
	}

	private static distributePasteToCursors(config: CursorConfiguration, selections: Selection[], text: string, pasteOnNewLine: boolean, multicursorText: string[]): string[] | null {
		if (selections.length === 1) return null;
		if (multicursorText.length === selections.length) return multicursorText.map(normalizeTextLineEndings);
		if (pasteOnNewLine || config.multiCursorPaste !== 'spread') return null;
		const lines = text.replace(/\n$/, '').split('\n');
		return lines.length === selections.length ? lines : null;
	}
}

export class TabOperation {
	public static getCommands(config: CursorConfiguration, model: ITextModel, selections: Selection[]): ICommand[] {
		return selections.map(selection => this.getCommand(config, model, selection));
	}

	private static getCommand(config: CursorConfiguration, model: ITextModel, selection: Selection): ICommand {
		if (shouldIndentLines(model, selection)) {
			return new ShiftCommand(selection, {
				isUnshift: false,
				tabSize: config.tabSize,
				indentSize: config.indentSize,
				insertSpaces: config.insertSpaces,
				useTabStops: config.useTabStops,
				autoIndent: config.autoIndent,
			}, config.languageConfigurationService);
		}

		if (!config.insertSpaces) {
			return new ReplaceCommand(selection, '\t', true);
		}

		const visibleColumn = config.visibleColumnFromColumn(model, selection.getStartPosition());
		const width = config.indentSize - (visibleColumn % config.indentSize);
		return new ReplaceCommand(selection, ' '.repeat(width), true);
	}
}

class SelectionEditCommand extends ReplaceCommand {
	constructor(range: Range, text: string, private readonly anchorOffsetInText: number, private readonly activeOffsetInText: number) {
		super(range, text);
	}

	public override computeCursorState(model: ITextModel, helper: ICursorStateComputerData): Selection {
		const range = helper.getInverseEditOperations()[0]!.range;
		const start = range.getStartPosition();
		const anchor = model.modifyPosition(start, this.anchorOffsetInText);
		const active = model.modifyPosition(start, this.activeOffsetInText);
		return Selection.fromPositions(anchor, active);
	}
}

class GraphemeOvertypeCommand implements ICommand {
	constructor(private readonly selection: Selection, private readonly text: string) {}

	public getEditOperations(model: ITextModel, builder: IEditOperationBuilder): void {
		let range: Range = this.selection;
		if (this.selection.isEmpty() && !this.text.includes('\n')) {
			const position = this.selection.getPosition();
			range = Range.fromPositions(position, advancePositionInLine(model, position, getTextGraphemeBoundaries(this.text).length - 1));
		}
		builder.addTrackedEditOperation(range, this.text);
	}

	public computeCursorState(_model: ITextModel, helper: ICursorStateComputerData): Selection {
		return Selection.fromPositions(helper.getInverseEditOperations()[0]!.range.getEndPosition());
	}
}

export class BaseTypeWithAutoClosingCommand extends SelectionEditCommand {
	public closeCharacterRange: Range | null = null;
	public enclosingRange: Range | null = null;

	constructor(selection: Range, text: string, anchorOffsetInText: number, activeOffsetInText: number, private readonly openCharacter: string, private readonly closeCharacter: string) {
		super(selection, text, anchorOffsetInText, activeOffsetInText);
	}

	public override computeCursorState(model: ITextModel, helper: ICursorStateComputerData): Selection {
		const insertedRange = helper.getInverseEditOperations()[0]!.range;
		this.closeCharacterRange = Range.fromPositions(model.modifyPosition(insertedRange.getStartPosition(), insertedRangeLength(model, insertedRange) - this.closeCharacter.length), insertedRange.getEndPosition());
		this.enclosingRange = Range.fromPositions(model.modifyPosition(insertedRange.getEndPosition(), -this.openCharacter.length - this.closeCharacter.length), insertedRange.getEndPosition());
		return super.computeCursorState(model, helper);
	}
}

function canOvertypeAutoClosedCharacter(config: CursorConfiguration, model: ITextModel, selections: Selection[], autoClosedCharacters: Range[], text: string): boolean {
	if (text.length === 0 || text.includes('\n') || config.autoClosingOvertype === 'never') return false;
	const graphemeCount = getTextGraphemeBoundaries(text).length - 1;
	return selections.every(selection => {
		if (!selection.isEmpty()) return false;
		const position = selection.getPosition();
		const end = advancePositionInLine(model, position, graphemeCount);
		return model.getValueInRange(Range.fromPositions(position, end)) === text
			&& autoClosedCharacters.some(range => range.containsPosition(position));
	});
}

function advancePositionInLine(model: ITextModel, position: Position, count: number): Position {
	let current = position;
	for (let index = 0; index < count; index += 1) {
		const next = MoveOperations.rightPosition(model, current.lineNumber, current.column);
		if (next.lineNumber !== position.lineNumber) break;
		current = next;
	}
	return current;
}

function typingOperationType(text: string, previous: EditOperationType): EditOperationType {
	if (text === ' ') return previous === EditOperationType.TypingFirstSpace || previous === EditOperationType.TypingConsecutiveSpace
		? EditOperationType.TypingConsecutiveSpace
		: EditOperationType.TypingFirstSpace;
	return EditOperationType.TypingOther;
}

function shouldSeparateTyping(previous: EditOperationType, next: EditOperationType): boolean {
	if (previous === EditOperationType.TypingFirstSpace) return false;
	const previousGroup = previous === EditOperationType.TypingConsecutiveSpace ? EditOperationType.TypingFirstSpace : previous;
	const nextGroup = next === EditOperationType.TypingConsecutiveSpace ? EditOperationType.TypingFirstSpace : next;
	return previousGroup !== nextGroup;
}

function insertedRangeLength(model: ITextModel, range: Range): number {
	return model.getValueLengthInRange(range);
}

function shouldIndentLines(model: ITextModel, selection: Selection): boolean {
	if (selection.startLineNumber !== selection.endLineNumber) {
		return true;
	}
	if (selection.startColumn === 1 && selection.endColumn === model.getLineMaxColumn(selection.startLineNumber)) {
		return true;
	}
	return selection.isEmpty() && /^\s*$/u.test(model.getLineContent(selection.startLineNumber));
}
