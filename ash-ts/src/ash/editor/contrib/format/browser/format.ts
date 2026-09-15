import { raceCancellationError } from '../../../../base/common/async.js';
import { type CancellationToken } from '../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { type LanguageFeatureRegistry } from '../../../common/languageFeatureRegistry.js';
import { type FormattingOptions, type DocumentFormattingEditProvider, type TextEdit } from '../../../common/languages.js';
import { type ITextModel } from '../../../common/model.js';

/** Dispatches document formatting; the caller owns cancellation and edit application. */
export async function getDocumentFormattingEditsUntilResult(
	providers: LanguageFeatureRegistry<DocumentFormattingEditProvider>,
	model: ITextModel,
	options: FormattingOptions,
	token: CancellationToken,
): Promise<readonly TextEdit[]> {
	if (token.isCancellationRequested) {
		throw new CancellationError();
	}
	const version = model.getVersionId();
	for (const provider of providers.ordered(model)) {
		if (model.isDisposed() || token.isCancellationRequested || model.getVersionId() !== version) {
			return [];
		}
		const edits = await raceCancellationError(Promise.resolve(provider.provideDocumentFormattingEdits(model, options, token)), token);
		if (model.isDisposed() || token.isCancellationRequested || model.getVersionId() !== version) {
			return [];
		}
		if (edits && edits.length > 0) {
			return Object.freeze([...edits]);
		}
	}
	return [];
}
