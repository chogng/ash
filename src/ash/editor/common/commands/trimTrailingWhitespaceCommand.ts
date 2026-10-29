import * as strings from '../../../base/common/strings.js';
import { EditOperation, type ISingleEditOperation } from '../core/editOperation.js';
import { Position } from '../core/position.js';
import { Range } from '../core/range.js';
import { Selection } from '../core/selection.js';
import { type ICommand, type ICursorStateComputerData, type IEditOperationBuilder } from '../editorCommon.js';
import { StandardTokenType } from '../encodedTokenAttributes.js';
import { type ITextModel } from '../model.js';

export class TrimTrailingWhitespaceCommand implements ICommand {
	private readonly _selection: Selection;
	private _selectionId: string | null = null;
	private readonly _cursors: Position[];
	private readonly _trimInRegexesAndStrings: boolean;

	constructor(selection: Selection, cursors: Position[], trimInRegexesAndStrings: boolean) {
		this._selection = selection;
		this._cursors = cursors;
		this._trimInRegexesAndStrings = trimInRegexesAndStrings;
	}

	public getEditOperations(model: ITextModel, builder: IEditOperationBuilder): void {
		const operations = trimTrailingWhitespace(model, this._cursors, this._trimInRegexesAndStrings);
		for (let index = 0; index < operations.length; index++) {
			const operation = operations[index]!;
			builder.addEditOperation(operation.range, operation.text);
		}
		this._selectionId = builder.trackSelection(this._selection);
	}

	public computeCursorState(model: ITextModel, helper: ICursorStateComputerData): Selection {
		return helper.getTrackedSelection(this._selectionId!);
	}
}

export function trimTrailingWhitespace(model: ITextModel, cursors: Position[], trimInRegexesAndStrings: boolean): ISingleEditOperation[] {
	cursors.sort((left, right) => {
		if (left.lineNumber === right.lineNumber) return left.column - right.column;
		return left.lineNumber - right.lineNumber;
	});
	for (let index = cursors.length - 2; index >= 0; index -= 1) {
		if (cursors[index]!.lineNumber === cursors[index + 1]!.lineNumber) cursors.splice(index, 1);
	}

	const operations: ISingleEditOperation[] = [];
	let cursorIndex = 0;
	const cursorCount = cursors.length;
	for (let lineNumber = 1, lineCount = model.getLineCount(); lineNumber <= lineCount; lineNumber += 1) {
		const lineContent = model.getLineContent(lineNumber);
		const maxLineColumn = lineContent.length + 1;
		let minEditColumn = 0;
		if (cursorIndex < cursorCount && cursors[cursorIndex]!.lineNumber === lineNumber) {
			minEditColumn = cursors[cursorIndex]!.column;
			cursorIndex += 1;
			if (minEditColumn === maxLineColumn) continue;
		}
		if (lineContent.length === 0) continue;

		const lastNonWhitespaceIndex = strings.lastNonWhitespaceIndex(lineContent);
		let fromColumn: number;
		if (lastNonWhitespaceIndex === -1) fromColumn = 1;
		else if (lastNonWhitespaceIndex !== lineContent.length - 1) fromColumn = lastNonWhitespaceIndex + 2;
		else continue;

		if (!trimInRegexesAndStrings) {
			if (!model.tokenization.hasAccurateTokensForLine(lineNumber)) continue;
			const lineTokens = model.tokenization.getLineTokens(lineNumber);
			const tokenType = lineTokens.getStandardTokenType(lineTokens.findTokenIndexAtOffset(fromColumn));
			if (tokenType === StandardTokenType.String || tokenType === StandardTokenType.RegEx) continue;
		}

		fromColumn = Math.max(minEditColumn, fromColumn);
		operations.push(EditOperation.delete(new Range(lineNumber, fromColumn, lineNumber, maxLineColumn)));
	}
	return operations;
}
