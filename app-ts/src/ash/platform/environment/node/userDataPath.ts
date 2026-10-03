import { homedir } from 'node:os';
import { join } from 'node:path';

/** Resolves the operating-system application data directory for a product. */
export function getDefaultUserDataPath(productName: string): string {
	if (process.platform === 'win32') {
		return join(process.env.APPDATA!, productName);
	}
	if (process.platform === 'darwin') {
		return join(homedir(), 'Library', 'Application Support', productName);
	}
	if (process.platform === 'linux') {
		return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), productName);
	}
	throw new Error('Platform not supported');
}
