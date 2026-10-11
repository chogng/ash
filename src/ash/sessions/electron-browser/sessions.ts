import { showStartupError } from '../../workbench/browser/startupError.js';
import { createSessionsProfile, type SessionsProfile } from '../common/sessionsProfile.js';
import { invoke } from '../../platform/ipc/electron-browser/rendererIpc.js';
import { NLS_CONFIGURATION_CHANNEL, NLS_ACTIVATE_CHANNEL } from '../../platform/languagePacks/common/languagePackStore.js';
import { resolveLanguagePackCatalog } from '../../platform/languagePacks/common/languagePackCatalog.js';
import { setNlsMessages } from '../../nls.js';
import { BrowserLanguagePackStore } from '../../platform/languagePacks/browser/languagePackStore.js';
import { productLanguagePackCatalogs } from '../../workbench/services/localization/common/localizationCatalogs.js';

try {
	const preference = await invoke<unknown>(NLS_CONFIGURATION_CHANNEL);
	const catalog = await resolveLanguagePackCatalog(typeof preference === 'string' ? preference : 'en', productLanguagePackCatalogs, new BrowserLanguagePackStore());
	setNlsMessages(catalog.locale, catalog.bundles);
	await invoke<void>(NLS_ACTIVATE_CHANNEL, catalog);
	await import('../sessions.desktop.main.js');
	const { main } = await import('./sessions.main.js');
	await main(createSessionsProfile(import.meta.env.ASH_SESSIONS_PROFILE as SessionsProfile));
} catch (error) {
	showStartupError(error, text => invoke<void>('ash:host:writeClipboard', text));
}
