import { normalizeTextLineEndings } from '../../../common/core/textChange.js';
import { Range } from '../../../common/core/range.js';
import { Selection } from '../../../common/core/selection.js';
import { type ICursorStateComputerData, type IEditOperationBuilder, type ICommand } from '../../../common/editorCommon.js';
import { type TextModel } from '../../../common/model/textModel.js';

/** Applies a find/replace result as one edit while retaining the editor selection. */
export class ReplaceAllCommand implements ICommand {
	private trackedSelectionId: string | null = null;

	constructor(
		private readonly editorSelection: Selection,
		private readonly ranges: Range[],
		private readonly replaceStrings: string[],
	) {
		if (ranges.length !== replaceStrings.length) throw new RangeError('Text search replacements must match the result count');
	}

	public getEditOperations(_model: TextModel, builder: IEditOperationBuilder): void {
		const edits = this.ranges.map((range, index) => ({ range, text: normalizeTextLineEndings(this.replaceStrings[index]!) }));
		edits.sort((left, right) => Range.compareRangesUsingStarts(left.range, right.range));
		let previous = edits[0];
		for (let index = 1; index < edits.length; index++) {
			const current = edits[index]!;
			if (Range.areIntersecting(previous.range, current.range) && !previous.range.getEndPosition().equals(current.range.getStartPosition())) {
				throw new RangeError('Text search matches must not overlap');
			}
			if (previous.range.getEndPosition().equals(current.range.getStartPosition())) {
				previous = { range: previous.range.plusRange(current.range), text: previous.text + current.text };
			} else {
				builder.addEditOperation(previous.range, previous.text);
				previous = current;
			}
		}
		if (previous) builder.addEditOperation(previous.range, previous.text);
		this.trackedSelectionId = builder.trackSelection(this.editorSelection);
	}

	public computeCursorState(_model: TextModel, helper: ICursorStateComputerData): Selection {
		return helper.getTrackedSelection(this.trackedSelectionId!);
	}
}
