import { showPartsSplash } from '../../../workbench/contrib/splash/browser/splash.js';
import { WINDOW_SPLASH_READ_CHANNEL, validatePartsSplash } from '../../../platform/theme/common/themeService.js';
import { AshWorkbenchName } from '../../common/application.js';
import { invoke } from '../../../platform/ipc/electron-browser/rendererIpc.js';
import { NLS_CONFIGURATION_CHANNEL, NLS_ACTIVATE_CHANNEL } from '../../../platform/languagePacks/common/languagePackStore.js';
import { resolveLanguagePackCatalog } from '../../../platform/languagePacks/common/languagePackCatalog.js';
import { setNlsMessages } from '../../../nls.js';
import { BrowserLanguagePackStore } from '../../../platform/languagePacks/browser/languagePackStore.js';
import { productLanguagePackCatalogs } from '../../../workbench/services/localization/common/localizationCatalogs.js';
import { createAppServerDebugAdapterCapability } from '../../../platform/debug/browser/appServerDebugAdapterProcessService.js';

try {
	const splash = validatePartsSplash(await invoke<unknown>(WINDOW_SPLASH_READ_CHANNEL));
	showPartsSplash(document, splash);
	const preference = await invoke<unknown>(NLS_CONFIGURATION_CHANNEL);
	const catalog = await resolveLanguagePackCatalog(typeof preference === 'string' ? preference : 'en', productLanguagePackCatalogs, new BrowserLanguagePackStore());
	setNlsMessages(catalog.locale, catalog.bundles);
	await invoke<void>(NLS_ACTIVATE_CHANNEL, catalog);
	const desktopMain = import('../../../workbench/electron-browser/desktop.main.js');
	const contributionsReady = (async () => {
		performance.mark('ash.desktop.contributions-start');
		await import('../../../workbench/workbench.desktop.main.js');
		await import('../../../sessions/common/configuration.js');
		await import('../../../sessions/common/theme.js');
		await import('../../../sessions/contrib/openAgentsWindow/electron-browser/openAgentsWindow.contribution.js');
		await import('../../../sessions/contrib/providers/agentHost/browser/workbenchSessionsService.contribution.js');
		await import('../../../sessions/browser/workbenchChat.contribution.js');
		await import('../../../sessions/contrib/providers/remoteAgentHost/browser/remoteAgentHost.contribution.js');
		await import('../../../sessions/contrib/changes/browser/changesMultiDiffSourceResolver.js');
		performance.mark('ash.desktop.contributions-ready');
	})();
	// DesktopMain observes registration failures when it joins the startup tasks.
	void contributionsReady.catch(() => undefined);
	const { main } = await desktopMain;
	await main({ productName: AshWorkbenchName, splashTheme: splash.baseTheme }, [createAppServerDebugAdapterCapability], contributionsReady);
} catch (error) {
	console.error('Unable to start Ash', error);
}
