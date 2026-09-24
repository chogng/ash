import { app } from 'electron/main';
import { join } from 'node:path';
import { WorkbenchModeRegistry } from '../../workbench/common/workbenchMode.js';
import { resolveHome } from '../../platform/home/node/home.js';
import { readPersistedWorkbenchModeId } from './readPersistedWorkbenchMode.js';
import { startElectronApplication } from './startElectronApplication.js';

const configuredModeId = !app.isPackaged && process.env.ASH_WORKBENCH_MODE !== undefined
	? WorkbenchModeRegistry.resolveModeId(process.env.ASH_WORKBENCH_MODE)
	: readPersistedWorkbenchModeId(join(resolveHome(), 'configuration.json'), WorkbenchModeRegistry.defaultModeId);

startElectronApplication({
	initialModeId: configuredModeId,
});
