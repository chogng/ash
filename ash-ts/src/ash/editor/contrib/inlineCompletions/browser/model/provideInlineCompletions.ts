import { type Position } from '../../../../common/core/position.js';
import { type LanguageFeatureRegistry } from '../../../../common/languageFeatureRegistry.js';
import { createLanguageFeatureRequest, isLanguageFeatureRequestCurrent } from '../../../../common/languages.js';
import { type TextModel } from '../../../../common/model/textModel.js';
import { type LanguageInlineCompletionItem, type LanguageInlineCompletionsProvider, type LanguageInlineCompletionsRequest } from '../../common/inlineCompletions.js';

/** Collects the current candidates from providers in language-feature order. */
export async function provideInlineCompletions(
	model: TextModel,
	providers: LanguageFeatureRegistry<LanguageInlineCompletionsProvider>,
	languageId: string,
	position: Position,
	triggerKind: LanguageInlineCompletionsRequest['triggerKind'],
	signal: AbortSignal,
): Promise<readonly LanguageInlineCompletionItem[]> {
	const request = { ...createLanguageFeatureRequest(model, languageId, signal), position, triggerKind };
	const result: LanguageInlineCompletionItem[] = [];
	for (const provider of providers.ordered(model)) {
		if (!isLanguageFeatureRequestCurrent(request)) return Object.freeze([]);
		const items = await provider.provideInlineCompletions(request, signal);
		if (!isLanguageFeatureRequestCurrent(request)) return Object.freeze([]);
		result.push(...items.map(normalizeItem));
	}
	return Object.freeze(result);
}

function normalizeItem(item: LanguageInlineCompletionItem): LanguageInlineCompletionItem {
	if (!item || typeof item !== 'object' || typeof item.insertText !== 'string') {
		throw new TypeError('Inline completion must contain insert text');
	}
	return Object.freeze({
		insertText: item.insertText,
		...(item.range ? { range: item.range } : {}),
		...(item.filterText !== undefined ? { filterText: item.filterText } : {}),
		...(item.commandId !== undefined ? { commandId: item.commandId } : {}),
		...(item.additionalTextEdits ? { additionalTextEdits: Object.freeze([...item.additionalTextEdits]) } : {}),
	});
}
