import { showStartupError } from '../../../workbench/browser/startupError.js';
import { IndexedDbConfigurationApi } from '../../../platform/configuration/browser/indexedDbConfigurationApi.js';
import { BrowserLanguagePackStore } from '../../../platform/languagePacks/browser/languagePackStore.js';
import { initializeBrowserLocalization } from '../../../workbench/services/localization/browser/localizationBootstrap.js';
import { migrateAcademicWorkbenchUrl } from "../../../workbench/common/workbenchModeMigration.js";
import { resolveWorkbenchModeIdFromUrl, WorkbenchModeId } from "../../../workbench/common/workbenchMode.js";

declare const __ASH_WORKBENCH_MODE__: WorkbenchModeId;

const modeLoaders = {
	[WorkbenchModeId.Code]: () => import("./modes/code.js"),
} satisfies Record<WorkbenchModeId, () => Promise<unknown>>;

const migratedUrl = migrateAcademicWorkbenchUrl(window.location.href);
if (migratedUrl !== window.location.href) { window.history.replaceState(null, '', migratedUrl); }
const modeId = resolveWorkbenchModeIdFromUrl(migratedUrl, __ASH_WORKBENCH_MODE__);
try {
	{
		using configuration = new IndexedDbConfigurationApi();
		await initializeBrowserLocalization(configuration, new BrowserLanguagePackStore());
	}
	await import('../../../workbench/workbench.web.main.js');
	await modeLoaders[modeId]();
} catch (error) {
	showStartupError(error, text => navigator.clipboard.writeText(text));
}
