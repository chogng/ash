import { TestLanguageConfigurationService } from './modes/testLanguageConfigurationService.js';
import { LanguageFeaturesService } from '../../common/services/languageFeaturesService.js';

/** Language feature fixture with separately owned language configurations. */
export class TestLanguageFeaturesService extends LanguageFeaturesService {
	public readonly languageConfigurationService: TestLanguageConfigurationService;

	constructor() {
		const languageConfigurations = new TestLanguageConfigurationService();
		super();
		this.languageConfigurationService = this._register(languageConfigurations);
	}
}
