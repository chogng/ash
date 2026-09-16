import { type LanguageBracketPairs } from "../../../common/languages/languageBracketPairs.js";
import { Selection } from "../../../common/core/selection.js";
import { type Range } from '../../../common/core/range.js';
import { type ICursorStateComputerData, type IEditOperationBuilder, type ICommand } from '../../../common/editorCommon.js';
import { type ITextModel } from '../../../common/model.js';


/** Removes every distinct matched bracket pair containing a collapsed cursor. */
export function createRemoveMatchingBracketsCommand(bracketPairs: LanguageBracketPairs, selections: readonly Selection[]): (ICommand | null)[] | undefined {
	let hasMatch = false;
	const commands = selections.map(selection => {
		if (selection.isEmpty()) {
			const match = bracketPairs.matchBracket(selection.getPosition()) ?? bracketPairs.findEnclosingBrackets(selection.getPosition());
			if (match) {
				hasMatch = true;
				return new RemoveMatchingBracketsCommand(match.opening, match.closing);
			}
		}
		return null;
	});
	return hasMatch ? commands : undefined;
}

class RemoveMatchingBracketsCommand implements ICommand {
	constructor(private readonly opening: Range, private readonly closing: Range) {}

	getEditOperations(_model: ITextModel, builder: IEditOperationBuilder): void {
		builder.addTrackedEditOperation(this.opening, '');
		builder.addTrackedEditOperation(this.closing, '');
	}

	computeCursorState(_model: ITextModel, helper: ICursorStateComputerData): Selection {
		return Selection.fromPositions(helper.getInverseEditOperations()[0]!.range.getStartPosition());
	}
}
