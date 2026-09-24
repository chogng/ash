import { AccessibilitySupport } from '../../../../platform/accessibility/common/accessibility.js';
import { type IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import * as nls from '../../../../nls.js';
import { type IComputedEditorOptions, EditorOption } from '../../../common/config/editorOptions.js';
import { Position } from '../../../common/core/position.js';
import { Range } from '../../../common/core/range.js';
import { Selection, SelectionDirection } from '../../../common/core/selection.js';
import { EndOfLinePreference } from '../../../common/model.js';
import { type ISimpleModel } from '../../../common/viewModel/screenReaderSimpleModel.js';

export interface IPagedScreenReaderStrategy<T> {
	fromEditorSelection(model: ISimpleModel, selection: Selection, linesPerPage: number, trimLongText: boolean): T;
}

export interface ISimpleScreenReaderContentState {
	value: string;
	selectionStart: number;
	selectionEnd: number;
	selection: Selection;
	startPositionWithinEditor: Position;
	newlineCountBeforeSelection: number;
}

export class SimplePagedScreenReaderStrategy implements IPagedScreenReaderStrategy<ISimpleScreenReaderContentState> {
	private _getPageOfLine(lineNumber: number, linesPerPage: number): number {
		return Math.floor((lineNumber - 1) / linesPerPage);
	}

	private _getRangeForPage(page: number, linesPerPage: number): Range {
		const offset = page * linesPerPage;
		return new Range(offset + 1, 1, offset + linesPerPage + 1, 1);
	}

	public fromEditorSelection(model: ISimpleModel, selection: Selection, linesPerPage: number, trimLongText: boolean): ISimpleScreenReaderContentState {
		const limitCharacters = 500;
		const selectionStartPage = this._getPageOfLine(selection.startLineNumber, linesPerPage);
		const selectionStartPageRange = this._getRangeForPage(selectionStartPage, linesPerPage);
		const selectionEndPage = this._getPageOfLine(selection.endLineNumber, linesPerPage);
		const selectionEndPageRange = this._getRangeForPage(selectionEndPage, linesPerPage);

		let pretextRange = selectionStartPageRange.intersectRanges(new Range(1, 1, selection.startLineNumber, selection.startColumn))!;
		if (trimLongText && model.getValueLengthInRange(pretextRange, EndOfLinePreference.LF) > limitCharacters) {
			pretextRange = Range.fromPositions(model.modifyPosition(pretextRange.getEndPosition(), -limitCharacters), pretextRange.getEndPosition());
		}
		const pretext = model.getValueInRange(pretextRange, EndOfLinePreference.LF);

		const lastLine = model.getLineCount();
		let posttextRange = selectionEndPageRange.intersectRanges(new Range(selection.endLineNumber, selection.endColumn, lastLine, model.getLineMaxColumn(lastLine)))!;
		if (trimLongText && model.getValueLengthInRange(posttextRange, EndOfLinePreference.LF) > limitCharacters) {
			posttextRange = Range.fromPositions(posttextRange.getStartPosition(), model.modifyPosition(posttextRange.getStartPosition(), limitCharacters));
		}
		const posttext = model.getValueInRange(posttextRange, EndOfLinePreference.LF);

		let text: string;
		if (selectionStartPage === selectionEndPage || selectionStartPage + 1 === selectionEndPage) {
			text = model.getValueInRange(selection, EndOfLinePreference.LF);
		} else {
			text = model.getValueInRange(selectionStartPageRange.intersectRanges(selection)!, EndOfLinePreference.LF)
				+ String.fromCharCode(8230)
				+ model.getValueInRange(selectionEndPageRange.intersectRanges(selection)!, EndOfLinePreference.LF);
		}
		if (trimLongText && text.length > 2 * limitCharacters) {
			text = text.substring(0, limitCharacters) + String.fromCharCode(8230) + text.substring(text.length - limitCharacters);
		}

		const leftToRight = selection.getDirection() === SelectionDirection.LTR;
		return {
			value: pretext + text + posttext,
			selection,
			selectionStart: leftToRight ? pretext.length : pretext.length + text.length,
			selectionEnd: leftToRight ? pretext.length + text.length : pretext.length,
			startPositionWithinEditor: pretextRange.getStartPosition(),
			newlineCountBeforeSelection: pretextRange.endLineNumber - pretextRange.startLineNumber,
		};
	}
}

export function ariaLabelForScreenReaderContent(options: IComputedEditorOptions, keybindingService: IKeybindingService) {
	if (options.get(EditorOption.accessibilitySupport) === AccessibilitySupport.Disabled) {
		const hasToggleKeybinding = keybindingService.lookupKeybinding('editor.action.toggleScreenReaderAccessibilityMode') !== undefined;
		return nls.localize('editor', 'accessibilityModeOff', hasToggleKeybinding
			? 'The editor is not accessible at this time. Use the configured accessibility-mode shortcut to enable it.'
			: 'The editor is not accessible at this time. Enable screen reader optimized mode from the command menu.');
	}
	return options.get(EditorOption.ariaLabel);
}

export function newlinecount(text: string): number {
	let result = 0;
	for (const character of text) if (character === '\n') result += 1;
	return result;
}
