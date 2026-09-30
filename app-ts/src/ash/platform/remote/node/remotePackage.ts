import { join } from 'node:path';
import { developmentAshPackagePath } from '../../environment/node/developmentArtifacts.js';

/** Resolves local Remote management from the same package used by the Desktop host. */
export function remoteExecutablePath(location: { readonly appPath: string; readonly isPackaged: boolean; readonly platform: NodeJS.Platform; readonly resourcesPath: string }): string {
	const packageRoot = location.isPackaged ? location.resourcesPath : developmentAshPackagePath(location.appPath);
	return join(packageRoot, 'bin', location.platform === 'win32' ? 'ash-remote.exe' : 'ash-remote');
}
