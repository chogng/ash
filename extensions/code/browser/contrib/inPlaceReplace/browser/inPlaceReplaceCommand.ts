import { Range } from '../../../../../../src/ash/editor/common/core/range.js';
import { Selection } from '../../../../../../src/ash/editor/common/core/selection.js';
import { type ICommand, type ICursorStateComputerData, type IEditOperationBuilder } from '../../../../../../src/ash/editor/common/editorCommon.js';
import { type ITextModel } from '../../../../../../src/ash/editor/common/model.js';

/** Applies one value-set replacement and keeps the replaced value selected. */
export class InPlaceReplaceCommand implements ICommand {
	constructor(
		private readonly editRange: Range,
		private readonly originalSelection: Selection,
		private readonly text: string,
	) { }

	getEditOperations(_model: ITextModel, builder: IEditOperationBuilder): void {
		builder.addTrackedEditOperation(this.editRange, this.text);
	}

	computeCursorState(_model: ITextModel, helper: ICursorStateComputerData): Selection {
		const range = helper.getInverseEditOperations()[0]!.range;
		if (!this.originalSelection.isEmpty()) {
			return new Selection(range.endLineNumber, range.endColumn - this.text.length, range.endLineNumber, range.endColumn);
		}
		const column = Math.min(this.originalSelection.positionColumn, range.endColumn);
		return new Selection(range.endLineNumber, column, range.endLineNumber, column);
	}
}
