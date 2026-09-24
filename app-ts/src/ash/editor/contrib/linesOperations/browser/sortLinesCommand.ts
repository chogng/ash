import { Position } from '../../../common/core/position.js';
import { Range } from '../../../common/core/range.js';
import { Selection } from '../../../common/core/selection.js';
import { type ICommand, type ICursorStateComputerData, type IEditOperationBuilder } from '../../../common/editorCommon.js';
import { type ITextModel } from '../../../common/model.js';

/** Sorts the selected physical lines while preserving the selection. */
export class SortLinesCommand implements ICommand {
	private selectionId: string | undefined;

	constructor(
		private readonly selection: Selection,
		private readonly descending: boolean,
	) {}

	getEditOperations(model: ITextModel, builder: IEditOperationBuilder): void {
		this.selectionId = builder.trackSelection(this.selection);
		const data = sortData(model, this.selection, this.descending);
		if (!data || data.before.every((line, index) => line === data.after[index])) return;
		builder.addEditOperation(data.range, data.after.join(model.getEOL()));
	}

	computeCursorState(_model: ITextModel, helper: ICursorStateComputerData): Selection {
		if (!this.selectionId) throw new Error('SortLinesCommand has not collected its selection');
		return helper.getTrackedSelection(this.selectionId);
	}

	static canRun(model: ITextModel | null, selection: Selection, descending: boolean): boolean {
		if (!model) return false;
		const data = sortData(model, selection, descending);
		return !!data && data.before.some((line, index) => line !== data.after[index]);
	}
}

interface SortData {
	readonly range: Range;
	readonly before: readonly string[];
	readonly after: readonly string[];
}

function sortData(model: ITextModel, selection: Selection, descending: boolean): SortData | undefined {
	const startLineNumber = selection.startLineNumber;
	const endLineNumber = selection.endColumn === 1 ? selection.endLineNumber - 1 : selection.endLineNumber;
	if (endLineNumber <= startLineNumber) return undefined;
	const before: string[] = [];
	for (let lineNumber = startLineNumber; lineNumber <= endLineNumber; lineNumber += 1) {
		before.push(model.getLineContent(lineNumber));
	}
	const collator = new Intl.Collator(undefined, { numeric: false, sensitivity: 'variant' });
	const after = [...before].sort((left, right) => collator.compare(left, right));
	if (descending) after.reverse();
	return {
		range: Range.fromPositions(
			new Position(startLineNumber, 1),
			new Position(endLineNumber, model.getLineMaxColumn(endLineNumber)),
		),
		before,
		after,
	};
}
