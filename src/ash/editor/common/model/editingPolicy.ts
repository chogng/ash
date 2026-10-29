import { type EditorAutoClosingEditStrategy, type EditorAutoClosingStrategy } from '../config/editorOptions.js';
import { getEnterAction as languageEnterAction } from '../languages/enterAction.js';
import { EditorAutoIndentStrategy } from '../config/editorOptions.js';
import { getIndentActionForType, getIndentForEnter } from '../languages/autoIndent.js';
import { CompositionSurroundSelectionCommand } from '../commands/surroundSelectionCommand.js';
import { ReplaceCommandWithOffsetSelection } from '../commands/replaceCommand.js';
import { Position } from '../core/position.js';
import { Range } from '../core/range.js';
import {
	EditorIndentationKind,
	getEditorIndentationUnit,
	getLeadingIndentation,
	normalizeEditorIndentation,
	normalizeEditorIndentationText,
	resolveEditorIndentationOptions,
	unshiftEditorIndentation,
	type ResolvedEditorIndentationOptions,
} from '../core/misc/indentation.js';
import { BaseTypeWithAutoClosingCommand, CompositionEndOvertypeOperation, SimpleCharacterTypeOperation } from '../cursor/cursorTypeEditOperations.js';
import { Selection } from '../core/selection.js';
import { IndentAction, StandardAutoClosingPairConditional, type EnterAction, type IAutoClosingPair, type OnEnterRule } from '../languages/languageConfiguration.js';
import { type ResolvedLanguageConfiguration } from '../languages/languageConfigurationRegistry.js';
import { StandardTokenType } from '../encodedTokenAttributes.js';
import { CursorConfiguration, EditOperationResult, EditOperationType, isQuote, type ICursorSimpleModel } from '../cursorCommon.js';
import { type ICommand } from '../editorCommon.js';
import { type ITextModel } from '../model.js';
import { TypeOperations, type CompositionOutcome } from '../cursor/cursorTypeOperations.js';
import { ReplaceCommand } from '../commands/replaceCommand.js';
import { normalizeTextLineEndings } from '../core/textChange.js';
import { getTextGraphemeBoundaries } from '../core/textSegmentation.js';
import { MoveOperations } from '../cursor/cursorMoveOperations.js';
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
export class CodeEditingPolicy {
	public static readonly getEnterAction = languageEnterAction;
	public static isAutoClosingPairDelete(
		autoClosingDelete: EditorAutoClosingEditStrategy,
		autoClosingBrackets: EditorAutoClosingStrategy,
		autoClosingQuotes: EditorAutoClosingStrategy,
		autoClosingPairsOpen: Map<string, StandardAutoClosingPairConditional[]>,
		model: ICursorSimpleModel,
		selections: Selection[],
		autoClosedCharacters: Range[],
	): boolean {
		if (autoClosingDelete === 'never' || (autoClosingBrackets === 'never' && autoClosingQuotes === 'never')) return false;
		return selections.every(selection => autoClosingPairAt(autoClosingDelete, autoClosingBrackets, autoClosingQuotes, autoClosingPairsOpen, model, selection, autoClosedCharacters) !== undefined);
	}
	public static deleteAutoClosedPair(config: CursorConfiguration, model: ICursorSimpleModel, selections: Selection[], autoClosedCharacters: Range[]): [boolean, Array<ICommand | null>] | undefined {
		if (
			this.isAutoClosingPairDelete(
				config.autoClosingDelete,
				config.autoClosingBrackets,
				config.autoClosingQuotes,
				config.autoClosingPairs.autoClosingPairsOpenByEnd,
				model,
				selections,
				autoClosedCharacters,
			)
		) {
			return [
				true,
				selections.map(selection => {
					const position = selection.getPosition();
					const pair = autoClosingPairAt(
						config.autoClosingDelete,
						config.autoClosingBrackets,
						config.autoClosingQuotes,
						config.autoClosingPairs.autoClosingPairsOpenByEnd,
						model,
						selection,
						autoClosedCharacters,
					)!;
					return new ReplaceCommand(new Range(position.lineNumber, position.column - pair.open.length, position.lineNumber, position.column + pair.close.length), '');
				}),
			];
		}

		return undefined;
	}

	public static compositionEndWithInterceptors(
		_prevEditOperationType: EditOperationType,
		config: CursorConfiguration,
		model: ITextModel,
		compositions: CompositionOutcome[] | null,
		selections: Selection[],
		autoClosedCharacters: Range[],
	): EditOperationResult | null {
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
			const commands = compositions.map(
				(composition, index) => new CompositionSurroundSelectionCommand(selections[index]!.getPosition(), composition.deletedText, config.surroundingPairs[insertedText]!),
			);
			return new EditOperationResult(EditOperationType.TypingOther, commands, {
				shouldPushStackElementBefore: true,
				shouldPushStackElementAfter: false,
			});
		}
		return AutoClosingOvertypeWithInterceptorsOperation.getEdits(config, model, selections, autoClosedCharacters, insertedText) ?? CompositionEndOvertypeOperation.getEdits(config, compositions);
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
		const indentations =
			!isDoingComposition && config.autoIndent === EditorAutoIndentStrategy.Full && config.inputMode === 'insert' && text.length === 1
				? selections.map(selection => indentationForType(config, model, selection, text))
				: [];
		const pairContexts = selections.map(selection => pairTypingContext(config, model, selection, text));
		if (!isDoingComposition && (pairContexts.some(hasPairTypingBehavior) || indentations.some(indentation => indentation !== null))) {
			const edits = selections.map((selection, index) => {
				const context = pairContexts[index]!;
				const result = pairTypeEdit(model, selection, text, context.surroundingPair, context.openingPair, context.closingPairs, context.autoCloseBefore, autoClosedCharacters);
				const indentation = indentations[index];
				if (indentation === undefined || indentation === null) return result;
				const before = model.getLineContent(selection.startLineNumber).slice(0, selection.startColumn - 1);
				const prefix = normalizeEditorIndentation(indentation, indentationOptions(config)) + before.slice(getLeadingIndentation(before).length);
				// Keep indentation and the pair in one command so undo and tracked closers share the same edit.
				return {
					...result,
					edit: {
						range: new Range(selection.startLineNumber, 1, result.edit.range.endLineNumber, result.edit.range.endColumn),
						text: prefix + result.edit.text,
						anchorOffsetInText: prefix.length + result.edit.anchorOffsetInText,
						activeOffsetInText: prefix.length + result.edit.activeOffsetInText,
					},
				};
			});
			const commands = edits.map(result =>
				result.pair
					? new BaseTypeWithAutoClosingCommand(result.edit.range, result.edit.text, result.edit.anchorOffsetInText, result.edit.activeOffsetInText, result.pair.open, result.pair.close)
					: new ReplaceCommandWithOffsetSelection(result.edit.range, result.edit.text, result.edit.anchorOffsetInText, result.edit.activeOffsetInText),
			);
			return new EditOperationResult(EditOperationType.TypingOther, commands, {
				shouldPushStackElementBefore: prevEditOperationType !== EditOperationType.TypingOther,
				shouldPushStackElementAfter: false,
			});
		}
		return SimpleCharacterTypeOperation.getEdits(config, prevEditOperationType, selections, text, isDoingComposition);
	}
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
function indentationForType(config: CursorConfiguration, model: ITextModel, selection: Selection, text: string): string | null {
	// Input must remain synchronous while an asynchronous syntax provider is still analyzing the model.
	if (!selection.isEmpty() || !model.tokenization.isCheapToTokenize(selection.startLineNumber)) return null;
	return getIndentActionForType(
		config,
		model,
		selection,
		text,
		{
			shiftIndent: value => TypeOperations.shiftIndent(config, value),
			unshiftIndent: value => TypeOperations.unshiftIndent(config, value),
		},
		config.languageConfigurationService,
	);
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
			edit: {
				range: selection,
				text: replacement,
				anchorOffsetInText: forward ? start : end,
				activeOffsetInText: forward ? end : start,
			},
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
				edit: {
					range: selection,
					text: openingPair.open + openingPair.close,
					anchorOffsetInText: openingPair.open.length,
					activeOffsetInText: openingPair.open.length,
				},
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
function enterEdit(
	config: CursorConfiguration,
	model: ITextModel,
	selection: Selection,
	configuration: ResolvedLanguageConfiguration,
	indentation: ResolvedEditorIndentationOptions,
): LanguageSelectionEdit {
	if (config.autoIndent === EditorAutoIndentStrategy.None) {
		return { range: selection, text: '\n', anchorOffsetInText: 1, activeOffsetInText: 1 };
	}
	const startLine = model.getLineContent(selection.getStartPosition().lineNumber);
	const endLine = model.getLineContent(selection.getEndPosition().lineNumber);
	const originalBefore = startLine.slice(0, selection.startColumn - 1);
	const before = originalBefore;
	const after = endLine.slice(selection.endColumn - 1);
	const previous = selection.startLineNumber > 1 ? model.getLineContent(selection.startLineNumber - 1) : '';
	const structuralBefore = isInsideBlockComment(model, selection.getStartPosition()) ? '' : structuralText(before);
	const action = enterAction(config.autoIndent, configuration, previous, before, after, structuralBefore);
	if (action) {
		const insertion = enterInsertion(originalBefore, action, indentation);
		return {
			range: selection,
			text: insertion.text,
			anchorOffsetInText: insertion.caret,
			activeOffsetInText: insertion.caret,
		};
	}
	let leading = getLeadingIndentation(originalBefore);
	if (config.autoIndent === EditorAutoIndentStrategy.Full && model.tokenization.isCheapToTokenize(selection.startLineNumber) && model.tokenization.isCheapToTokenize(selection.endLineNumber)) {
		const inherited = getIndentForEnter(
			config.autoIndent,
			model,
			selection,
			{
				shiftIndent: value => TypeOperations.shiftIndent(config, value),
				unshiftIndent: value => TypeOperations.unshiftIndent(config, value),
			},
			config.languageConfigurationService,
		);
		leading = inherited?.afterEnter ?? leading;
	}
	const insertion = enterInsertion(leading, { indentAction: IndentAction.None }, indentation);
	return {
		range: selection,
		text: insertion.text,
		anchorOffsetInText: insertion.caret,
		activeOffsetInText: insertion.caret,
	};
}
function enterAction(
	autoIndent: EditorAutoIndentStrategy,
	configuration: ResolvedLanguageConfiguration,
	previous: string,
	before: string,
	after: string,
	structuralBefore: string,
): EnterAction | null {
	if (autoIndent < EditorAutoIndentStrategy.Brackets) {
		return null;
	}
	const explicit = autoIndent >= EditorAutoIndentStrategy.Advanced ? configuration.underlyingConfig.onEnterRules?.find(rule => matchesEnterRule(rule, previous, before, after)) : undefined;
	if (explicit) return explicit.action;
	const pairs = [...(configuration.underlyingConfig.brackets ?? [])].sort((left, right) => right[0].length - left[0].length);
	for (const pair of pairs) {
		if (!structuralBefore.trimEnd().endsWith(pair[0])) continue;
		return after.trimStart().startsWith(pair[1]) ? { indentAction: IndentAction.IndentOutdent } : { indentAction: IndentAction.Indent };
	}
	return null;
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
	const target =
		action.indentAction === IndentAction.Outdent
			? unshiftEditorIndentation(base, indentation) + (action.appendText ?? '')
			: base + (action.indentAction === IndentAction.Indent ? unit + (action.appendText ?? '') : (action.appendText ?? ''));
	const normalized = normalizeEditorIndentationText(target, indentation);
	return { text: '\n' + normalized, caret: 1 + normalized.length };
}
function matchesEnterRule(rule: OnEnterRule, previous: string, before: string, after: string): boolean {
	return (
		testPattern(rule.beforeText, before) &&
		(rule.afterText === undefined || testPattern(rule.afterText, after)) &&
		(rule.previousLineText === undefined || testPattern(rule.previousLineText, previous))
	);
}
function testPattern(pattern: RegExp | null | undefined, text: string): boolean {
	return pattern ? new RegExp(pattern.source, pattern.flags).test(text) : false;
}
function languageEnter(config: CursorConfiguration, model: ITextModel, selections: Selection[]): EditOperationResult {
	const indentation = indentationOptions(config);
	const commands = selections.map(selection => {
		const edit = enterEdit(config, model, selection, languageConfigurationAt(config, model, selection.getPosition()), indentation);
		return new ReplaceCommandWithOffsetSelection(edit.range, edit.text, edit.anchorOffsetInText, edit.activeOffsetInText);
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
function shouldSurround(config: CursorConfiguration, text: string): boolean {
	if (config.autoSurround === 'languageDefined') return true;
	if (config.autoSurround === 'quotes') return isQuote(text);
	if (config.autoSurround === 'brackets') return !isQuote(text);
	return false;
}
function inferStandardTokenType(line: string, offset: number): StandardTokenType {
	const prefix = line.slice(0, offset + 1);
	if (/\/\/[^\n]*$/.test(prefix) || (/\/\*[^]*$/.test(prefix) && !/\*\//.test(prefix.slice(prefix.lastIndexOf('/*') + 2)))) return StandardTokenType.Comment;
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
class AutoClosingOvertypeOperation {
	public static getEdits(
		prevEditOperationType: EditOperationType,
		config: CursorConfiguration,
		model: ITextModel,
		selections: Selection[],
		autoClosedCharacters: Range[],
		text: string,
	): EditOperationResult | undefined {
		const normalized = normalizeTextLineEndings(text);
		if (!canOvertypeAutoClosedCharacter(config, model, selections, autoClosedCharacters, normalized)) return undefined;
		return new EditOperationResult(
			EditOperationType.TypingOther,
			selections.map(selection => {
				const position = selection.getPosition();
				return new ReplaceCommand(new Range(position.lineNumber, position.column, position.lineNumber, position.column + normalized.length), normalized);
			}),
			{
				shouldPushStackElementBefore: shouldSeparateTyping(prevEditOperationType, EditOperationType.TypingOther),
				shouldPushStackElementAfter: false,
			},
		);
	}
}
class AutoClosingOvertypeWithInterceptorsOperation {
	public static getEdits(config: CursorConfiguration, model: ITextModel, selections: Selection[], autoClosedCharacters: Range[], text: string): EditOperationResult | undefined {
		if (!canOvertypeAutoClosedCharacter(config, model, selections, autoClosedCharacters, text)) return undefined;
		return new EditOperationResult(
			EditOperationType.TypingOther,
			selections.map(selection => {
				const position = selection.getPosition();
				return new ReplaceCommand(new Range(position.lineNumber, position.column, position.lineNumber, position.column + text.length), '');
			}),
			{
				shouldPushStackElementBefore: true,
				shouldPushStackElementAfter: false,
			},
		);
	}
}
function canOvertypeAutoClosedCharacter(config: CursorConfiguration, model: ITextModel, selections: Selection[], autoClosedCharacters: Range[], text: string): boolean {
	if (text.length === 0 || text.includes('\n') || config.autoClosingOvertype === 'never') return false;
	const graphemeCount = getTextGraphemeBoundaries(text).length - 1;
	return selections.every(selection => {
		if (!selection.isEmpty()) return false;
		const position = selection.getPosition();
		const end = advancePositionInLine(model, position, graphemeCount);
		return model.getValueInRange(Range.fromPositions(position, end)) === text && autoClosedCharacters.some(range => range.containsPosition(position));
	});
}
function advancePositionInLine(model: ITextModel, position: Position, count: number): Position {
	let current = position;
	for (let index = 0; index < count; index += 1) {
		const next = MoveOperations.rightPosition(model, current.lineNumber, current.column);
		if (next.lineNumber !== position.lineNumber) break;
		current = next;
	}
	return current;
}
function shouldSeparateTyping(previous: EditOperationType, next: EditOperationType): boolean {
	if (previous === EditOperationType.TypingFirstSpace) return false;
	const previousGroup = previous === EditOperationType.TypingConsecutiveSpace ? EditOperationType.TypingFirstSpace : previous;
	const nextGroup = next === EditOperationType.TypingConsecutiveSpace ? EditOperationType.TypingFirstSpace : next;
	return previousGroup !== nextGroup;
}
function autoClosingPairAt(
	autoClosingDelete: EditorAutoClosingEditStrategy,
	autoClosingBrackets: EditorAutoClosingStrategy,
	autoClosingQuotes: EditorAutoClosingStrategy,
	autoClosingPairsOpen: Map<string, StandardAutoClosingPairConditional[]>,
	model: ICursorSimpleModel,
	selection: Selection,
	autoClosedCharacters: Range[],
): StandardAutoClosingPairConditional | undefined {
	if (!selection.isEmpty()) return undefined;
	const position = selection.getPosition();
	const line = model.getLineContent(position.lineNumber);
	if (position.column < 2 || position.column > line.length) return undefined;
	const openEnd = line.charAt(position.column - 2);
	const candidates = autoClosingPairsOpen.get(openEnd);
	const pair = candidates?.find(candidate => line.slice(0, position.column - 1).endsWith(candidate.open) && line.slice(position.column - 1).startsWith(candidate.close));
	if (!pair) return undefined;
	if (isQuote(pair.open) ? autoClosingQuotes === 'never' : autoClosingBrackets === 'never') return undefined;
	if (autoClosingDelete === 'always') return pair;
	return autoClosedCharacters.some(range => range.startLineNumber === position.lineNumber && range.startColumn === position.column) ? pair : undefined;
}
