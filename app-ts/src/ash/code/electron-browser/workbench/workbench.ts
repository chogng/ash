import { AshWorkbenchName } from '../../common/application.js';
import { showStartupError } from '../../../workbench/browser/startupError.js';
import { invoke } from '../../../platform/ipc/electron-browser/rendererIpc.js';
import { NLS_CONFIGURATION_CHANNEL } from '../../../platform/languagePacks/common/languagePackStore.js';
import { parseLanguagePackCatalog } from '../../../platform/languagePacks/common/languagePackCatalog.js';
import { setNlsMessages } from '../../../nls.js';
import { createAppServerDebugAdapterCapability } from '../../../platform/debug/browser/appServerDebugAdapterProcessService.js';

try {
	const catalog = parseLanguagePackCatalog(await invoke<unknown>(NLS_CONFIGURATION_CHANNEL));
	if (!catalog) { throw new Error('Invalid startup display language'); }
	setNlsMessages(catalog.locale, catalog.bundles);
	performance.mark('ash.desktop.contributions-start');
	await import('../../../workbench/workbench.desktop.main.js');
	await import('../../../sessions/common/configuration.js');
	await import('../../../sessions/common/theme.js');
	await import('../../../sessions/contrib/openAgentsWindow/electron-browser/openAgentsWindow.contribution.js');
	await import('../../../sessions/contrib/providers/appServer/browser/workbenchSessionsService.contribution.js');
	await import('../../../sessions/browser/workbenchChat.contribution.js');
	await import('../../../sessions/browser/turnMultiDiffSource.contribution.js');
	const { main } = await import('../../../workbench/electron-browser/desktop.main.js');
	performance.mark('ash.desktop.contributions-ready');
	await main({ productName: AshWorkbenchName }, [createAppServerDebugAdapterCapability]);
} catch (error) {
	showStartupError(error, text => invoke<void>('ash:host:writeClipboard', text));
}
