import { raceCancellationError } from '../../../../base/common/async.js';
import { type CancellationToken } from '../../../../base/common/cancellation.js';
import { CancellationError, onUnexpectedExternalError } from '../../../../base/common/errors.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { type LanguageFeatureRegistry } from '../../../common/languageFeatureRegistry.js';
import { type FormattingOptions, type DocumentFormattingEditProvider, type DocumentRangeFormattingEditProvider, type TextEdit } from '../../../common/languages.js';
import { type ITextModel } from '../../../common/model.js';
import { type ILanguageFeaturesService } from '../../../common/services/languageFeatures.js';

export function getRealAndSyntheticDocumentFormattersOrdered(
	documentFormattingEditProvider: LanguageFeatureRegistry<DocumentFormattingEditProvider>,
	documentRangeFormattingEditProvider: LanguageFeatureRegistry<DocumentRangeFormattingEditProvider>,
	model: ITextModel,
): DocumentFormattingEditProvider[] {
	const providers = documentFormattingEditProvider.ordered(model);
	const extensions = new Set(providers.flatMap(provider => provider.extensionId ? [ExtensionIdentifier.toKey(provider.extensionId)] : []));
	for (const provider of documentRangeFormattingEditProvider.ordered(model)) {
		if (provider.extensionId) {
			const key = ExtensionIdentifier.toKey(provider.extensionId);
			if (extensions.has(key)) {
				continue;
			}
			extensions.add(key);
		}
		providers.push({
			extensionId: provider.extensionId,
			displayName: provider.displayName,
			provideDocumentFormattingEdits: (model, options, token) => provider.provideDocumentRangeFormattingEdits(model, model.getFullModelRange(), options, token),
		});
	}
	return providers;
}

/** Dispatches document formatting; the caller owns cancellation and edit application. */
export async function getDocumentFormattingEditsUntilResult(
	languageFeaturesService: ILanguageFeaturesService,
	model: ITextModel,
	options: FormattingOptions,
	token: CancellationToken,
): Promise<TextEdit[] | undefined> {
	if (token.isCancellationRequested) {
		throw new CancellationError();
	}
	const version = model.getVersionId();
	const providers = getRealAndSyntheticDocumentFormattersOrdered(languageFeaturesService.documentFormattingEditProvider, languageFeaturesService.documentRangeFormattingEditProvider, model);
	for (const provider of providers) {
		if (model.isDisposed() || token.isCancellationRequested || model.getVersionId() !== version) {
			return undefined;
		}
		let edits: TextEdit[] | null | undefined;
		try {
			edits = await raceCancellationError(Promise.resolve(provider.provideDocumentFormattingEdits(model, options, token)), token);
		} catch (error) {
			if (token.isCancellationRequested) {
				throw error;
			}
			onUnexpectedExternalError(error);
			continue;
		}
		if (model.isDisposed() || token.isCancellationRequested || model.getVersionId() !== version) {
			return undefined;
		}
		if (edits && edits.length > 0) {
			return edits;
		}
	}
	return undefined;
}
