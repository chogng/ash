import { type EditorAutoIndentStrategy } from '../../../common/config/editorOptions.js';
import { Position } from '../../../common/core/position.js';
import { Range } from '../../../common/core/range.js';
import { Selection } from '../../../common/core/selection.js';
import { type ICommand, type ICursorStateComputerData, type IEditOperationBuilder } from '../../../common/editorCommon.js';
import { type ILanguageConfigurationService } from '../../../common/languages/languageConfigurationRegistry.js';
import { type ITextModel } from '../../../common/model.js';

/** Moves the physical lines covered by one selection across one neighbour. */
export class MoveLinesCommand implements ICommand {
	private lineDelta = 0;

	constructor(
		private readonly selection: Selection,
		private readonly isMovingDown: boolean,
		_autoIndent: EditorAutoIndentStrategy,
		_languageConfigurationService: ILanguageConfigurationService,
	) {}

	getEditOperations(model: ITextModel, builder: IEditOperationBuilder): void {
		this.lineDelta = 0;
		const { startLineNumber, endLineNumber } = selectedLines(this.selection);
		const eol = model.getEOL();
		const selected = lineText(model, startLineNumber, endLineNumber);
		if (this.isMovingDown) {
			if (endLineNumber === model.getLineCount()) return;
			const next = model.getLineContent(endLineNumber + 1);
			const range = Range.fromPositions(
				new Position(startLineNumber, 1),
				new Position(endLineNumber + 1, model.getLineMaxColumn(endLineNumber + 1)),
			);
			builder.addEditOperation(range, `${next}${eol}${selected}`);
			this.lineDelta = 1;
			return;
		}
		if (startLineNumber === 1) return;
		const previous = model.getLineContent(startLineNumber - 1);
		const range = Range.fromPositions(
			new Position(startLineNumber - 1, 1),
			new Position(endLineNumber, model.getLineMaxColumn(endLineNumber)),
		);
		builder.addEditOperation(range, `${selected}${eol}${previous}`);
		this.lineDelta = -1;
	}

	computeCursorState(_model: ITextModel, _helper: ICursorStateComputerData): Selection {
		return new Selection(
			this.selection.selectionStartLineNumber + this.lineDelta,
			this.selection.selectionStartColumn,
			this.selection.positionLineNumber + this.lineDelta,
			this.selection.positionColumn,
		);
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
