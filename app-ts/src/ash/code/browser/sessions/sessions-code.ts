import { showStartupError } from '../../../workbench/browser/startupError.js';
import { codeSessionsProfile } from "../../common/codeSessionsProfile.js";
import { IndexedDbConfigurationApi } from '../../../platform/configuration/browser/indexedDbConfigurationApi.js';
import { BrowserLanguagePackStore } from '../../../platform/languagePacks/browser/languagePackStore.js';
import { initializeBrowserLocalization } from '../../../workbench/services/localization/browser/localizationBootstrap.js';

try {
	{
		using configuration = new IndexedDbConfigurationApi();
		await initializeBrowserLocalization(configuration, new BrowserLanguagePackStore());
	}
	const { startBrowserSessions } = await import('../../../sessions/browser/web.main.js');
	await startBrowserSessions(codeSessionsProfile);
} catch (error) {
	showStartupError(error, text => navigator.clipboard.writeText(text));
}
