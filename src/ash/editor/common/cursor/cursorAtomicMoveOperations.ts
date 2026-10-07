import { CursorColumns } from '../core/cursorColumns.js';

export const enum Direction {
	Left,
	Right,
	Nearest,
}

export class AtomicTabMoveOperations {
	public static whitespaceVisibleColumn(lineContent: string, position: number, tabSize: number): [number, number, number] {
		let visibleColumn = 0;
		let previousTabStopPosition = -1;
		let previousTabStopVisibleColumn = -1;
		for (let index = 0; index < lineContent.length; index += 1) {
			if (index === position) return [previousTabStopPosition, previousTabStopVisibleColumn, visibleColumn];
			if (visibleColumn % tabSize === 0) {
				previousTabStopPosition = index;
				previousTabStopVisibleColumn = visibleColumn;
			}
			const character = lineContent.charCodeAt(index);
			if (character === 32) {
				visibleColumn += 1;
			} else if (character === 9) {
				visibleColumn = CursorColumns.nextRenderTabStop(visibleColumn, tabSize);
			} else {
				return [-1, -1, -1];
			}
		}
		return position === lineContent.length ? [previousTabStopPosition, previousTabStopVisibleColumn, visibleColumn] : [-1, -1, -1];
	}

	public static atomicPosition(lineContent: string, position: number, tabSize: number, direction: Direction): number {
		const [previousTabStopPosition, previousTabStopVisibleColumn, visibleColumn] = this.whitespaceVisibleColumn(lineContent, position, tabSize);
		if (visibleColumn === -1) return -1;
		if (direction === Direction.Nearest && visibleColumn % tabSize === 0) return position;
		const movesLeft = direction === Direction.Left || direction === Direction.Nearest && visibleColumn % tabSize <= tabSize / 2;
		if (movesLeft) {
			if (previousTabStopPosition === -1) return -1;
			let currentVisibleColumn = previousTabStopVisibleColumn;
			for (let index = previousTabStopPosition; index < lineContent.length; index += 1) {
				if (currentVisibleColumn === previousTabStopVisibleColumn + tabSize) return previousTabStopPosition;
				const character = lineContent.charCodeAt(index);
				if (character === 32) {
					currentVisibleColumn += 1;
				} else if (character === 9) {
					currentVisibleColumn = CursorColumns.nextRenderTabStop(currentVisibleColumn, tabSize);
				} else {
					return -1;
				}
			}
			return currentVisibleColumn === previousTabStopVisibleColumn + tabSize ? previousTabStopPosition : -1;
		}
		const targetVisibleColumn = CursorColumns.nextRenderTabStop(visibleColumn, tabSize);
		let currentVisibleColumn = visibleColumn;
		for (let index = position; index < lineContent.length; index += 1) {
			if (currentVisibleColumn === targetVisibleColumn) return index;
			const character = lineContent.charCodeAt(index);
			if (character === 32) {
				currentVisibleColumn += 1;
			} else if (character === 9) {
				currentVisibleColumn = CursorColumns.nextRenderTabStop(currentVisibleColumn, tabSize);
			} else {
				return -1;
			}
		}
		return currentVisibleColumn === targetVisibleColumn ? lineContent.length : -1;
	}
}
