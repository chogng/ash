import { toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { type LanguageFeatureRegistry } from '../../../common/languageFeatureRegistry.js';
import { type DocumentFormattingEditProvider, type DocumentRangeFormattingEditProvider } from '../../../common/languages.js';
import { type ITextModel } from '../../../common/model.js';

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

export const enum FormattingKind {
	File = 1,
	Selection = 2,
}

export const enum FormattingMode {
	Explicit = 1,
	Silent = 2,
}

export interface IFormattingEditProviderSelector {
	<T extends DocumentFormattingEditProvider | DocumentRangeFormattingEditProvider>(formatters: T[], document: ITextModel, mode: FormattingMode, kind: FormattingKind): Promise<T | undefined>;
}

export abstract class FormattingConflicts {
	private static readonly selectors: { select: IFormattingEditProviderSelector }[] = [];

	public static setFormatterSelector(selector: IFormattingEditProviderSelector): IDisposable {
		const registration = { select: selector };
		this.selectors.push(registration);
		return toDisposable(() => {
			const index = this.selectors.indexOf(registration);
			if (index !== -1) {
				this.selectors.splice(index, 1);
			}
		});
	}

	public static async select<T extends DocumentFormattingEditProvider | DocumentRangeFormattingEditProvider>(formatters: T[], document: ITextModel, mode: FormattingMode, kind: FormattingKind): Promise<T | undefined> {
		if (formatters.length === 0) {
			return undefined;
		}
		return this.selectors.at(-1)?.select(formatters, document, mode, kind);
	}
}
