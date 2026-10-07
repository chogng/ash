import { showStartupError } from '../../workbench/browser/startupError.js';
import { createSessionsProfile, type SessionsProfile } from '../common/sessionsProfile.js';
import { invoke } from '../../platform/ipc/electron-browser/rendererIpc.js';
import { NLS_CONFIGURATION_CHANNEL } from '../../platform/languagePacks/common/languagePackStore.js';
import { parseLanguagePackCatalog } from '../../platform/languagePacks/common/languagePackCatalog.js';
import { setNlsMessages } from '../../nls.js';

try {
	const catalog = parseLanguagePackCatalog(await invoke<unknown>(NLS_CONFIGURATION_CHANNEL));
	if (!catalog) {
		throw new Error('Invalid startup display language');
	}
	setNlsMessages(catalog.locale, catalog.bundles);
	await import('../sessions.desktop.main.js');
	const { main } = await import('./sessions.main.js');
	await main(createSessionsProfile(import.meta.env.ASH_SESSIONS_PROFILE as SessionsProfile));
} catch (error) {
	showStartupError(error, text => invoke<void>('ash:host:writeClipboard', text));
}
