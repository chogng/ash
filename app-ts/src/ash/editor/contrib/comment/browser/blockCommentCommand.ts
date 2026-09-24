import { Position } from '../../../common/core/position.js';
import { Range } from '../../../common/core/range.js';
import { Selection } from '../../../common/core/selection.js';
import { type ISingleEditOperation } from '../../../common/core/editOperation.js';
import { type ICursorStateComputerData, type IEditOperationBuilder, type ICommand } from '../../../common/editorCommon.js';
import { type ILanguageConfigurationService } from '../../../common/languages/languageConfigurationRegistry.js';
import { type ITextModel } from '../../../common/model.js';

export class BlockCommentCommand implements ICommand {
	private selectionId: string | undefined;
	private collapsedCaretOffset: number | undefined;

	constructor(
		private readonly selection: Selection,
		private readonly insertSpace: boolean,
		private readonly languageConfigurationService: ILanguageConfigurationService,
	) {}

	public static _haystackHasNeedleAtOffset(haystack: string, needle: string, offset: number): boolean {
		if (offset < 0 || offset + needle.length > haystack.length) return false;
		return haystack.slice(offset, offset + needle.length).toLocaleLowerCase() === needle.toLocaleLowerCase();
	}

	public static _createRemoveBlockCommentOperations(range: Range, startToken: string, endToken: string): ISingleEditOperation[] {
		if (range.isEmpty()) {
			return [{
				range: new Range(range.startLineNumber, range.startColumn - startToken.length, range.endLineNumber, range.endColumn + endToken.length),
				text: '',
			}];
		}
		return [
			{ range: new Range(range.startLineNumber, range.startColumn - startToken.length, range.startLineNumber, range.startColumn), text: '' },
			{ range: new Range(range.endLineNumber, range.endColumn, range.endLineNumber, range.endColumn + endToken.length), text: '' },
		];
	}

	public static _createAddBlockCommentOperations(range: Range, startToken: string, endToken: string, insertSpace: boolean): ISingleEditOperation[] {
		if (range.isEmpty()) {
			return [{ range, text: `${startToken}  ${endToken}` }];
		}
		const space = insertSpace ? ' ' : '';
		return [
			{ range: Range.fromPositions(range.getStartPosition()), text: `${startToken}${space}` },
			{ range: Range.fromPositions(range.getEndPosition()), text: `${space}${endToken}` },
		];
	}

	public getEditOperations(model: ITextModel, builder: IEditOperationBuilder): void {
		model.tokenization.tokenizeIfCheap(this.selection.startLineNumber);
		const languageId = model.getLanguageIdAtPosition(this.selection.startLineNumber, this.selection.startColumn);
		const comments = this.languageConfigurationService.getLanguageConfiguration(languageId).comments;
		const startToken = comments?.blockCommentStartToken;
		const endToken = comments?.blockCommentEndToken;
		if (!startToken || !endToken) return;

		this.selectionId = builder.trackSelection(this.selection);
		const removal = this.findRemoval(model, startToken, endToken);
		const operations = removal ?? BlockCommentCommand._createAddBlockCommentOperations(this.selection, startToken, endToken, this.insertSpace);
		if (!removal && this.selection.isEmpty()) this.collapsedCaretOffset = startToken.length + 1;
		for (const operation of operations) builder.addTrackedEditOperation(operation.range, operation.text);
	}

	public computeCursorState(_model: ITextModel, helper: ICursorStateComputerData): Selection {
		if (this.collapsedCaretOffset !== undefined) {
			const start = helper.getInverseEditOperations()[0]!.range.getStartPosition();
			return Selection.fromPositions(new Position(start.lineNumber, start.column + this.collapsedCaretOffset));
		}
		return helper.getTrackedSelection(this.selectionId!);
	}

	private findRemoval(model: ITextModel, startToken: string, endToken: string): ISingleEditOperation[] | undefined {
		const startLine = model.getLineContent(this.selection.startLineNumber);
		const endLine = model.getLineContent(this.selection.endLineNumber);
		let startIndex = startLine.lastIndexOf(startToken, Math.max(0, this.selection.startColumn - 1));
		let endIndex = endLine.indexOf(endToken, Math.max(0, this.selection.endColumn - 1));
		if (this.selection.isEmpty() && (startIndex < 0 || endIndex < 0)) {
			startIndex = startLine.lastIndexOf(startToken, this.selection.startColumn - 1);
			endIndex = startLine.indexOf(endToken, Math.max(0, this.selection.startColumn - 1));
		}
		if (startIndex < 0 || endIndex < 0) return undefined;
		let effectiveStart = startToken;
		let effectiveEnd = endToken;
		if (this.insertSpace && startLine[startIndex + startToken.length] === ' ') effectiveStart += ' ';
		if (this.insertSpace && endIndex > 0 && endLine[endIndex - 1] === ' ') {
			effectiveEnd = ` ${effectiveEnd}`;
			endIndex -= 1;
		}
		const inner = new Range(
			this.selection.startLineNumber,
			startIndex + effectiveStart.length + 1,
			this.selection.endLineNumber,
			endIndex + 1,
		);
		return BlockCommentCommand._createRemoveBlockCommentOperations(inner, effectiveStart, effectiveEnd);
	}
}
