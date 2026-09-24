import { Position } from '../../../common/core/position.js';
import { Range } from '../../../common/core/range.js';
import { Selection } from '../../../common/core/selection.js';
import { type ISingleEditOperation } from '../../../common/core/editOperation.js';
import { type ICursorStateComputerData, type IEditOperationBuilder, type ICommand } from '../../../common/editorCommon.js';
import { type ILanguageConfigurationService } from '../../../common/languages/languageConfigurationRegistry.js';
import { type ITextModel } from '../../../common/model.js';
import { BlockCommentCommand } from './blockCommentCommand.js';

export interface IInsertionPoint {
	ignore: boolean;
	commentStrOffset: number;
}

export interface ILinePreflightData extends IInsertionPoint {
	commentStr: string;
	commentStrLength: number;
}

export interface IPreflightDataSupported {
	supported: true;
	shouldRemoveComments: boolean;
	lines: ILinePreflightData[];
}

export interface IPreflightDataUnsupported {
	supported: false;
}

export type IPreflightData = IPreflightDataSupported | IPreflightDataUnsupported;

export interface ISimpleModel {
	getLineContent(lineNumber: number): string;
}

export const enum Type {
	Toggle = 0,
	ForceAdd = 1,
	ForceRemove = 2,
}

export class LineCommentCommand implements ICommand {
	private selectionId: string | undefined;
	private moveEndPositionDown = false;

	constructor(
		private readonly languageConfigurationService: ILanguageConfigurationService,
		private readonly selection: Selection,
		private readonly indentSize: number,
		private readonly type: Type,
		private readonly insertSpace: boolean,
		private readonly ignoreEmptyLines: boolean,
		private readonly ignoreFirstLine = false,
	) {}

	public static _analyzeLines(type: Type, insertSpace: boolean, model: ISimpleModel, lines: ILinePreflightData[], startLineNumber: number, ignoreEmptyLines: boolean, ignoreFirstLine: boolean, languageConfigurationService: ILanguageConfigurationService, languageId: string): IPreflightData {
		const noIndent = languageConfigurationService.getLanguageConfiguration(languageId).comments?.lineCommentNoIndent === true;
		let shouldRemoveComments = type !== Type.ForceAdd;
		let hasContent = false;
		for (let index = 0; index < lines.length; index += 1) {
			const data = lines[index]!;
			const text = model.getLineContent(startLineNumber + index);
			const firstContent = /^[ \t]*/u.exec(text)![0].length;
			if (index === 0 && ignoreFirstLine) {
				data.ignore = true;
				continue;
			}
			if (firstContent === text.length) {
				data.ignore = ignoreEmptyLines;
				data.commentStrOffset = noIndent ? 0 : text.length;
				continue;
			}
			hasContent = true;
			data.commentStrOffset = noIndent ? 0 : firstContent;
			const commented = text.startsWith(data.commentStr, data.commentStrOffset);
			if (type === Type.ForceRemove && !commented) data.ignore = true;
			if (type === Type.Toggle && !commented) shouldRemoveComments = false;
			if (commented && insertSpace && text[data.commentStrOffset + data.commentStr.length] === ' ') data.commentStrLength += 1;
		}
		if (type === Type.Toggle && !hasContent) {
			shouldRemoveComments = false;
			for (const line of lines) line.ignore = false;
		}
		return { supported: true, shouldRemoveComments, lines };
	}

	public static _gatherPreflightData(type: Type, insertSpace: boolean, model: ITextModel, startLineNumber: number, endLineNumber: number, ignoreEmptyLines: boolean, ignoreFirstLine: boolean, languageConfigurationService: ILanguageConfigurationService): IPreflightData {
		model.tokenization.tokenizeIfCheap(startLineNumber);
		const languageId = model.getLanguageIdAtPosition(startLineNumber, 1);
		const token = languageConfigurationService.getLanguageConfiguration(languageId).comments?.lineCommentToken;
		if (!token) return { supported: false };
		const lines = Array.from({ length: endLineNumber - startLineNumber + 1 }, () => ({
			ignore: false,
			commentStr: token,
			commentStrOffset: 0,
			commentStrLength: token.length,
		}));
		return LineCommentCommand._analyzeLines(type, insertSpace, model, lines, startLineNumber, ignoreEmptyLines, ignoreFirstLine, languageConfigurationService, languageId);
	}

	public getEditOperations(model: ITextModel, builder: IEditOperationBuilder): void {
		let selection = this.selection;
		if (selection.startLineNumber < selection.endLineNumber && selection.endColumn === 1) {
			this.moveEndPositionDown = true;
			selection = selection.setEndPosition(selection.endLineNumber - 1, model.getLineMaxColumn(selection.endLineNumber - 1));
		}
		const data = LineCommentCommand._gatherPreflightData(this.type, this.insertSpace, model, selection.startLineNumber, selection.endLineNumber, this.ignoreEmptyLines, this.ignoreFirstLine, this.languageConfigurationService);
		if (!data.supported) {
			new BlockCommentCommand(selection, this.insertSpace, this.languageConfigurationService).getEditOperations(model, builder);
			return;
		}
		this.selectionId = builder.trackSelection(selection);
		if (!data.shouldRemoveComments) LineCommentCommand._normalizeInsertionPoint(model, data.lines, selection.startLineNumber, this.indentSize);
		const operations = data.shouldRemoveComments
			? LineCommentCommand._createRemoveLineCommentsOperations(data.lines, selection.startLineNumber)
			: data.lines.flatMap((line, index) => line.ignore ? [] : [{
				range: Range.fromPositions(new Position(selection.startLineNumber + index, line.commentStrOffset + 1)),
				text: line.commentStr + (this.insertSpace ? ' ' : ''),
			}]);
		for (const operation of operations) builder.addTrackedEditOperation(operation.range, operation.text);
	}

	public computeCursorState(_model: ITextModel, helper: ICursorStateComputerData): Selection {
		let result = helper.getTrackedSelection(this.selectionId!);
		if (this.moveEndPositionDown) result = result.setEndPosition(result.endLineNumber + 1, 1);
		return result;
	}

	public static _createRemoveLineCommentsOperations(lines: ILinePreflightData[], startLineNumber: number): ISingleEditOperation[] {
		return lines.flatMap((line, index) => line.ignore ? [] : [{
			range: new Range(startLineNumber + index, line.commentStrOffset + 1, startLineNumber + index, line.commentStrOffset + line.commentStrLength + 1),
			text: '',
		}]);
	}

	public static _normalizeInsertionPoint(model: ISimpleModel, lines: IInsertionPoint[], startLineNumber: number, indentSize: number): void {
		let minimum = Number.POSITIVE_INFINITY;
		for (let index = 0; index < lines.length; index += 1) {
			if (lines[index]!.ignore) continue;
			minimum = Math.min(minimum, visibleColumn(model.getLineContent(startLineNumber + index), lines[index]!.commentStrOffset, indentSize));
		}
		if (!Number.isFinite(minimum)) return;
		minimum = Math.floor(minimum / indentSize) * indentSize;
		for (let index = 0; index < lines.length; index += 1) {
			const line = lines[index]!;
			if (line.ignore) continue;
			line.commentStrOffset = offsetAtVisibleColumn(model.getLineContent(startLineNumber + index), minimum, indentSize);
		}
	}
}

function visibleColumn(text: string, offset: number, indentSize: number): number {
	let column = 0;
	for (let index = 0; index < offset; index += 1) column = text[index] === '\t' ? column + indentSize - column % indentSize : column + 1;
	return column;
}

function offsetAtVisibleColumn(text: string, target: number, indentSize: number): number {
	let column = 0;
	let offset = 0;
	while (offset < text.length && column < target && (text[offset] === ' ' || text[offset] === '\t')) {
		column = text[offset] === '\t' ? column + indentSize - column % indentSize : column + 1;
		offset += 1;
	}
	return offset;
}
