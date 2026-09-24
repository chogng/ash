import { Selection } from '../core/selection.js';
import { Position } from '../core/position.js';
import { type TextModel } from '../model/textModel.js';

export class ColumnSelection {
	public static columnSelect(model: TextModel, anchor: Position, active: Position): readonly Selection[] {
		model.offsetAt(anchor);
		model.offsetAt(active);
		const firstLineNumber = Math.min(anchor.lineNumber, active.lineNumber);
		const lastLineNumber = Math.max(anchor.lineNumber, active.lineNumber);
		const selections = Array.from({ length: lastLineNumber - firstLineNumber + 1 }, (_, offset) => {
			const lineNumber = firstLineNumber + offset;
			const maxColumn = model.getLineContent(lineNumber).length + 1;
			return Selection.fromPositions(
				new Position(lineNumber, Math.min(anchor.column, maxColumn)),
				new Position(lineNumber, Math.min(active.column, maxColumn)),
			);
		});
		return Object.freeze(selections);
	}
}
