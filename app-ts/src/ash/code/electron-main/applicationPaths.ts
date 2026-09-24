import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AshRendererDirectory, AshUserDataFolderName } from '../common/application.js';
import { WorkbenchModeRegistry } from '../../workbench/common/workbenchMode.js';

export interface DesktopApplicationDataPaths {
	readonly userDataPath: string;
	readonly sessionDataPath: string;
}

/** Resolves persistent Electron roots shared by every Workbench mode. */
export function resolveApplicationDataPaths(appDataPath: string): DesktopApplicationDataPaths {
	if (appDataPath.trim().length === 0) throw new TypeError('Application data path must not be empty');
	const userDataPath = join(appDataPath, AshUserDataFolderName);
	return { userDataPath, sessionDataPath: join(userDataPath, 'session-data') };
}

/** Verifies that a packaged application contains the shared Workbench and each mode-owned entry. */
export function resolvePackagedRendererRoot(rendererRoot: string): string {
	const packagedRoot = join(rendererRoot, AshRendererDirectory);
	const requiredEntries = [
		join(packagedRoot, 'electron-browser', 'workbench', 'workbench.html'),
		...WorkbenchModeRegistry.definitions.flatMap(mode => mode.dedicatedSessions
			? [join(packagedRoot, 'electron-browser', 'sessions', `${mode.dedicatedSessions.rendererEntry}.html`)]
			: []),
	];
	const missing = requiredEntries.filter(entry => !existsSync(entry));
	if (missing.length > 0) throw new Error(`Packaged Ash renderer is incomplete: ${missing.join(', ')}`);
	return packagedRoot;
}
