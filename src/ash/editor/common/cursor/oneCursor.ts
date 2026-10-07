import { CursorState, type ICursorSimpleModel, SelectionStartKind, SingleCursorState } from '../cursorCommon.js';
import { Position } from '../core/position.js';
import { Range } from '../core/range.js';
import { Selection } from '../core/selection.js';
import { PositionAffinity, TrackedRangeStickiness } from '../model.js';
import { type CursorContext } from './cursorContext.js';

/** Maintains one cursor in both model and view coordinates. */
export class Cursor {
	public modelState!: SingleCursorState;
	public viewState!: SingleCursorState;

	private selectionTrackedRange: string | null = null;
	private trackSelection = true;

	constructor(context: CursorContext) {
		const initial = new SingleCursorState(
			new Range(1, 1, 1, 1),
			SelectionStartKind.Simple,
			0,
			new Position(1, 1),
			0,
		);
		this.applyState(context, initial, initial);
	}

	public dispose(context: CursorContext): void {
		this.removeTrackedRange(context);
	}

	public startTrackingSelection(context: CursorContext): void {
		this.trackSelection = true;
		this.updateTrackedRange(context);
	}

	public stopTrackingSelection(context: CursorContext): void {
		this.trackSelection = false;
		this.removeTrackedRange(context);
	}

	public asCursorState(): CursorState {
		return new CursorState(this.modelState, this.viewState);
	}

	public readSelectionFromMarkers(context: CursorContext): Selection {
		if (this.selectionTrackedRange === null) throw new ReferenceError('Cursor selection is not being tracked');
		const tracked = context.model._getTrackedRange(this.selectionTrackedRange);
		if (!tracked) throw new ReferenceError('Cursor selection marker no longer exists');
		const range = this.modelState.selection.isEmpty() && !tracked.isEmpty()
			? tracked.collapseToEnd()
			: tracked;
		return Selection.fromRange(range, this.modelState.selection.getDirection());
	}

	public ensureValidState(context: CursorContext): void {
		this.applyState(context, this.modelState, this.viewState);
	}

	public setState(context: CursorContext, modelState: SingleCursorState | null, viewState: SingleCursorState | null): void {
		this.applyState(context, modelState, viewState);
	}

	private updateTrackedRange(context: CursorContext): void {
		if (!this.trackSelection) return;
		this.selectionTrackedRange = context.model._setTrackedRange(
			this.selectionTrackedRange,
			this.modelState.selection,
			TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges,
		);
	}

	private removeTrackedRange(context: CursorContext): void {
		this.selectionTrackedRange = context.model._setTrackedRange(
			this.selectionTrackedRange,
			null,
			TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges,
		);
	}

	private applyState(context: CursorContext, modelState: SingleCursorState | null, viewState: SingleCursorState | null): void {
		if (!modelState && !viewState) return;
		const validViewState = viewState ? Cursor.validateViewState(context.viewModel, viewState) : null;
		const validModelState = modelState
			? Cursor.validateModelState(context, modelState)
			: Cursor.modelStateFromViewState(context, validViewState!);
		this.modelState = validModelState;
		this.viewState = validViewState
			? Cursor.reconcileViewState(context, validModelState, validViewState)
			: Cursor.viewStateFromModelState(context, validModelState);
		this.updateTrackedRange(context);
	}

	private static validateModelState(context: CursorContext, state: SingleCursorState): SingleCursorState {
		const selectionStart = context.model.validateRange(state.selectionStart);
		const position = context.model.validatePosition(state.position);
		return new SingleCursorState(
			selectionStart,
			state.selectionStartKind,
			state.selectionStart.equalsRange(selectionStart) ? state.selectionStartLeftoverVisibleColumns : 0,
			position,
			state.position.equals(position) ? state.leftoverVisibleColumns : 0,
		);
	}

	private static validateViewState(viewModel: ICursorSimpleModel, state: SingleCursorState): SingleCursorState {
		const position = viewModel.normalizePosition(state.position, PositionAffinity.None);
		const start = viewModel.normalizePosition(state.selectionStart.getStartPosition(), PositionAffinity.None);
		const end = state.selectionStart.getEndPosition().equals(state.selectionStart.getStartPosition())
			? start
			: viewModel.normalizePosition(state.selectionStart.getEndPosition(), PositionAffinity.None);
		if (position.equals(state.position) && start.equals(state.selectionStart.getStartPosition()) && end.equals(state.selectionStart.getEndPosition())) return state;
		return new SingleCursorState(
			Range.fromPositions(start, end),
			state.selectionStartKind,
			state.selectionStartLeftoverVisibleColumns + state.selectionStart.startColumn - start.column,
			position,
			state.leftoverVisibleColumns + state.position.column - position.column,
		);
	}

	private static modelStateFromViewState(context: CursorContext, state: SingleCursorState): SingleCursorState {
		return new SingleCursorState(
			context.model.validateRange(context.coordinatesConverter.convertViewRangeToModelRange(state.selectionStart)),
			state.selectionStartKind,
			state.selectionStartLeftoverVisibleColumns,
			context.model.validatePosition(context.coordinatesConverter.convertViewPositionToModelPosition(state.position)),
			state.leftoverVisibleColumns,
		);
	}

	private static viewStateFromModelState(context: CursorContext, state: SingleCursorState): SingleCursorState {
		const start = context.coordinatesConverter.convertModelPositionToViewPosition(state.selectionStart.getStartPosition());
		const end = context.coordinatesConverter.convertModelPositionToViewPosition(state.selectionStart.getEndPosition());
		return new SingleCursorState(
			Range.fromPositions(start, end),
			state.selectionStartKind,
			state.selectionStartLeftoverVisibleColumns,
			context.coordinatesConverter.convertModelPositionToViewPosition(state.position),
			state.leftoverVisibleColumns,
		);
	}

	private static reconcileViewState(context: CursorContext, modelState: SingleCursorState, viewState: SingleCursorState): SingleCursorState {
		return new SingleCursorState(
			context.coordinatesConverter.validateViewRange(viewState.selectionStart, modelState.selectionStart),
			modelState.selectionStartKind,
			modelState.selectionStartLeftoverVisibleColumns,
			context.coordinatesConverter.validateViewPosition(viewState.position, modelState.position),
			modelState.leftoverVisibleColumns,
		);
	}
}
