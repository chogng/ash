import { showStartupError } from '../../../workbench/browser/startupError.js';
import { invoke } from '../../../platform/ipc/electron-browser/rendererIpc.js';
import { NLS_CONFIGURATION_CHANNEL } from '../../../platform/languagePacks/common/languagePackStore.js';
import { parseLanguagePackCatalog } from '../../../platform/languagePacks/common/languagePackCatalog.js';
import { setNlsMessages } from '../../../nls.js';
import { resolveWorkbenchModeIdFromUrl, WorkbenchModeId } from "../../../workbench/common/workbenchMode.js";

declare const __ASH_WORKBENCH_MODE__: WorkbenchModeId;

const modeLoaders = {
	[WorkbenchModeId.Code]: () => import("./modes/code.js"),
	[WorkbenchModeId.Academic]: () => import("./modes/academic.js"),
} satisfies Record<WorkbenchModeId, () => Promise<unknown>>;

const modeId = resolveWorkbenchModeIdFromUrl(window.location.href, __ASH_WORKBENCH_MODE__);
try {
	const catalog = parseLanguagePackCatalog(await invoke<unknown>(NLS_CONFIGURATION_CHANNEL));
	if (!catalog) { throw new Error('Invalid startup display language'); }
	setNlsMessages(catalog.locale, catalog.bundles);
	await import('../../../workbench/workbench.desktop.main.js');
	await modeLoaders[modeId]();
} catch (error) {
	showStartupError(error, text => invoke<void>('ash:host:writeClipboard', text));
}
