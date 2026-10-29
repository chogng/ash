import { Range } from '../../../common/core/range.js';
import { Selection } from '../../../common/core/selection.js';
import type { ICommand, ICursorStateComputerData, IEditOperationBuilder } from '../../../common/editorCommon.js';
import type { ITextModel } from '../../../common/model.js';

export class MoveCaretCommand implements ICommand {
	private nextSelection: Selection;

	constructor(private readonly selection: Selection, private readonly isMovingLeft: boolean) {
		this.nextSelection = selection;
	}

	public getEditOperations(model: ITextModel, builder: IEditOperationBuilder): void {
		const { startLineNumber, endLineNumber, startColumn, endColumn } = this.selection;
		if (startLineNumber !== endLineNumber || this.selection.isEmpty()) return;
		if (this.isMovingLeft ? startColumn === 1 : endColumn === model.getLineMaxColumn(endLineNumber)) return;

		const neighbor = this.isMovingLeft
			? new Range(startLineNumber, startColumn - 1, startLineNumber, startColumn)
			: new Range(endLineNumber, endColumn, endLineNumber, endColumn + 1);
		const affected = this.isMovingLeft
			? new Range(startLineNumber, startColumn - 1, endLineNumber, endColumn)
			: new Range(startLineNumber, startColumn, endLineNumber, endColumn + 1);
		const selectedText = model.getValueInRange(this.selection);
		const neighborText = model.getValueInRange(neighbor);
		builder.addEditOperation(affected, this.isMovingLeft ? selectedText + neighborText : neighborText + selectedText);

		const offset = this.isMovingLeft ? -1 : 1;
		this.nextSelection = new Selection(
			this.selection.selectionStartLineNumber,
			this.selection.selectionStartColumn + offset,
			this.selection.positionLineNumber,
			this.selection.positionColumn + offset,
		);
	}

	public computeCursorState(_model: ITextModel, _helper: ICursorStateComputerData): Selection {
		return this.nextSelection;
	}
}
