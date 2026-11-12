import { showPartsSplash } from '../../../workbench/contrib/splash/browser/splash.js';
import { WINDOW_SPLASH_READ_CHANNEL, validatePartsSplash } from '../../../platform/theme/common/themeService.js';
import { AshWorkbenchName } from '../../common/application.js';
import { invoke } from '../../../platform/ipc/electron-browser/rendererIpc.js';
import { NLS_CONFIGURATION_CHANNEL, NLS_ACTIVATE_CHANNEL } from '../../../platform/languagePacks/common/languagePackStore.js';
import { resolveLanguagePackCatalog } from '../../../platform/languagePacks/common/languagePackCatalog.js';
import { setNlsMessages } from '../../../nls.js';
import { BrowserLanguagePackStore } from '../../../platform/languagePacks/browser/languagePackStore.js';
import { productLanguagePackSources } from '../../../../../.build/desktop/localization/localizationCatalogLoader.js';
import { createAppServerDebugAdapterCapability } from '../../../platform/debug/browser/appServerDebugAdapterProcessService.js';

try {
	const splashReady = invoke<unknown>(WINDOW_SPLASH_READ_CHANNEL).then(value => {
		const splash = validatePartsSplash(value);
		showPartsSplash(document, splash);
		return splash;
	});
	const catalogReady = invoke<unknown>(NLS_CONFIGURATION_CHANNEL).then(preference =>
		resolveLanguagePackCatalog(typeof preference === 'string' ? preference : 'en', productLanguagePackSources, new BrowserLanguagePackStore()));
	const [splash, catalog] = await Promise.all([splashReady, catalogReady]);
	setNlsMessages(catalog.locale, catalog.bundles);
	document.documentElement.lang = catalog.locale;
	// Module registration uses renderer NLS. Native menus need the selected catalog
	// by the time the Workbench starts using host services.
	const nativeLocalizationReady = invoke<void>(NLS_ACTIVATE_CHANNEL, catalog);
	const desktopMain = import('../../../workbench/electron-browser/desktop.main.js');
	const loadContributions = async (): Promise<void> => {
		performance.mark('ash.desktop.contributions-start');
		await import('../../../workbench/workbench.desktop.main.js');
		await import('../../../sessions/contrib/chatgptweb/common/chatGPTAccountLabel.js');
		await import('../../../sessions/common/configuration.js');
		await import('../../../sessions/common/theme.js');
		await import('../../../sessions/contrib/openAgentsWindow/electron-browser/openAgentsWindow.contribution.js');
		await import('../../../sessions/contrib/providers/agentHost/browser/workbenchSessionsService.contribution.js');
		await import('../../../sessions/browser/workbenchChat.contribution.js');
		await import('../../../sessions/contrib/providers/remoteAgentHost/browser/remoteAgentHost.contribution.js');
		await import('../../../sessions/contrib/changes/browser/changesMultiDiffSourceResolver.js');
		performance.mark('ash.desktop.contributions-ready');
	};
	const [{ main }] = await Promise.all([desktopMain, nativeLocalizationReady]);
	await main({ productName: AshWorkbenchName, splashTheme: splash.baseTheme }, [createAppServerDebugAdapterCapability], loadContributions);
} catch (error) {
	console.error('Unable to start Ash', error);
}
