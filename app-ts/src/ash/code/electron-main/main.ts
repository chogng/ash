import { app } from 'electron/main';
import { join } from 'node:path';
import { WorkbenchModeRegistry } from '../../workbench/common/workbenchMode.js';
import { resolveHome } from '../../platform/home/node/home.js';
import { migrateLegacyLocalProfile } from '../../platform/profile/node/localProfile.js';
import { readPersistedWorkbenchModeId } from './readPersistedWorkbenchMode.js';
import { startElectronApplication } from './startElectronApplication.js';

const profileRoot = resolveHome();
const migrationConflict = await migrateLegacyLocalProfile({ legacyUserDataRoot: app.getPath('userData'), profileRoot });
if (migrationConflict) console.error(`Settings migration conflict: ${migrationConflict.legacyPath} and ${migrationConflict.settingsPath}`);
const configuredModeId = !app.isPackaged && process.env.ASH_WORKBENCH_MODE !== undefined
	? WorkbenchModeRegistry.resolveModeId(process.env.ASH_WORKBENCH_MODE)
	: readPersistedWorkbenchModeId(join(profileRoot, 'settings.json'), WorkbenchModeRegistry.defaultModeId);

startElectronApplication({
	initialModeId: configuredModeId,
});
