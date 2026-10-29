import { ShiftCommand } from '../commands/shiftCommand.js';
import {
	getEditorIndentationUnit,
	normalizeEditorIndentationText,
	resolveEditorIndentationOptions,
	unshiftEditorIndentation,
	EditorIndentationKind,
	type ResolvedEditorIndentationOptions,
} from '../core/misc/indentation.js';
import { CompositionEndOvertypeOperation, CompositionOperation, PasteOperation, SimpleCharacterTypeOperation, TabOperation, TypeWithoutInterceptorsOperation } from './cursorTypeEditOperations.js';
import { type CursorConfiguration, EditOperationResult, EditOperationType, type ICursorSimpleModel } from '../cursorCommon.js';
import { type Selection } from '../core/selection.js';
import { type Range } from '../core/range.js';
import { type ICommand } from '../editorCommon.js';
import { type ITextModel } from '../model.js';

export class TypeOperations {
	public static indent(config: CursorConfiguration, model: ICursorSimpleModel | null, selections: Selection[] | null): ICommand[] {
		if (!model || !selections) {
			return [];
		}
		return selections.map(selection => new ShiftCommand(selection, shiftCommandOptions(config, false), config.languageConfigurationService));
	}
	public static outdent(config: CursorConfiguration, _model: ICursorSimpleModel, selections: Selection[]): ICommand[] {
		return selections.map(selection => new ShiftCommand(selection, shiftCommandOptions(config, true), config.languageConfigurationService));
	}
	public static shiftIndent(config: CursorConfiguration, indentation: string, count = 1): string {
		return normalizeEditorIndentationText(indentation + getEditorIndentationUnit(indentationOptions(config)).repeat(count), indentationOptions(config));
	}
	public static unshiftIndent(config: CursorConfiguration, indentation: string, count = 1): string {
		let result = indentation;
		for (let index = 0; index < count; index += 1) {
			result = unshiftEditorIndentation(result, indentationOptions(config));
		}
		return result;
	}
	public static paste(config: CursorConfiguration, model: ICursorSimpleModel, selections: Selection[], text: string, pasteOnNewLine: boolean, multicursorText: string[]): EditOperationResult {
		return PasteOperation.getEdits(config, model, selections, text, pasteOnNewLine, multicursorText);
	}
	public static tab(config: CursorConfiguration, model: ITextModel, selections: Selection[]): ICommand[] {
		return TabOperation.getCommands(config, model, selections);
	}
	public static compositionType(
		prevEditOperationType: EditOperationType,
		config: CursorConfiguration,
		model: ITextModel,
		selections: Selection[],
		text: string,
		replacePrevCharCnt: number,
		replaceNextCharCnt: number,
		positionDelta: number,
	): EditOperationResult {
		return CompositionOperation.getEdits(prevEditOperationType, config, model, selections, text, replacePrevCharCnt, replaceNextCharCnt, positionDelta);
	}
	public static compositionEndWithInterceptors(
		_prevEditOperationType: EditOperationType,
		config: CursorConfiguration,
		model: ITextModel,
		compositions: CompositionOutcome[] | null,
		selections: Selection[],
		autoClosedCharacters: Range[],
	): EditOperationResult | null {
		const policy = model.editingPolicy;
		return policy
			? policy.compositionEndWithInterceptors(_prevEditOperationType, config, model, compositions, selections, autoClosedCharacters)
			: compositions
				? CompositionEndOvertypeOperation.getEdits(config, compositions)
				: null;
	}
	public static typeWithInterceptors(
		isDoingComposition: boolean,
		prevEditOperationType: EditOperationType,
		config: CursorConfiguration,
		model: ITextModel,
		selections: Selection[],
		autoClosedCharacters: Range[],
		text: string,
	): EditOperationResult {
		return (
			model.editingPolicy?.typeWithInterceptors(isDoingComposition, prevEditOperationType, config, model, selections, autoClosedCharacters, text) ??
			SimpleCharacterTypeOperation.getEdits(config, prevEditOperationType, selections, text, isDoingComposition)
		);
	}
	public static typeWithoutInterceptors(prevEditOperationType: EditOperationType, _config: CursorConfiguration, _model: ITextModel, selections: Selection[], text: string): EditOperationResult {
		if (typeof text !== 'string') {
			throw new TypeError('Typed text must be a string');
		}
		return TypeWithoutInterceptorsOperation.getEdits(prevEditOperationType, selections, text);
	}
}
export class CompositionOutcome {
	constructor(
		public readonly deletedText: string,
		public readonly deletedSelectionStart: number,
		public readonly deletedSelectionEnd: number,
		public readonly insertedText: string,
		public readonly insertedSelectionStart: number,
		public readonly insertedSelectionEnd: number,
		public readonly insertedTextRange: Range,
	) {}
}
function indentationOptions(config: CursorConfiguration): ResolvedEditorIndentationOptions {
	return resolveEditorIndentationOptions({
		kind: config.insertSpaces ? EditorIndentationKind.Spaces : EditorIndentationKind.Tabs,
		tabSize: config.indentSize,
	});
}
function shiftCommandOptions(config: CursorConfiguration, isUnshift: boolean) {
	return {
		isUnshift,
		tabSize: config.tabSize,
		indentSize: config.indentSize,
		insertSpaces: config.insertSpaces,
		useTabStops: config.useTabStops,
		autoIndent: config.autoIndent,
	};
}
