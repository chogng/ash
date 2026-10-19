import { CodeEditingPolicy } from './editingPolicy.js';
import { DisposableStore } from '../../../src/ash/base/common/lifecycle.js';
import { ResolvedLanguageConfiguration } from '../../../src/ash/editor/common/languages/languageConfigurationRegistry.js';
import { registerTextModelFeatures, type TextModelFeatureParts } from '../../../src/ash/editor/common/model/textModelFeatures.js';
import { BracketPairsTextModelPart } from './model/bracketPairsTextModelPart/bracketPairsImpl.js';
import { ColorizedBracketPairsDecorationProvider } from './model/bracketPairsTextModelPart/colorizedBracketPairsDecorationProvider.js';
import { GuidesTextModelPart } from './model/guidesTextModelPart.js';
import { TokenizationTextModelPart } from './model/tokens/tokenizationTextModelPart.js';
import { ModelLanguageDiagnostics } from './modelLanguageDiagnostics.js';
import { onActivate } from './registration.js';

onActivate(() => registerTextModelFeatures((model, options) => {
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
			diagnostics: resources.add(new ModelLanguageDiagnostics(model, options.tokenization?.syntaxProviderRegistry, options.languageConfigurationService?.onDidChange)),
			decorations: resources.add(new ColorizedBracketPairsDecorationProvider(model)),
		});
		return parts;
	} catch (error) { resources.dispose(); throw error; }
}));
