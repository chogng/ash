import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { createJsonCompletionProvider, createJsonFormattingProvider, createJsonHoverProvider } from '../common/jsonLanguageFeatures.js';

/** Installs the language contributions selected by the Workbench product. */
export class WorkbenchLanguageFeatures extends Disposable {
	constructor(@ILanguageFeaturesService languageFeaturesService: ILanguageFeaturesService) {
		super();
		this._register(languageFeaturesService.completionProvider.register(createJsonCompletionProvider()));
		this._register(languageFeaturesService.hoverProvider.register(['json', 'jsonc'], createJsonHoverProvider()));
		this._register(languageFeaturesService.documentFormattingEditProvider.register(['json', 'jsonc'], createJsonFormattingProvider()));
	}
}
