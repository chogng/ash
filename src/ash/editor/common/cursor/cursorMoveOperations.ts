import * as strings from '../../../base/common/strings.js';
import { Constants } from '../../../base/common/uint.js';
import { CursorColumns } from '../core/cursorColumns.js';
import { Position } from '../core/position.js';
import { Range } from '../core/range.js';
import { AtomicTabMoveOperations, Direction } from './cursorAtomicMoveOperations.js';
import { CursorConfiguration, type ICursorSimpleModel, SelectionStartKind, SingleCursorState } from '../cursorCommon.js';
import { PositionAffinity } from '../model.js';

export class CursorPosition {
	_cursorPositionBrand: void = undefined;

	constructor(
		public readonly lineNumber: number,
		public readonly column: number,
		public readonly leftoverVisibleColumns: number,
	) { }
}

/** DOM-independent movement primitives over one canonical cursor state. */
export class MoveOperations {
	public static leftPosition(model: ICursorSimpleModel, position: Position): Position {
		if (position.column > model.getLineMinColumn(position.lineNumber)) {
			const amount = strings.prevCharLength(model.getLineContent(position.lineNumber), position.column - 1);
			return position.delta(undefined, -amount);
		}
		if (position.lineNumber === 1) return position;
		const lineNumber = position.lineNumber - 1;
		return new Position(lineNumber, model.getLineMaxColumn(lineNumber));
	}

	private static leftPositionAtomicSoftTabs(model: ICursorSimpleModel, position: Position, tabSize: number): Position {
		if (position.column <= model.getLineIndentColumn(position.lineNumber)) {
			const column = AtomicTabMoveOperations.atomicPosition(model.getLineContent(position.lineNumber), position.column - 1, tabSize, Direction.Left);
			if (column >= 0 && column + 1 >= model.getLineMinColumn(position.lineNumber)) {
				return new Position(position.lineNumber, column + 1);
			}
		}
		return this.leftPosition(model, position);
	}

	private static left(config: CursorConfiguration, model: ICursorSimpleModel, position: Position): CursorPosition {
		const target = config.stickyTabStops
			? this.leftPositionAtomicSoftTabs(model, position, config.tabSize)
			: this.leftPosition(model, position);
		return new CursorPosition(target.lineNumber, target.column, 0);
	}

	public static moveLeft(config: CursorConfiguration, model: ICursorSimpleModel, cursor: SingleCursorState, inSelectionMode: boolean, noOfColumns: number): SingleCursorState {
		if (cursor.hasSelection() && !inSelectionMode) {
			return cursor.move(false, cursor.selection.startLineNumber, cursor.selection.startColumn, 0);
		}
		const shifted = cursor.position.delta(undefined, -(noOfColumns - 1));
		const position = model.normalizePosition(this.clipPositionColumn(shifted, model), PositionAffinity.Left);
		const target = this.left(config, model, position);
		return cursor.move(inSelectionMode, target.lineNumber, target.column, target.leftoverVisibleColumns);
	}

	private static clipPositionColumn(position: Position, model: ICursorSimpleModel): Position {
		const min = model.getLineMinColumn(position.lineNumber);
		const max = model.getLineMaxColumn(position.lineNumber);
		return new Position(position.lineNumber, Math.min(max, Math.max(min, position.column)));
	}

	public static rightPosition(model: ICursorSimpleModel, lineNumber: number, column: number): Position {
		if (column < model.getLineMaxColumn(lineNumber)) {
			column += strings.nextCharLength(model.getLineContent(lineNumber), column - 1);
		} else if (lineNumber < model.getLineCount()) {
			lineNumber += 1;
			column = model.getLineMinColumn(lineNumber);
		}
		return model.normalizePosition(new Position(lineNumber, column), PositionAffinity.Right);
	}

	public static rightPositionAtomicSoftTabs(model: ICursorSimpleModel, lineNumber: number, column: number, tabSize: number, indentSize: number): Position {
		if (column < model.getLineIndentColumn(lineNumber)) {
			const atomicColumn = AtomicTabMoveOperations.atomicPosition(model.getLineContent(lineNumber), column - 1, tabSize, Direction.Right);
			if (atomicColumn >= 0) return new Position(lineNumber, atomicColumn + 1);
		}
		return this.rightPosition(model, lineNumber, column);
	}

	public static right(config: CursorConfiguration, model: ICursorSimpleModel, position: Position): CursorPosition {
		const target = config.stickyTabStops
			? this.rightPositionAtomicSoftTabs(model, position.lineNumber, position.column, config.tabSize, config.indentSize)
			: this.rightPosition(model, position.lineNumber, position.column);
		return new CursorPosition(target.lineNumber, target.column, 0);
	}

	public static moveRight(config: CursorConfiguration, model: ICursorSimpleModel, cursor: SingleCursorState, inSelectionMode: boolean, noOfColumns: number): SingleCursorState {
		if (cursor.hasSelection() && !inSelectionMode) {
			return cursor.move(false, cursor.selection.endLineNumber, cursor.selection.endColumn, 0);
		}
		const shifted = cursor.position.delta(undefined, noOfColumns - 1);
		const position = model.normalizePosition(this.clipPositionColumn(shifted, model), PositionAffinity.Right);
		const target = this.right(config, model, position);
		return cursor.move(inSelectionMode, target.lineNumber, target.column, target.leftoverVisibleColumns);
	}

	public static vertical(config: CursorConfiguration, model: ICursorSimpleModel, lineNumber: number, column: number, leftoverVisibleColumns: number, newLineNumber: number, allowMoveOnEdgeLine: boolean, normalizationAffinity?: PositionAffinity): CursorPosition {
		const visibleColumn = CursorColumns.visibleColumnFromColumn(model.getLineContent(lineNumber), column, config.tabSize) + leftoverVisibleColumns;
		const lineCount = model.getLineCount();
		const atFirstPosition = lineNumber === 1 && column === 1;
		const atLastPosition = lineNumber === lineCount && column === model.getLineMaxColumn(lineCount);
		const movingPastEdge = newLineNumber < lineNumber ? atFirstPosition : atLastPosition;
		lineNumber = Math.min(lineCount, Math.max(1, newLineNumber));
		if (newLineNumber < 1) {
			column = allowMoveOnEdgeLine ? model.getLineMinColumn(lineNumber) : Math.min(model.getLineMaxColumn(lineNumber), column);
		} else if (newLineNumber > lineCount) {
			column = allowMoveOnEdgeLine ? model.getLineMaxColumn(lineNumber) : Math.min(model.getLineMaxColumn(lineNumber), column);
		} else {
			column = config.columnFromVisibleColumn(model, lineNumber, visibleColumn);
		}
		leftoverVisibleColumns = movingPastEdge ? 0 : visibleColumn - CursorColumns.visibleColumnFromColumn(model.getLineContent(lineNumber), column, config.tabSize);
		if (normalizationAffinity !== undefined) {
			const normalized = model.normalizePosition(new Position(lineNumber, column), normalizationAffinity);
			leftoverVisibleColumns += column - normalized.column;
			lineNumber = normalized.lineNumber;
			column = normalized.column;
		}
		return new CursorPosition(lineNumber, column, leftoverVisibleColumns);
	}

	public static down(config: CursorConfiguration, model: ICursorSimpleModel, lineNumber: number, column: number, leftoverVisibleColumns: number, count: number, allowMoveOnLastLine: boolean): CursorPosition {
		return this.vertical(config, model, lineNumber, column, leftoverVisibleColumns, lineNumber + count, allowMoveOnLastLine, PositionAffinity.RightOfInjectedText);
	}

	public static moveDown(config: CursorConfiguration, model: ICursorSimpleModel, cursor: SingleCursorState, inSelectionMode: boolean, linesCount: number): SingleCursorState {
		const start = cursor.hasSelection() && !inSelectionMode ? cursor.selection.getEndPosition() : cursor.position;
		let target!: CursorPosition;
		let skipped = 0;
		do {
			target = this.down(config, model, start.lineNumber + skipped, start.column, cursor.leftoverVisibleColumns, linesCount, true);
			const normalized = model.normalizePosition(new Position(target.lineNumber, target.column), PositionAffinity.None);
			if (normalized.lineNumber > start.lineNumber) break;
			skipped += 1;
		} while (skipped <= 10 && start.lineNumber + skipped < model.getLineCount());
		return cursor.move(inSelectionMode, target.lineNumber, target.column, target.leftoverVisibleColumns);
	}

	public static translateDown(config: CursorConfiguration, model: ICursorSimpleModel, cursor: SingleCursorState): SingleCursorState {
		return this.translateVertical(config, model, cursor, 1);
	}

	public static up(config: CursorConfiguration, model: ICursorSimpleModel, lineNumber: number, column: number, leftoverVisibleColumns: number, count: number, allowMoveOnFirstLine: boolean): CursorPosition {
		return this.vertical(config, model, lineNumber, column, leftoverVisibleColumns, lineNumber - count, allowMoveOnFirstLine, PositionAffinity.LeftOfInjectedText);
	}

	public static moveUp(config: CursorConfiguration, model: ICursorSimpleModel, cursor: SingleCursorState, inSelectionMode: boolean, linesCount: number): SingleCursorState {
		const start = cursor.hasSelection() && !inSelectionMode ? cursor.selection.getStartPosition() : cursor.position;
		const target = this.up(config, model, start.lineNumber, start.column, cursor.leftoverVisibleColumns, linesCount, true);
		return cursor.move(inSelectionMode, target.lineNumber, target.column, target.leftoverVisibleColumns);
	}

	public static translateUp(config: CursorConfiguration, model: ICursorSimpleModel, cursor: SingleCursorState): SingleCursorState {
		return this.translateVertical(config, model, cursor, -1);
	}

	private static translateVertical(config: CursorConfiguration, model: ICursorSimpleModel, cursor: SingleCursorState, delta: -1 | 1): SingleCursorState {
		const move = delta < 0 ? this.up.bind(this) : this.down.bind(this);
		const selection = cursor.selection;
		const selectionStart = move(config, model, selection.selectionStartLineNumber, selection.selectionStartColumn, cursor.selectionStartLeftoverVisibleColumns, 1, false);
		const position = move(config, model, selection.positionLineNumber, selection.positionColumn, cursor.leftoverVisibleColumns, 1, false);
		return new SingleCursorState(
			Range.fromPositions(new Position(selectionStart.lineNumber, selectionStart.column)),
			SelectionStartKind.Simple,
			selectionStart.leftoverVisibleColumns,
			new Position(position.lineNumber, position.column),
			position.leftoverVisibleColumns,
		);
	}

	private static isBlankLine(model: ICursorSimpleModel, lineNumber: number): boolean {
		return model.getLineFirstNonWhitespaceColumn(lineNumber) === 0;
	}

	public static moveToPrevBlankLine(config: CursorConfiguration, model: ICursorSimpleModel, cursor: SingleCursorState, inSelectionMode: boolean): SingleCursorState {
		let lineNumber = cursor.position.lineNumber;
		while (lineNumber > 1 && this.isBlankLine(model, lineNumber)) lineNumber -= 1;
		while (lineNumber > 1 && !this.isBlankLine(model, lineNumber)) lineNumber -= 1;
		return cursor.move(inSelectionMode, lineNumber, model.getLineMinColumn(lineNumber), 0);
	}

	public static moveToNextBlankLine(config: CursorConfiguration, model: ICursorSimpleModel, cursor: SingleCursorState, inSelectionMode: boolean): SingleCursorState {
		const lineCount = model.getLineCount();
		let lineNumber = cursor.position.lineNumber;
		while (lineNumber < lineCount && this.isBlankLine(model, lineNumber)) lineNumber += 1;
		while (lineNumber < lineCount && !this.isBlankLine(model, lineNumber)) lineNumber += 1;
		return cursor.move(inSelectionMode, lineNumber, model.getLineMinColumn(lineNumber), 0);
	}

	public static moveToBeginningOfLine(config: CursorConfiguration, model: ICursorSimpleModel, cursor: SingleCursorState, inSelectionMode: boolean): SingleCursorState {
		const lineNumber = cursor.position.lineNumber;
		const minColumn = model.getLineMinColumn(lineNumber);
		const firstNonWhitespace = model.getLineFirstNonWhitespaceColumn(lineNumber) || minColumn;
		const column = cursor.position.column === firstNonWhitespace ? minColumn : firstNonWhitespace;
		return cursor.move(inSelectionMode, lineNumber, column, 0);
	}

	public static moveToEndOfLine(config: CursorConfiguration, model: ICursorSimpleModel, cursor: SingleCursorState, inSelectionMode: boolean, sticky: boolean): SingleCursorState {
		const lineNumber = cursor.position.lineNumber;
		const column = model.getLineMaxColumn(lineNumber);
		return cursor.move(inSelectionMode, lineNumber, column, sticky ? Constants.MAX_SAFE_SMALL_INTEGER - column : 0);
	}

	public static moveToBeginningOfBuffer(config: CursorConfiguration, model: ICursorSimpleModel, cursor: SingleCursorState, inSelectionMode: boolean): SingleCursorState {
		return cursor.move(inSelectionMode, 1, 1, 0);
	}

	public static moveToEndOfBuffer(config: CursorConfiguration, model: ICursorSimpleModel, cursor: SingleCursorState, inSelectionMode: boolean): SingleCursorState {
		const lineNumber = model.getLineCount();
		return cursor.move(inSelectionMode, lineNumber, model.getLineMaxColumn(lineNumber), 0);
	}
}
