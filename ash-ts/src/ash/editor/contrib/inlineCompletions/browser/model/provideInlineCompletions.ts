import { type Position } from '../../../../common/core/position.js';
import { type LanguageFeatureRegistry } from '../../../../common/languageFeatureRegistry.js';
import { createLanguageFeatureRequest, isLanguageFeatureRequestCurrent } from '../../../../common/languages.js';
import { type TextModel } from '../../../../common/model/textModel.js';
import { Range } from '../../../../common/core/range.js';
import { normalizeTextLineEndings } from '../../../../common/core/textChange.js';
import { type ILanguageConfigurationService } from '../../../../common/languages/languageConfigurationRegistry.js';
import { fixBracketsInLine } from '../../../../common/model/bracketPairsTextModelPart/fixBrackets.js';
import { LineTokens } from '../../../../common/tokens/lineTokens.js';
import { type LanguageInlineCompletionItem, type LanguageInlineCompletionsProvider, type LanguageInlineCompletionsRequest } from '../../common/inlineCompletions.js';

/** Collects the current candidates from providers in language-feature order. */
export async function provideInlineCompletions(
	model: TextModel,
	providers: LanguageFeatureRegistry<LanguageInlineCompletionsProvider>,
	languageId: string,
	position: Position,
	triggerKind: LanguageInlineCompletionsRequest['triggerKind'],
	signal: AbortSignal,
	languageConfigurationService: ILanguageConfigurationService,
): Promise<readonly LanguageInlineCompletionItem[]> {
	const request = { ...createLanguageFeatureRequest(model, languageId, signal), position, triggerKind };
	const result: LanguageInlineCompletionItem[] = [];
	for (const provider of providers.ordered(model)) {
		if (!isLanguageFeatureRequestCurrent(request)) return Object.freeze([]);
		const items = await provider.provideInlineCompletions(request, signal);
		if (!isLanguageFeatureRequestCurrent(request)) return Object.freeze([]);
		for (const item of items) {
			const normalized = normalizeItem(item);
			const completed = normalized.completeBracketPairs
				? await completeBrackets(model, normalized, position, signal, languageConfigurationService) : normalized;
			if (!isLanguageFeatureRequestCurrent(request)) return Object.freeze([]);
			result.push(completed);
		}
	}
	return Object.freeze(result);
}

function normalizeItem(item: LanguageInlineCompletionItem): LanguageInlineCompletionItem {
	if (!item || typeof item !== 'object' || typeof item.insertText !== 'string') {
		throw new TypeError('Inline completion must contain insert text');
	}
	if (item.completeBracketPairs !== undefined && typeof item.completeBracketPairs !== 'boolean') throw new TypeError('Inline completion completeBracketPairs must be a boolean');
	return Object.freeze({
		insertText: item.insertText,
		...(item.completeBracketPairs === undefined ? {} : { completeBracketPairs: item.completeBracketPairs }),
		...(item.range ? { range: item.range } : {}),
		...(item.filterText !== undefined ? { filterText: item.filterText } : {}),
		...(item.commandId !== undefined ? { commandId: item.commandId } : {}),
		...(item.additionalTextEdits ? { additionalTextEdits: Object.freeze([...item.additionalTextEdits]) } : {}),
	});
}

async function completeBrackets(model: TextModel, item: LanguageInlineCompletionItem, position: Position, signal: AbortSignal, languageConfigurationService: ILanguageConfigurationService): Promise<LanguageInlineCompletionItem> {
	const range = item.range ?? Range.fromPositions(position);
	const prefix = model.getLineContent(range.startLineNumber).slice(0, range.startColumn - 1);
	const text = prefix + normalizeTextLineEndings(item.insertText);
	const lines = await model.tokenization.tokenizeLinesAtAsync(range.startLineNumber, text.split('\n'), signal);
	if (!lines || signal.aborted) return item;
	const segments: { text: string; metadata: number }[] = [];
	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex]!;
		for (let index = 0; index < line.getCount(); index++) {
			const start = index === 0 ? 0 : line.getEndOffset(index - 1);
			segments.push({ text: line.getLineContent().slice(start, line.getEndOffset(index)), metadata: line.getMetadata(index) });
		}
		if (lineIndex < lines.length - 1) segments.push({ text: '\n', metadata: line.getMetadata(line.getCount() - 1) });
	}
	const tokens = LineTokens.createFromTextAndMetadata(segments, lines[0]!.languageIdCodec);
	const insertText = fixBracketsInLine(tokens.sliceAndInflate(prefix.length, text.length, 0), languageConfigurationService);
	return Object.freeze({ ...item, insertText });
}
