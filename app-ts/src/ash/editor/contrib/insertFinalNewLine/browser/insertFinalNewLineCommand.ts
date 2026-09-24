import { EditOperation, type ISingleEditOperation } from '../../../common/core/editOperation.js';
import { Position } from '../../../common/core/position.js';
import { Selection } from '../../../common/core/selection.js';
import type { ICommand, ICursorStateComputerData, IEditOperationBuilder } from '../../../common/editorCommon.js';
import type { ITextModel } from '../../../common/model.js';

export class InsertFinalNewLineCommand implements ICommand {
	private selectionId!: string;

	constructor(private readonly selection: Selection) {}

	public getEditOperations(model: ITextModel, builder: IEditOperationBuilder): void {
		const operation = insertFinalNewLine(model);
		builder.addEditOperation(operation.range, operation.text);
		this.selectionId = builder.trackSelection(this.selection);
	}

	public computeCursorState(_model: ITextModel, helper: ICursorStateComputerData): Selection {
		return helper.getTrackedSelection(this.selectionId);
	}
}

export function insertFinalNewLine(model: ITextModel): ISingleEditOperation {
	const lineNumber = model.getLineCount();
	return EditOperation.insert(new Position(lineNumber, model.getLineMaxColumn(lineNumber)), model.getEOL());
}
