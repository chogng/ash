import { CodeEditingPolicy } from './editingPolicy.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { ResolvedLanguageConfiguration } from '../languages/languageConfigurationRegistry.js';
import type { TextModelFeatureFactory, TextModelFeatureParts } from './textModelFeatures.js';
import { BracketPairsTextModelPart } from './bracketPairsTextModelPart/bracketPairsImpl.js';
import { ColorizedBracketPairsDecorationProvider } from './bracketPairsTextModelPart/colorizedBracketPairsDecorationProvider.js';
import { GuidesTextModelPart } from './guidesTextModelPart.js';
import { TokenizationTextModelPart } from './tokens/tokenizationTextModelPart.js';
import { ModelLanguageDiagnostics } from './modelLanguageDiagnostics.js';

export const createTextModelFeatures: TextModelFeatureFactory = (model, options) => {
	if (options.extensionSnapshot) return undefined;
	const resources = new DisposableStore();
	try {
		const resolve = options.languageConfigurationService
			? (language: string) => options.languageConfigurationService!.getLanguageConfiguration(language)
			: (language: string) => new ResolvedLanguageConfiguration(language, {});
		const parts: TextModelFeatureParts = Object.assign(resources, {
			editingPolicy: CodeEditingPolicy,
			brackets: resources.add(new BracketPairsTextModelPart(model, resolve)),
			guides: resources.add(new GuidesTextModelPart(model, resolve)),
			tokenization: resources.add(new TokenizationTextModelPart(model, options.tokenization)),
			diagnostics: resources.add(
				new ModelLanguageDiagnostics(
					model,
					options.tokenization?.syntaxProviderRegistry,
					options.languageConfigurationService?.onDidChange,
				),
			),
			decorations: resources.add(new ColorizedBracketPairsDecorationProvider(model)),
		});
		return parts;
	} catch (error) {
		resources.dispose();
		throw error;
	}
};
