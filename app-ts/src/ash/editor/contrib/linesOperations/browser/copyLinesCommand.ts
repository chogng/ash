import { Position } from '../../../common/core/position.js';
import { Range } from '../../../common/core/range.js';
import { Selection } from '../../../common/core/selection.js';
import { type ICommand, type ICursorStateComputerData, type IEditOperationBuilder } from '../../../common/editorCommon.js';
import { type ITextModel } from '../../../common/model.js';

/** Duplicates the physical lines covered by one selection. */
export class CopyLinesCommand implements ICommand {
	constructor(
		private readonly selection: Selection,
		private readonly isCopyingDown: boolean,
		private readonly noop = false,
	) {}

	getEditOperations(model: ITextModel, builder: IEditOperationBuilder): void {
		if (this.noop) return;
		const { startLineNumber, endLineNumber } = selectedLines(this.selection);
		const lines = lineText(model, startLineNumber, endLineNumber);
		const eol = model.getEOL();
		const position = new Position(startLineNumber, 1);
		builder.addTrackedEditOperation(Range.fromPositions(position), `${lines}${eol}`);
	}

	computeCursorState(_model: ITextModel, helper: ICursorStateComputerData): Selection {
		if (this.noop) return this.selection;
		const inserted = helper.getInverseEditOperations()[0]!.range;
		const firstLine = this.isCopyingDown ? inserted.endLineNumber : inserted.startLineNumber;
		return shiftSelection(this.selection, firstLine - this.selection.startLineNumber);
	}
}

function selectedLines(selection: Selection): { readonly startLineNumber: number; readonly endLineNumber: number } {
	const endLineNumber = !selection.isEmpty() && selection.endColumn === 1
		? Math.max(selection.startLineNumber, selection.endLineNumber - 1)
		: selection.endLineNumber;
	return { startLineNumber: selection.startLineNumber, endLineNumber };
}

function lineText(model: ITextModel, startLineNumber: number, endLineNumber: number): string {
	const lines: string[] = [];
	for (let lineNumber = startLineNumber; lineNumber <= endLineNumber; lineNumber += 1) {
		lines.push(model.getLineContent(lineNumber));
	}
	return lines.join(model.getEOL());
}

function shiftSelection(selection: Selection, lineDelta: number): Selection {
	return new Selection(
		selection.selectionStartLineNumber + lineDelta,
		selection.selectionStartColumn,
		selection.positionLineNumber + lineDelta,
		selection.positionColumn,
	);
}
