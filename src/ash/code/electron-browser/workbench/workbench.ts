import { showPartsSplash } from '../../../workbench/contrib/splash/browser/splash.js';
import { WINDOW_SPLASH_READ_CHANNEL, validatePartsSplash } from '../../../platform/theme/common/themeService.js';
import { AshWorkbenchName } from '../../common/application.js';
import { showStartupError } from '../../../workbench/browser/startupError.js';
import { invoke } from '../../../platform/ipc/electron-browser/rendererIpc.js';
import { NLS_CONFIGURATION_CHANNEL, NLS_ACTIVATE_CHANNEL } from '../../../platform/languagePacks/common/languagePackStore.js';
import { resolveLanguagePackCatalog } from '../../../platform/languagePacks/common/languagePackCatalog.js';
import { setNlsMessages } from '../../../nls.js';
import { BrowserLanguagePackStore } from '../../../platform/languagePacks/browser/languagePackStore.js';
import { productLanguagePackCatalogs } from '../../../workbench/services/localization/common/localizationCatalogs.js';
import { createAppServerDebugAdapterCapability } from '../../../platform/debug/browser/appServerDebugAdapterProcessService.js';

try {
	showPartsSplash(document, validatePartsSplash(await invoke<unknown>(WINDOW_SPLASH_READ_CHANNEL)));
	const preference = await invoke<unknown>(NLS_CONFIGURATION_CHANNEL);
	const catalog = await resolveLanguagePackCatalog(typeof preference === 'string' ? preference : 'en', productLanguagePackCatalogs, new BrowserLanguagePackStore());
	setNlsMessages(catalog.locale, catalog.bundles);
	await invoke<void>(NLS_ACTIVATE_CHANNEL, catalog);
	performance.mark('ash.desktop.contributions-start');
	await import('../../../workbench/workbench.desktop.main.js');
	await import('../../../sessions/common/configuration.js');
	await import('../../../sessions/common/theme.js');
	await import('../../../sessions/contrib/openAgentsWindow/electron-browser/openAgentsWindow.contribution.js');
	await import('../../../sessions/contrib/providers/agentHost/browser/workbenchSessionsService.contribution.js');
	await import('../../../sessions/browser/workbenchChat.contribution.js');
	await import('../../../sessions/browser/turnMultiDiffSource.contribution.js');
	await import('../../../sessions/contrib/changes/browser/changesMultiDiffSourceResolver.js');
	const { main } = await import('../../../workbench/electron-browser/desktop.main.js');
	performance.mark('ash.desktop.contributions-ready');
	await main({ productName: AshWorkbenchName }, [createAppServerDebugAdapterCapability]);
} catch (error) {
	showStartupError(error, text => invoke<void>('ash:host:writeClipboard', text));
}
