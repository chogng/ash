import { join } from 'node:path';
import { developmentAshPackagePath } from '../../environment/node/developmentArtifacts.js';

interface RemotePackageLocation {
	readonly appPath: string;
	readonly isPackaged: boolean;
	readonly platform: NodeJS.Platform;
	readonly resourcesPath: string;
}

/** Resolves local Remote management from the same package used by the Desktop host. */
export function remoteExecutablePath(location: RemotePackageLocation): string {
	return remoteBinaryPath(location, 'ash-remote');
}

/** Resolves the packaged Rust owner for inbound hosting and local forwards. */
export function remoteHostExecutablePath(location: RemotePackageLocation): string {
	return remoteBinaryPath(location, 'ash-remote-host');
}

function remoteBinaryPath(location: RemotePackageLocation, name: string): string {
	const packageRoot = location.isPackaged ? location.resourcesPath : developmentAshPackagePath(location.appPath);
	return join(packageRoot, 'bin', location.platform === 'win32' ? `${name}.exe` : name);
}
