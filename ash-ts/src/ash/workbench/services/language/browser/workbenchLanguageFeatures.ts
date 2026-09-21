import { Disposable } from '../../../../base/common/lifecycle.js';
import { registerBuiltinLanguageConfigurations, registerBuiltinLanguageDescriptions } from '../../../../editor/standalone/common/builtinLanguages.js';
import type { ILanguageConfigurationService } from '../../../../editor/common/languages/languageConfigurationRegistry.js';
import type { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import type { IAshLanguageService } from '../../../../editor/common/languages/language.js';
import { createJsonCompletionProvider, createJsonFormattingProvider, createJsonHoverProvider } from '../common/jsonLanguageFeatures.js';

/** Installs the language contributions selected by the Workbench product. */
export class WorkbenchLanguageFeatures extends Disposable {
	constructor(languageService: IAshLanguageService, languageConfigurationService: ILanguageConfigurationService, languageFeaturesService: ILanguageFeaturesService) {
		super();
		this._register(registerBuiltinLanguageDescriptions(languageService.languages));
		this._register(registerBuiltinLanguageConfigurations(languageConfigurationService));
		this._register(languageFeaturesService.completionProvider.register(createJsonCompletionProvider()));
		this._register(languageFeaturesService.hoverProvider.register(['json', 'jsonc'], createJsonHoverProvider()));
		this._register(languageFeaturesService.documentFormattingEditProvider.register(['json', 'jsonc'], createJsonFormattingProvider()));
	}
}
