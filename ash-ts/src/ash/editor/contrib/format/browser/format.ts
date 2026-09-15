import { raceCancellationError } from '../../../../base/common/async.js';
import { type URI } from '../../../../base/common/uri.js';
import { type LanguageFeatureRegistry } from '../../../common/languageFeatureRegistry.js';
import { type LanguageFormattingOptions, type LanguageFormattingProvider, type TextEdit } from '../../../common/languages.js';
import { createLanguageFeatureRequest, isLanguageFeatureRequestCurrent } from '../../../common/languages/languageFeatureRequest.js';
import { type TextModel } from '../../../common/model/textModel.js';

/** Dispatches document formatting; the caller owns cancellation and edit application. */
export async function getDocumentFormattingEditsUntilResult(
	providers: LanguageFeatureRegistry<LanguageFormattingProvider>,
	model: TextModel,
	languageId: string,
	options: LanguageFormattingOptions,
	signal: AbortSignal,
	resource?: URI,
): Promise<readonly TextEdit[]> {
	signal.throwIfAborted();
	const request = { ...createLanguageFeatureRequest(model, languageId, signal), options, resource };
	for (const provider of providers.ordered(model)) {
		if (model.isDisposed() || !isLanguageFeatureRequestCurrent(request)) {
			return [];
		}
		if (!provider.provideDocumentFormattingEdits) {
			continue;
		}
		const edits = await raceCancellationError(Promise.resolve(provider.provideDocumentFormattingEdits(request, signal)), signal);
		if (model.isDisposed() || !isLanguageFeatureRequestCurrent(request)) {
			return [];
		}
		if (edits.length > 0) {
			return Object.freeze([...edits]);
		}
	}
	return [];
}
