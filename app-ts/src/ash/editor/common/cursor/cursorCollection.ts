import { CursorState, type PartialCursorState } from '../cursorCommon.js';
import { Position } from '../core/position.js';
import { Range } from '../core/range.js';
import { type ISelection, Selection } from '../core/selection.js';
import { type CursorContext } from './cursorContext.js';
import { Cursor } from './oneCursor.js';

export class CursorCollection {
	private cursors: Cursor[];
	private lastAddedCursorIndex = 0;

	constructor(private context: CursorContext) {
		this.cursors = [new Cursor(context)];
	}

	public dispose(): void {
		for (const cursor of this.cursors) cursor.dispose(this.context);
	}

	public startTrackingSelections(): void {
		for (const cursor of this.cursors) cursor.startTrackingSelection(this.context);
	}

	public stopTrackingSelections(): void {
		for (const cursor of this.cursors) cursor.stopTrackingSelection(this.context);
	}

	public updateContext(context: CursorContext): void {
		this.context = context;
	}

	public ensureValidState(): void {
		for (const cursor of this.cursors) cursor.ensureValidState(this.context);
	}

	public readSelectionFromMarkers(): Selection[] {
		return this.cursors.map(cursor => cursor.readSelectionFromMarkers(this.context));
	}

	public getAll(): CursorState[] {
		return this.cursors.map(cursor => cursor.asCursorState());
	}

	public getViewPositions(): Position[] {
		return this.cursors.map(cursor => cursor.viewState.position);
	}

	public getTopMostViewPosition(): Position {
		return this.cursors.reduce((top, cursor) => Position.compare(cursor.viewState.position, top) < 0 ? cursor.viewState.position : top, this.cursors[0]!.viewState.position);
	}

	public getBottomMostViewPosition(): Position {
		return this.cursors.reduce((bottom, cursor) => Position.compare(cursor.viewState.position, bottom) >= 0 ? cursor.viewState.position : bottom, this.cursors[0]!.viewState.position);
	}

	public getSelections(): Selection[] {
		return this.cursors.map(cursor => cursor.modelState.selection);
	}

	public getViewSelections(): Selection[] {
		return this.cursors.map(cursor => cursor.viewState.selection);
	}

	public setSelections(selections: ISelection[]): void {
		this.setStates(CursorState.fromModelSelections(selections));
	}

	public getPrimaryCursor(): CursorState {
		return this.cursors[0]!.asCursorState();
	}

	public setStates(states: PartialCursorState[] | null): void {
		if (states === null) return;
		if (states.length === 0) throw new RangeError('Cursor states must not be empty');
		this.cursors[0]!.setState(this.context, states[0]!.modelState, states[0]!.viewState);
		this.setSecondaryStates(states.slice(1));
	}

	public killSecondaryCursors(): void {
		this.setSecondaryStates([]);
	}

	public getLastAddedCursorIndex(): number {
		return this.cursors.length === 1 || this.lastAddedCursorIndex === 0 ? 0 : this.lastAddedCursorIndex;
	}

	public normalize(): void {
		if (this.cursors.length === 1 || !this.context.cursorConfig.multiCursorMergeOverlapping) return;
		const cursors = [...this.cursors];
		const sorted = cursors.map((cursor, index) => ({ index, selection: cursor.modelState.selection }))
			.sort((left, right) => Range.compareRangesUsingStarts(left.selection, right.selection));

		for (let sortedIndex = 0; sortedIndex < sorted.length - 1; sortedIndex += 1) {
			const current = sorted[sortedIndex]!;
			const next = sorted[sortedIndex + 1]!;
			const overlaps = current.selection.isEmpty() || next.selection.isEmpty()
				? next.selection.getStartPosition().isBeforeOrEqual(current.selection.getEndPosition())
				: next.selection.getStartPosition().isBefore(current.selection.getEndPosition());
			if (!overlaps) continue;

			const winnerSortedIndex = current.index < next.index ? sortedIndex : sortedIndex + 1;
			const loserSortedIndex = winnerSortedIndex === sortedIndex ? sortedIndex + 1 : sortedIndex;
			const winner = sorted[winnerSortedIndex]!;
			const loser = sorted[loserSortedIndex]!;
			if (!winner.selection.equalsSelection(loser.selection)) {
				const range = winner.selection.plusRange(loser.selection);
				const direction = loser.index === this.lastAddedCursorIndex
					? loser.selection.getDirection()
					: winner.selection.getDirection();
				winner.selection = Selection.fromRange(range, direction);
				const state = CursorState.fromModelSelection(winner.selection);
				cursors[winner.index]!.setState(this.context, state.modelState, state.viewState);
			}
			if (loser.index === this.lastAddedCursorIndex) this.lastAddedCursorIndex = winner.index;
			for (const entry of sorted) if (entry.index > loser.index) entry.index -= 1;
			cursors.splice(loser.index, 1);
			sorted.splice(loserSortedIndex, 1);
			this.removeSecondaryCursor(loser.index - 1);
			sortedIndex -= 1;
		}
	}

	private setSecondaryStates(states: PartialCursorState[]): void {
		while (this.cursors.length - 1 < states.length) this.addSecondaryCursor();
		while (this.cursors.length - 1 > states.length) this.removeSecondaryCursor(this.cursors.length - 2);
		for (let index = 0; index < states.length; index += 1) {
			const state = states[index]!;
			this.cursors[index + 1]!.setState(this.context, state.modelState, state.viewState);
		}
	}

	private addSecondaryCursor(): void {
		this.cursors.push(new Cursor(this.context));
		this.lastAddedCursorIndex = this.cursors.length - 1;
	}

	private removeSecondaryCursor(index: number): void {
		if (this.lastAddedCursorIndex >= index + 1) this.lastAddedCursorIndex -= 1;
		this.cursors[index + 1]!.dispose(this.context);
		this.cursors.splice(index + 1, 1);
	}
}
