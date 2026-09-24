import { ShiftCommand } from '../commands/shiftCommand.js';
import { CompositionSurroundSelectionCommand } from '../commands/surroundSelectionCommand.js';
import { ReplaceCommand } from '../commands/replaceCommand.js';
import { Position } from '../core/position.js';
import { Range } from '../core/range.js';
import { EditorIndentationKind, getEditorIndentationUnit, getLeadingIndentation, normalizeEditorIndentation, normalizeEditorIndentationText, resolveEditorIndentationOptions, unshiftEditorIndentation, type ResolvedEditorIndentationOptions } from '../core/misc/indentation.js';

import { AutoClosingOvertypeOperation, AutoClosingOvertypeWithInterceptorsOperation, BaseTypeWithAutoClosingCommand, CompositionEndOvertypeOperation, CompositionOperation, PasteOperation, SimpleCharacterTypeOperation, TabOperation, TypeWithoutInterceptorsOperation } from './cursorTypeEditOperations.js';
import { Selection } from '../core/selection.js';
import { IndentAction, StandardAutoClosingPairConditional, type EnterAction, type IAutoClosingPair, type OnEnterRule } from '../languages/languageConfiguration.js';
import { type ResolvedLanguageConfiguration } from '../languages/languageConfigurationRegistry.js';
import { StandardTokenType } from '../encodedTokenAttributes.js';
import { CursorConfiguration, EditOperationResult, EditOperationType, isQuote, type ICursorSimpleModel } from '../cursorCommon.js';
import { type ICommand, type ICursorStateComputerData } from '../editorCommon.js';
import { type ITextModel } from '../model.js';

interface PairTypeEdit {
	readonly edit: LanguageSelectionEdit;
	readonly pair?: StandardAutoClosingPairConditional;
}

interface LanguageSelectionEdit {
	readonly range: Range;
	readonly text: string;
	readonly anchorOffsetInText: number;
	readonly activeOffsetInText: number;
}

interface PairTypingContext {
	readonly surroundingPair: IAutoClosingPair | undefined;
	readonly openingPair: StandardAutoClosingPairConditional | undefined;
	readonly closingPairs: readonly StandardAutoClosingPairConditional[];
	readonly autoCloseBefore: string;
}

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

	public static compositionType(prevEditOperationType: EditOperationType, config: CursorConfiguration, model: ITextModel, selections: Selection[], text: string, replacePrevCharCnt: number, replaceNextCharCnt: number, positionDelta: number): EditOperationResult {
		return CompositionOperation.getEdits(prevEditOperationType, config, model, selections, text, replacePrevCharCnt, replaceNextCharCnt, positionDelta);
	}

	public static compositionEndWithInterceptors(_prevEditOperationType: EditOperationType, config: CursorConfiguration, model: ITextModel, compositions: CompositionOutcome[] | null, selections: Selection[], autoClosedCharacters: Range[]): EditOperationResult | null {
		if (!compositions || compositions.length !== selections.length) {
			return null;
		}
		const insertedText = compositions[0]?.insertedText;
		if (!insertedText || insertedText.length !== 1 || compositions.some(composition => composition.insertedText !== insertedText)) {
			return CompositionEndOvertypeOperation.getEdits(config, compositions);
		}
		if (compositions.some(composition => composition.deletedText.length > 0)) {
			if (!config.surroundingPairs[insertedText] || !shouldSurround(config, insertedText)) {
				return null;
			}
			const commands = compositions.map((composition, index) => new CompositionSurroundSelectionCommand(selections[index]!.getPosition(), composition.deletedText, config.surroundingPairs[insertedText]!));
			return new EditOperationResult(EditOperationType.TypingOther, commands, {
				shouldPushStackElementBefore: true,
				shouldPushStackElementAfter: false,
			});
		}
		return AutoClosingOvertypeWithInterceptorsOperation.getEdits(config, model, selections, autoClosedCharacters, insertedText)
			?? CompositionEndOvertypeOperation.getEdits(config, compositions);
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
		if (text === '\n' && !isDoingComposition) {
			return languageEnter(config, model, selections);
		}
		const overtype = AutoClosingOvertypeOperation.getEdits(prevEditOperationType, config, model, selections, autoClosedCharacters, text);
		if (overtype) {
			return overtype;
		}
		const pairContexts = selections.map(selection => pairTypingContext(config, model, selection, text));
		if (!isDoingComposition && pairContexts.some(hasPairTypingBehavior)) {
			const edits = selections.map((selection, index) => {
				const context = pairContexts[index]!;
				return pairTypeEdit(model, selection, text, context.surroundingPair, context.openingPair, context.closingPairs, context.autoCloseBefore, autoClosedCharacters);
			});
			const commands = edits.map(result => result.pair
				? new BaseTypeWithAutoClosingCommand(result.edit.range, result.edit.text, result.edit.anchorOffsetInText, result.edit.activeOffsetInText, result.pair.open, result.pair.close)
				: new LanguageSelectionEditCommand(result.edit.range, result.edit.text, result.edit.anchorOffsetInText, result.edit.activeOffsetInText));
			return new EditOperationResult(EditOperationType.TypingOther, commands, {
				shouldPushStackElementBefore: prevEditOperationType !== EditOperationType.TypingOther,
				shouldPushStackElementAfter: false,
			});
		}
		return SimpleCharacterTypeOperation.getEdits(config, prevEditOperationType, selections, text, isDoingComposition);
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

function pairTypingContext(config: CursorConfiguration, model: ITextModel, selection: Selection, text: string): PairTypingContext {
	const configuration = languageConfigurationAt(config, model, selection.getPosition());
	const pairs = configuration.characterPair.getAutoClosingPairs();
	const closingEnabled = isQuote(text) ? config.autoClosingQuotes !== 'never' : config.autoClosingBrackets !== 'never';
	return {
		surroundingPair: shouldSurround(config, text) ? configuration.getSurroundingPairs().find(pair => pair.open === text) : undefined,
		openingPair: closingEnabled ? pairs.find(pair => pair.open === text) : undefined,
		closingPairs: pairs.filter(pair => pair.close === text),
		autoCloseBefore: configuration.getAutoCloseBeforeSet(isQuote(text)),
	};
}

function hasPairTypingBehavior(context: PairTypingContext): boolean {
	return context.surroundingPair !== undefined || context.openingPair !== undefined || context.closingPairs.length > 0;
}

function pairTypeEdit(
	model: ITextModel,
	selection: Selection,
	text: string,
	surroundingPair: IAutoClosingPair | undefined,
	openingPair: StandardAutoClosingPairConditional | undefined,
	closingPairs: readonly StandardAutoClosingPairConditional[],
	autoCloseBefore: string,
	autoClosedCharacters: readonly Range[],
): PairTypeEdit {
	if (!selection.isEmpty() && surroundingPair) {
		const selectedText = model.getValueInRange(selection);
		const replacement = surroundingPair.open + selectedText + surroundingPair.close;
		const start = surroundingPair.open.length;
		const end = start + selectedText.length;
		const forward = Position.compare(selection.getSelectionStart(), selection.getStartPosition()) === 0;
		return {
			edit: { range: selection, text: replacement, anchorOffsetInText: forward ? start : end, activeOffsetInText: forward ? end : start },
		};
	}
	if (selection.isEmpty()) {
		const position = selection.getPosition();
		const line = model.getLineContent(position.lineNumber);
		const columnIndex = position.column - 1;
		const closingPair = closingPairs.find(pair => line.startsWith(pair.close, columnIndex) && ownsCloser(model, position, pair.close, autoClosedCharacters));
		if (closingPair) {
			return {
				edit: {
					range: Range.fromPositions(position, model.modifyPosition(position, closingPair.close.length)),
					text: closingPair.close,
					anchorOffsetInText: closingPair.close.length,
					activeOffsetInText: closingPair.close.length,
				},
			};
		}
		if (openingPair && shouldAutoClose(line, columnIndex, autoCloseBefore) && autoClosingAllowed(model, position, openingPair)) {
			return {
				edit: { range: selection, text: openingPair.open + openingPair.close, anchorOffsetInText: openingPair.open.length, activeOffsetInText: openingPair.open.length },
				pair: openingPair,
			};
		}
	}
	return {
		edit: { range: selection, text, anchorOffsetInText: text.length, activeOffsetInText: text.length },
	};
}

function ownsCloser(model: ITextModel, position: Position, close: string, ranges: readonly Range[]): boolean {
	return ranges.some(range => Position.equals(range.getStartPosition(), position) && model.getValueInRange(range) === close);
}

function shouldAutoClose(line: string, columnIndex: number, autoCloseBefore: string): boolean {
	if (columnIndex >= line.length) return true;
	return autoCloseBefore.includes(String.fromCodePoint(line.codePointAt(columnIndex)!));
}

function autoClosingAllowed(model: ITextModel, position: Position, pair: StandardAutoClosingPairConditional): boolean {
	const lineTokens = model.tokenization.getLineTokens(position.lineNumber);
	const offset = Math.max(0, Math.min(position.column - 1, Math.max(0, lineTokens.getLineContent().length - 1)));
	let tokenType = lineTokens.getStandardTokenType(lineTokens.findTokenIndexAtOffset(offset));
	if (tokenType === StandardTokenType.Other) tokenType = inferStandardTokenType(lineTokens.getLineContent(), offset);
	return pair.isOK(tokenType ?? StandardTokenType.Other);
}

function enterEdit(model: ITextModel, selection: Selection, configuration: ResolvedLanguageConfiguration, indentation: ResolvedEditorIndentationOptions): LanguageSelectionEdit {
	const startLine = model.getLineContent(selection.getStartPosition().lineNumber);
	const endLine = model.getLineContent(selection.getEndPosition().lineNumber);
	const originalBefore = startLine.slice(0, selection.startColumn - 1);
	const before = originalBefore;
	const after = endLine.slice(selection.endColumn - 1);
	const previous = selection.startLineNumber > 1
		? model.getLineContent(selection.startLineNumber - 1)
		: '';
	const structuralBefore = isInsideBlockComment(model, selection.getStartPosition()) ? '' : structuralText(before);
	const insertion = enterInsertion(originalBefore, enterAction(configuration, previous, before, after, structuralBefore), indentation);
	return { range: selection, text: insertion.text, anchorOffsetInText: insertion.caret, activeOffsetInText: insertion.caret };
}

function enterAction(configuration: ResolvedLanguageConfiguration, previous: string, before: string, after: string, structuralBefore: string): EnterAction {
	const explicit = configuration.underlyingConfig.onEnterRules?.find(rule => matchesEnterRule(rule, previous, before, after));
	if (explicit) return explicit.action;
	const pairs = [...(configuration.underlyingConfig.brackets ?? [])].sort((left, right) => right[0].length - left[0].length);
	for (const pair of pairs) {
		if (!structuralBefore.trimEnd().endsWith(pair[0])) continue;
		return after.trimStart().startsWith(pair[1])
			? { indentAction: IndentAction.IndentOutdent }
			: { indentAction: IndentAction.Indent };
	}
	const rules = configuration.indentationRules;
	if (rules && !testPattern(rules.unIndentedLinePattern, structuralBefore)) {
		if (testPattern(rules.increaseIndentPattern, structuralBefore) || testPattern(rules.indentNextLinePattern, structuralBefore)) return { indentAction: IndentAction.Indent };
		if (testPattern(rules.decreaseIndentPattern, after)) return { indentAction: IndentAction.Outdent };
	}
	return { indentAction: IndentAction.None };
}

function enterInsertion(before: string, action: EnterAction, indentation: ResolvedEditorIndentationOptions): { readonly text: string; readonly caret: number } {
	const leading = getLeadingIndentation(before);
	const removeText = Math.min(action.removeText ?? 0, leading.length);
	const base = normalizeEditorIndentation(leading.slice(0, leading.length - removeText), indentation);
	const unit = getEditorIndentationUnit(indentation);
	if (action.indentAction === IndentAction.IndentOutdent) {
		const first = normalizeEditorIndentationText(base + (action.appendText ?? unit), indentation);
		return { text: '\n' + first + '\n' + base, caret: 1 + first.length };
	}
	const target = action.indentAction === IndentAction.Outdent
		? unshiftEditorIndentation(base, indentation) + (action.appendText ?? '')
		: base + (action.indentAction === IndentAction.Indent ? unit + (action.appendText ?? '') : action.appendText ?? '');
	const normalized = normalizeEditorIndentationText(target, indentation);
	return { text: '\n' + normalized, caret: 1 + normalized.length };
}

function matchesEnterRule(rule: OnEnterRule, previous: string, before: string, after: string): boolean {
	return testPattern(rule.beforeText, before)
		&& (rule.afterText === undefined || testPattern(rule.afterText, after))
		&& (rule.previousLineText === undefined || testPattern(rule.previousLineText, previous));
}

function testPattern(pattern: RegExp | null | undefined, text: string): boolean {
	return pattern ? new RegExp(pattern.source, pattern.flags).test(text) : false;
}

function languageEnter(config: CursorConfiguration, model: ITextModel, selections: Selection[]): EditOperationResult {
	const indentation = indentationOptions(config);
	const commands = selections.map(selection => {
		const edit = enterEdit(model, selection, languageConfigurationAt(config, model, selection.getPosition()), indentation);
		return new LanguageSelectionEditCommand(edit.range, edit.text, edit.anchorOffsetInText, edit.activeOffsetInText);
	});
	return new EditOperationResult(EditOperationType.TypingOther, commands, {
		shouldPushStackElementBefore: true,
		shouldPushStackElementAfter: false,
	});
}

function languageConfigurationAt(config: CursorConfiguration, model: ITextModel, position: Position | undefined): ResolvedLanguageConfiguration {
	const languageId = position ? model.getLanguageIdAtPosition(position.lineNumber, position.column) : model.getLanguageId();
	return config.languageConfigurationService.getLanguageConfiguration(languageId);
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

function shouldSurround(config: CursorConfiguration, text: string): boolean {
	if (config.autoSurround === 'languageDefined') return true;
	if (config.autoSurround === 'quotes') return isQuote(text);
	if (config.autoSurround === 'brackets') return !isQuote(text);
	return false;
}

class LanguageSelectionEditCommand extends ReplaceCommand {
	constructor(range: Range, text: string, private readonly anchorOffsetInText: number, private readonly activeOffsetInText: number) {
		super(range, text);
	}

	public override computeCursorState(model: ITextModel, helper: ICursorStateComputerData): Selection {
		const start = helper.getInverseEditOperations()[0]!.range.getStartPosition();
		return Selection.fromPositions(model.modifyPosition(start, this.anchorOffsetInText), model.modifyPosition(start, this.activeOffsetInText));
	}
}

function inferStandardTokenType(line: string, offset: number): StandardTokenType {
	const prefix = line.slice(0, offset + 1);
	if (/\/\/[^\n]*$/.test(prefix) || /\/\*[^]*$/.test(prefix) && !/\*\//.test(prefix.slice(prefix.lastIndexOf('/*') + 2))) return StandardTokenType.Comment;
	let quote: string | undefined;
	for (let index = 0; index < prefix.length; index += 1) {
		const character = prefix[index]!;
		if (character === '\\') {
			index += 1;
			continue;
		}
		if (quote === character) quote = undefined;
		else if (!quote && isQuote(character)) quote = character;
	}
	return quote ? StandardTokenType.String : StandardTokenType.Other;
}

function structuralText(text: string): string {
	let result = '';
	let quote: string | undefined;
	for (let index = 0; index < text.length; index += 1) {
		const character = text[index]!;
		if (!quote && character === '/' && text[index + 1] === '/') return result;
		if (character === '\\' && quote) {
			result += '  ';
			index += 1;
			continue;
		}
		if (quote === character) {
			quote = undefined;
			result += ' ';
		} else if (!quote && isQuote(character)) {
			quote = character;
			result += ' ';
		} else {
			result += quote ? ' ' : character;
		}
	}
	return result;
}

function isInsideBlockComment(model: ITextModel, position: Position): boolean {
	const prefix = model.getValueInRange(new Range(1, 1, position.lineNumber, position.column));
	return prefix.lastIndexOf('/*') > prefix.lastIndexOf('*/');
}
