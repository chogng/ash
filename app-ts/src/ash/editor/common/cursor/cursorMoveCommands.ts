import * as types from '../../../base/common/types.js';
import { type ICommandMetadata } from '../../../platform/commands/common/commands.js';
import { CursorState, type ICursorSimpleModel, type PartialCursorState, SelectionStartKind, SingleCursorState } from '../cursorCommon.js';
import { type IPosition, Position } from '../core/position.js';
import { Range } from '../core/range.js';
import { type Selection } from '../core/selection.js';
import { TextDirection } from '../model.js';
import { type IViewModel } from '../viewModel.js';
import { MoveOperations } from './cursorMoveOperations.js';
import { WordOperations } from './cursorWordOperations.js';

/** Coordinates cursor movement across model and wrapped-view positions. */
export class CursorMoveCommands {
	public static addCursorDown(viewModel: IViewModel, cursors: CursorState[], useLogicalLine: boolean): PartialCursorState[] {
		return addAdjacentCursors(viewModel, cursors, useLogicalLine, 'down');
	}

	public static addCursorUp(viewModel: IViewModel, cursors: CursorState[], useLogicalLine: boolean): PartialCursorState[] {
		return addAdjacentCursors(viewModel, cursors, useLogicalLine, 'up');
	}

	public static moveToBeginningOfLine(viewModel: IViewModel, cursors: CursorState[], inSelectionMode: boolean): PartialCursorState[] {
		return cursors.map(cursor => {
			const viewPosition = cursor.viewState.position;
			const onFirstWrappedLine = viewPosition.column === cursor.modelState.position.column;
			const atViewIndent = viewPosition.column === viewModel.getLineFirstNonWhitespaceColumn(viewPosition.lineNumber);
			return onFirstWrappedLine || atViewIndent
				? CursorState.fromModelState(MoveOperations.moveToBeginningOfLine(viewModel.cursorConfig, viewModel.model, cursor.modelState, inSelectionMode))
				: CursorState.fromViewState(MoveOperations.moveToBeginningOfLine(viewModel.cursorConfig, viewModel, cursor.viewState, inSelectionMode));
		});
	}

	public static moveToEndOfLine(viewModel: IViewModel, cursors: CursorState[], inSelectionMode: boolean, sticky: boolean): PartialCursorState[] {
		return cursors.map(cursor => {
			const viewPosition = cursor.viewState.position;
			const modelPosition = cursor.modelState.position;
			const viewRemaining = viewModel.getLineMaxColumn(viewPosition.lineNumber) - viewPosition.column;
			const modelRemaining = viewModel.model.getLineMaxColumn(modelPosition.lineNumber) - modelPosition.column;
			return viewPosition.column === viewModel.getLineMaxColumn(viewPosition.lineNumber) || viewRemaining === modelRemaining
				? CursorState.fromModelState(MoveOperations.moveToEndOfLine(viewModel.cursorConfig, viewModel.model, cursor.modelState, inSelectionMode, sticky))
				: CursorState.fromViewState(MoveOperations.moveToEndOfLine(viewModel.cursorConfig, viewModel, cursor.viewState, inSelectionMode, sticky));
		});
	}

	public static expandLineSelection(viewModel: IViewModel, cursors: CursorState[]): PartialCursorState[] {
		return cursors.map(cursor => {
			const startLineNumber = cursor.modelState.selection.startLineNumber;
			const selectedEndLine = cursor.modelState.selection.endLineNumber;
			const atLastLine = selectedEndLine === viewModel.model.getLineCount();
			const endLineNumber = atLastLine ? selectedEndLine : selectedEndLine + 1;
			const endColumn = atLastLine ? viewModel.model.getLineMaxColumn(endLineNumber) : 1;
			return CursorState.fromModelState(new SingleCursorState(
				Range.fromPositions(new Position(startLineNumber, 1)), SelectionStartKind.Simple, 0,
				new Position(endLineNumber, endColumn), 0,
			));
		});
	}

	public static moveToBeginningOfBuffer(viewModel: IViewModel, cursors: CursorState[], inSelectionMode: boolean): PartialCursorState[] {
		return cursors.map(cursor => CursorState.fromModelState(MoveOperations.moveToBeginningOfBuffer(viewModel.cursorConfig, viewModel.model, cursor.modelState, inSelectionMode)));
	}

	public static moveToEndOfBuffer(viewModel: IViewModel, cursors: CursorState[], inSelectionMode: boolean): PartialCursorState[] {
		return cursors.map(cursor => CursorState.fromModelState(MoveOperations.moveToEndOfBuffer(viewModel.cursorConfig, viewModel.model, cursor.modelState, inSelectionMode)));
	}

	public static selectAll(viewModel: IViewModel, _cursor: CursorState): PartialCursorState {
		const endLineNumber = viewModel.model.getLineCount();
		return CursorState.fromModelState(new SingleCursorState(
			Range.fromPositions(new Position(1, 1)), SelectionStartKind.Simple, 0,
			new Position(endLineNumber, viewModel.model.getLineMaxColumn(endLineNumber)), 0,
		));
	}

	public static line(viewModel: IViewModel, cursor: CursorState, inSelectionMode: boolean, rawPosition: IPosition, rawViewPosition: IPosition | undefined): PartialCursorState {
		const position = viewModel.model.validatePosition(rawPosition);
		const viewPosition = rawViewPosition
			? viewModel.coordinatesConverter.validateViewPosition(Position.lift(rawViewPosition), position)
			: viewModel.coordinatesConverter.convertModelPositionToViewPosition(position);
		if (!inSelectionMode) {
			const nextLineNumber = Math.min(viewModel.model.getLineCount(), position.lineNumber + 1);
			const nextColumn = nextLineNumber === position.lineNumber ? viewModel.model.getLineMaxColumn(nextLineNumber) : 1;
			return CursorState.fromModelState(new SingleCursorState(
				new Range(position.lineNumber, 1, nextLineNumber, nextColumn), SelectionStartKind.Line, 0,
				new Position(nextLineNumber, nextColumn), 0,
			));
		}
		const anchorLine = cursor.modelState.selectionStart.startLineNumber;
		if (position.lineNumber < anchorLine) return CursorState.fromViewState(cursor.viewState.move(true, viewPosition.lineNumber, 1, 0));
		if (position.lineNumber > anchorLine) {
			const nextViewLine = Math.min(viewModel.getLineCount(), viewPosition.lineNumber + 1);
			const nextColumn = nextViewLine === viewPosition.lineNumber ? viewModel.getLineMaxColumn(nextViewLine) : 1;
			return CursorState.fromViewState(cursor.viewState.move(true, nextViewLine, nextColumn, 0));
		}
		const anchorEnd = cursor.modelState.selectionStart.getEndPosition();
		return CursorState.fromModelState(cursor.modelState.move(true, anchorEnd.lineNumber, anchorEnd.column, 0));
	}

	public static word(viewModel: IViewModel, cursor: CursorState, inSelectionMode: boolean, rawPosition: IPosition): PartialCursorState {
		const position = viewModel.model.validatePosition(rawPosition);
		return CursorState.fromModelState(WordOperations.word(viewModel.cursorConfig, viewModel.model, cursor.modelState, inSelectionMode, position));
	}

	public static cancelSelection(_viewModel: IViewModel, cursor: CursorState): PartialCursorState {
		if (!cursor.modelState.hasSelection()) return new CursorState(cursor.modelState, cursor.viewState);
		const position = cursor.viewState.position;
		return CursorState.fromViewState(cursor.viewState.move(false, position.lineNumber, position.column, 0));
	}

	public static moveTo(viewModel: IViewModel, cursor: CursorState, inSelectionMode: boolean, rawPosition: IPosition, rawViewPosition: IPosition | undefined): PartialCursorState {
		if (inSelectionMode && cursor.modelState.selectionStartKind === SelectionStartKind.Word) return this.word(viewModel, cursor, true, rawPosition);
		if (inSelectionMode && cursor.modelState.selectionStartKind === SelectionStartKind.Line) return this.line(viewModel, cursor, true, rawPosition, rawViewPosition);
		const position = viewModel.model.validatePosition(rawPosition);
		const viewPosition = rawViewPosition
			? viewModel.coordinatesConverter.validateViewPosition(Position.lift(rawViewPosition), position)
			: viewModel.coordinatesConverter.convertModelPositionToViewPosition(position);
		return CursorState.fromViewState(cursor.viewState.move(inSelectionMode, viewPosition.lineNumber, viewPosition.column, 0));
	}

	public static simpleMove(viewModel: IViewModel, cursors: CursorState[], direction: CursorMove.SimpleMoveDirection, inSelectionMode: boolean, value: number, unit: CursorMove.Unit): PartialCursorState[] | null {
		const amount = Math.max(1, Math.floor(value));
		switch (direction) {
			case CursorMove.Direction.Left:
			case CursorMove.Direction.Right:
				return cursors.map(cursor => moveHorizontal(viewModel, cursor, direction, inSelectionMode, amount, unit));
			case CursorMove.Direction.Up:
			case CursorMove.Direction.Down:
				return cursors.map(cursor => moveVertical(viewModel, cursor, direction, inSelectionMode, amount, unit));
			case CursorMove.Direction.PrevBlankLine:
			case CursorMove.Direction.NextBlankLine:
				return cursors.map(cursor => moveBlankLine(viewModel, cursor, direction, inSelectionMode, unit));
			case CursorMove.Direction.WrappedLineStart:
			case CursorMove.Direction.WrappedLineFirstNonWhitespaceCharacter:
			case CursorMove.Direction.WrappedLineColumnCenter:
			case CursorMove.Direction.WrappedLineEnd:
			case CursorMove.Direction.WrappedLineLastNonWhitespaceCharacter:
				return cursors.map(cursor => moveWithinViewLine(viewModel, cursor, direction, inSelectionMode));
			default:
				return null;
		}
	}

	public static viewportMove(viewModel: IViewModel, cursors: CursorState[], direction: CursorMove.ViewportDirection, inSelectionMode: boolean, value: number): PartialCursorState[] | null {
		if (cursors.length === 0) return [];
		const visibleViewRange = viewModel.getCompletelyVisibleViewRange();
		if (direction === CursorMove.Direction.ViewPortIfOutside) {
			return cursors.map(cursor => this.findPositionInViewportIfOutside(viewModel, cursor, visibleViewRange, inSelectionMode));
		}
		const visibleModelRange = viewModel.coordinatesConverter.convertViewRangeToModelRange(visibleViewRange);
		const amount = Math.max(1, Math.floor(value));
		let lineNumber: number;
		switch (direction) {
			case CursorMove.Direction.ViewPortTop: lineNumber = firstLineStart(viewModel.model, visibleModelRange, amount); break;
			case CursorMove.Direction.ViewPortCenter: lineNumber = Math.round((visibleModelRange.startLineNumber + visibleModelRange.endLineNumber) / 2); break;
			case CursorMove.Direction.ViewPortBottom: lineNumber = lastLineStart(viewModel.model, visibleModelRange, amount); break;
			default: return null;
		}
		const column = viewModel.model.getLineFirstNonWhitespaceColumn(lineNumber) || viewModel.model.getLineMinColumn(lineNumber);
		return [CursorState.fromModelState(cursors[0]!.modelState.move(inSelectionMode, lineNumber, column, 0))];
	}

	public static findPositionInViewportIfOutside(viewModel: IViewModel, cursor: CursorState, visibleViewRange: Range, inSelectionMode: boolean): PartialCursorState {
		const current = cursor.viewState.position;
		const lastVisibleLine = Math.max(visibleViewRange.startLineNumber, visibleViewRange.endLineNumber - 1);
		if (current.lineNumber >= visibleViewRange.startLineNumber && current.lineNumber <= lastVisibleLine) return new CursorState(cursor.modelState, cursor.viewState);
		const targetLine = Math.min(lastVisibleLine, Math.max(visibleViewRange.startLineNumber, current.lineNumber));
		const target = MoveOperations.vertical(viewModel.cursorConfig, viewModel, current.lineNumber, current.column, cursor.viewState.leftoverVisibleColumns, targetLine, false);
		return CursorState.fromViewState(cursor.viewState.move(inSelectionMode, target.lineNumber, target.column, target.leftoverVisibleColumns));
	}
}

function addAdjacentCursors(viewModel: IViewModel, cursors: CursorState[], useLogicalLine: boolean, direction: 'up' | 'down'): PartialCursorState[] {
	const result: PartialCursorState[] = [];
	const existingSelections = cursors.map(cursor => useLogicalLine ? cursor.modelState.selection : cursor.viewState.selection);
	for (const cursor of cursors) {
		result.push(new CursorState(cursor.modelState, cursor.viewState));
		const adjacent = useLogicalLine
			? CursorState.fromModelState(direction === 'up'
				? MoveOperations.translateUp(viewModel.cursorConfig, viewModel.model, cursor.modelState)
				: MoveOperations.translateDown(viewModel.cursorConfig, viewModel.model, cursor.modelState))
			: CursorState.fromViewState(direction === 'up'
				? MoveOperations.translateUp(viewModel.cursorConfig, viewModel, cursor.viewState)
				: MoveOperations.translateDown(viewModel.cursorConfig, viewModel, cursor.viewState));
		const candidate = useLogicalLine ? adjacent.modelState!.selection : adjacent.viewState!.selection;
		const occupied = existingSelections.some(selection => selectionsOverlap(selection, candidate))
			|| result.some(state => selectionsOverlap((useLogicalLine ? state.modelState?.selection : state.viewState?.selection)!, candidate));
		if (!occupied) result.push(adjacent);
	}
	return result;
}

function selectionsOverlap(left: Selection, right: Selection): boolean {
	if (left.isEmpty()) return positionOverlapsSelection(left.getPosition(), right);
	if (right.isEmpty()) return positionOverlapsSelection(right.getPosition(), left);
	return left.getStartPosition().isBefore(right.getEndPosition()) && right.getStartPosition().isBefore(left.getEndPosition());
}

function positionOverlapsSelection(position: Position, selection: Selection): boolean {
	return selection.isEmpty()
		? position.equals(selection.getPosition())
		: !position.isBefore(selection.getStartPosition()) && position.isBefore(selection.getEndPosition());
}

function moveHorizontal(viewModel: IViewModel, cursor: CursorState, direction: CursorMove.Direction.Left | CursorMove.Direction.Right, inSelectionMode: boolean, amount: number, unit: CursorMove.Unit): PartialCursorState {
	const state = cursor.viewState;
	const columns = unit === CursorMove.Unit.HalfLine ? Math.max(1, Math.round(viewModel.getLineLength(state.position.lineNumber) / 2)) : amount;
	const rtl = viewModel.getTextDirection(state.position.lineNumber) === TextDirection.RTL;
	const moveLeft = direction === CursorMove.Direction.Left ? !rtl : rtl;
	return CursorState.fromViewState(moveLeft
		? MoveOperations.moveLeft(viewModel.cursorConfig, viewModel, state, inSelectionMode, columns)
		: MoveOperations.moveRight(viewModel.cursorConfig, viewModel, state, inSelectionMode, columns));
}

function moveVertical(viewModel: IViewModel, cursor: CursorState, direction: CursorMove.Direction.Up | CursorMove.Direction.Down, inSelectionMode: boolean, amount: number, unit: CursorMove.Unit): PartialCursorState {
	if (unit === CursorMove.Unit.WrappedLine) return CursorState.fromViewState(direction === CursorMove.Direction.Up
		? MoveOperations.moveUp(viewModel.cursorConfig, viewModel, cursor.viewState, inSelectionMode, amount)
		: MoveOperations.moveDown(viewModel.cursorConfig, viewModel, cursor.viewState, inSelectionMode, amount));
	if (unit === CursorMove.Unit.FoldedLine) {
		const lineNumber = foldedTargetLine(viewModel, cursor.modelState.position.lineNumber, amount, direction);
		const lines = Math.abs(lineNumber - cursor.modelState.position.lineNumber);
		return CursorState.fromModelState(direction === CursorMove.Direction.Up
			? MoveOperations.moveUp(viewModel.cursorConfig, viewModel.model, cursor.modelState, inSelectionMode, lines)
			: MoveOperations.moveDown(viewModel.cursorConfig, viewModel.model, cursor.modelState, inSelectionMode, lines));
	}
	return CursorState.fromModelState(direction === CursorMove.Direction.Up
		? MoveOperations.moveUp(viewModel.cursorConfig, viewModel.model, cursor.modelState, inSelectionMode, amount)
		: MoveOperations.moveDown(viewModel.cursorConfig, viewModel.model, cursor.modelState, inSelectionMode, amount));
}

function foldedTargetLine(viewModel: IViewModel, startLineNumber: number, amount: number, direction: CursorMove.Direction.Up | CursorMove.Direction.Down): number {
	let lineNumber = startLineNumber;
	const step = direction === CursorMove.Direction.Up ? -1 : 1;
	for (let moved = 0; moved < amount; moved += 1) {
		lineNumber = Math.min(viewModel.model.getLineCount(), Math.max(1, lineNumber + step));
		const hidden = viewModel.getHiddenAreas().find(range => range.containsPosition(new Position(lineNumber, 1)));
		if (hidden) lineNumber = step < 0 ? hidden.startLineNumber - 1 : hidden.endLineNumber + 1;
		lineNumber = Math.min(viewModel.model.getLineCount(), Math.max(1, lineNumber));
	}
	return lineNumber;
}

function moveBlankLine(viewModel: IViewModel, cursor: CursorState, direction: CursorMove.Direction.PrevBlankLine | CursorMove.Direction.NextBlankLine, inSelectionMode: boolean, unit: CursorMove.Unit): PartialCursorState {
	const useView = unit === CursorMove.Unit.WrappedLine;
	const model = useView ? viewModel : viewModel.model;
	const state = useView ? cursor.viewState : cursor.modelState;
	const move = direction === CursorMove.Direction.PrevBlankLine ? MoveOperations.moveToPrevBlankLine : MoveOperations.moveToNextBlankLine;
	const next = move(viewModel.cursorConfig, model, state, inSelectionMode);
	return useView ? CursorState.fromViewState(next) : CursorState.fromModelState(next);
}

function moveWithinViewLine(viewModel: IViewModel, cursor: CursorState, direction: CursorMove.SimpleMoveDirection, inSelectionMode: boolean): PartialCursorState {
	const lineNumber = cursor.viewState.position.lineNumber;
	const minColumn = viewModel.getLineMinColumn(lineNumber);
	const maxColumn = viewModel.getLineMaxColumn(lineNumber);
	const firstNonWhitespace = viewModel.getLineFirstNonWhitespaceColumn(lineNumber) || minColumn;
	const lastNonWhitespace = viewModel.getLineLastNonWhitespaceColumn(lineNumber) || maxColumn;
	let column: number;
	if (direction === CursorMove.Direction.WrappedLineStart) column = minColumn;
	else if (direction === CursorMove.Direction.WrappedLineFirstNonWhitespaceCharacter) column = firstNonWhitespace;
	else if (direction === CursorMove.Direction.WrappedLineColumnCenter) column = Math.round((minColumn + maxColumn) / 2);
	else if (direction === CursorMove.Direction.WrappedLineLastNonWhitespaceCharacter) column = lastNonWhitespace;
	else column = maxColumn;
	return CursorState.fromViewState(cursor.viewState.move(inSelectionMode, lineNumber, column, 0));
}

function firstLineStart(model: ICursorSimpleModel, range: Range, count: number): number {
	const first = range.startColumn === model.getLineMinColumn(range.startLineNumber) ? range.startLineNumber : range.startLineNumber + 1;
	return Math.min(range.endLineNumber, first + count - 1);
}

function lastLineStart(model: ICursorSimpleModel, range: Range, count: number): number {
	const last = range.endColumn === model.getLineMinColumn(range.endLineNumber) ? range.endLineNumber - 1 : range.endLineNumber;
	return Math.max(range.startLineNumber, last - count + 1);
}

export namespace CursorMove {
	export const RawDirection = {
		Left: 'left', Right: 'right', Up: 'up', Down: 'down', PrevBlankLine: 'prevBlankLine', NextBlankLine: 'nextBlankLine',
		WrappedLineStart: 'wrappedLineStart', WrappedLineFirstNonWhitespaceCharacter: 'wrappedLineFirstNonWhitespaceCharacter', WrappedLineColumnCenter: 'wrappedLineColumnCenter',
		WrappedLineEnd: 'wrappedLineEnd', WrappedLineLastNonWhitespaceCharacter: 'wrappedLineLastNonWhitespaceCharacter',
		ViewPortTop: 'viewPortTop', ViewPortCenter: 'viewPortCenter', ViewPortBottom: 'viewPortBottom', ViewPortIfOutside: 'viewPortIfOutside',
	} as const;
	export const RawUnit = { Line: 'line', WrappedLine: 'wrappedLine', Character: 'character', HalfLine: 'halfLine', FoldedLine: 'foldedLine' } as const;
	export interface RawArguments { to: string; select?: boolean; by?: string; value?: number; noHistory?: boolean }
	export interface ParsedArguments { direction: Direction; unit: Unit; select: boolean; value: number; noHistory: boolean }
	export interface SimpleMoveArguments { direction: SimpleMoveDirection; unit: Unit; select: boolean; value: number }

	function isCursorMoveArgs(value: unknown): boolean {
		if (!types.isObject(value)) return false;
		const args = value as Partial<RawArguments>;
		return types.isString(args.to) && (types.isUndefined(args.select) || types.isBoolean(args.select))
			&& (types.isUndefined(args.by) || types.isString(args.by)) && (types.isUndefined(args.value) || types.isNumber(args.value))
			&& (types.isUndefined(args.noHistory) || types.isBoolean(args.noHistory));
	}

	export const metadata: ICommandMetadata = {
		description: 'Move the cursor to a logical editor position',
		args: [{ name: 'Cursor move arguments', constraint: isCursorMoveArgs, schema: {
			type: 'object', required: ['to'], properties: {
				to: { type: 'string', enum: Object.values(RawDirection) }, by: { type: 'string', enum: Object.values(RawUnit) },
				value: { type: 'number', default: 1 }, select: { type: 'boolean', default: false }, noHistory: { type: 'boolean', default: false },
			},
		} }],
	};

	export function parse(args: Partial<RawArguments>): ParsedArguments | null {
		const direction = directionByName.get(args.to ?? '');
		if (direction === undefined) return null;
		return { direction, unit: unitByName.get(args.by ?? '') ?? Unit.None, select: args.select === true, value: args.value || 1, noHistory: args.noHistory === true };
	}

	export enum Direction {
		Left, Right, Up, Down, PrevBlankLine, NextBlankLine,
		WrappedLineStart, WrappedLineFirstNonWhitespaceCharacter, WrappedLineColumnCenter, WrappedLineEnd, WrappedLineLastNonWhitespaceCharacter,
		ViewPortTop, ViewPortCenter, ViewPortBottom, ViewPortIfOutside,
	}
	export type SimpleMoveDirection = Direction.Left | Direction.Right | Direction.Up | Direction.Down | Direction.PrevBlankLine | Direction.NextBlankLine | Direction.WrappedLineStart | Direction.WrappedLineFirstNonWhitespaceCharacter | Direction.WrappedLineColumnCenter | Direction.WrappedLineEnd | Direction.WrappedLineLastNonWhitespaceCharacter;
	export type ViewportDirection = Direction.ViewPortTop | Direction.ViewPortCenter | Direction.ViewPortBottom | Direction.ViewPortIfOutside;
	export enum Unit { None, Line, WrappedLine, Character, HalfLine, FoldedLine }

	const directionByName = new Map<string, Direction>([
		[RawDirection.Left, Direction.Left], [RawDirection.Right, Direction.Right], [RawDirection.Up, Direction.Up], [RawDirection.Down, Direction.Down],
		[RawDirection.PrevBlankLine, Direction.PrevBlankLine], [RawDirection.NextBlankLine, Direction.NextBlankLine], [RawDirection.WrappedLineStart, Direction.WrappedLineStart],
		[RawDirection.WrappedLineFirstNonWhitespaceCharacter, Direction.WrappedLineFirstNonWhitespaceCharacter], [RawDirection.WrappedLineColumnCenter, Direction.WrappedLineColumnCenter],
		[RawDirection.WrappedLineEnd, Direction.WrappedLineEnd], [RawDirection.WrappedLineLastNonWhitespaceCharacter, Direction.WrappedLineLastNonWhitespaceCharacter],
		[RawDirection.ViewPortTop, Direction.ViewPortTop], [RawDirection.ViewPortCenter, Direction.ViewPortCenter], [RawDirection.ViewPortBottom, Direction.ViewPortBottom], [RawDirection.ViewPortIfOutside, Direction.ViewPortIfOutside],
	]);
	const unitByName = new Map<string, Unit>([[RawUnit.Line, Unit.Line], [RawUnit.WrappedLine, Unit.WrappedLine], [RawUnit.Character, Unit.Character], [RawUnit.HalfLine, Unit.HalfLine], [RawUnit.FoldedLine, Unit.FoldedLine]]);
}
