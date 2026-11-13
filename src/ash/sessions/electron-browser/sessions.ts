import { showSessionsSplash } from '../contrib/splash/browser/sessionsSplash.js';
import { WINDOW_SPLASH_READ_CHANNEL, validatePartsSplash } from '../../platform/theme/common/themeService.js';
import { createSessionsProfile, type SessionsProfile } from '../common/sessionsProfile.js';
import { invoke } from '../../platform/ipc/electron-browser/rendererIpc.js';
import { NLS_CONFIGURATION_CHANNEL, NLS_ACTIVATE_CHANNEL } from '../../platform/languagePacks/common/languagePackStore.js';
import { resolveLanguagePackCatalog } from '../../platform/languagePacks/common/languagePackCatalog.js';
import { setNlsMessages } from '../../nls.js';
import { BrowserLanguagePackStore } from '../../platform/languagePacks/browser/languagePackStore.js';
import { productLanguagePackSources } from '../../../../.build/desktop/localization/localizationCatalogLoader.js';

let canShowSplash = true;
try {
	const preferenceRequest = invoke<unknown>(NLS_CONFIGURATION_CHANNEL);
	// Main already supplied the window background. Cached paint is only useful before the workbench starts.
	void Promise.resolve().then(() => invoke<unknown>(WINDOW_SPLASH_READ_CHANNEL)).then(splash => {
		if (canShowSplash) showSessionsSplash(document, validatePartsSplash(splash));
	}).catch(error => console.warn('Could not read Ash Sessions startup appearance', error));
	const preference = await preferenceRequest;
	const catalog = await resolveLanguagePackCatalog(typeof preference === 'string' ? preference : 'en', productLanguagePackSources, new BrowserLanguagePackStore());
	setNlsMessages(catalog.locale, catalog.bundles);
	document.documentElement.lang = catalog.locale;
	await invoke<void>(NLS_ACTIVATE_CHANNEL, catalog);
	canShowSplash = false;
	await import('../sessions.desktop.main.js');
	if (import.meta.env.ASH_DEV_ARTIFACT_EXAMPLES) {
		await import('../test/browser/fixtures/artifactExamples.contribution.js');
	}
	const { main } = await import('./sessions.main.js');
	await main(createSessionsProfile(import.meta.env.ASH_SESSIONS_PROFILE as SessionsProfile));
} catch (error) {
	canShowSplash = false;
	console.error('Unable to start Ash Sessions', error);
}
