import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { IpcRoute } from '../../ipc/electron-main/trustedIpcRouter.js';
import { EDIT_USER_HOOKS_CONFIGURATION_CHANNEL } from '../common/hooksIpc.js';

/** The host chooses the profile path; Renderer cannot request an arbitrary file or a remote path. */
export function hooksConfigurationIpcRoute(profileRoot: string, isLocalConnection: () => boolean, openTextFile: (path: string) => Promise<void>): IpcRoute<unknown, void> {
	return {
		channel: EDIT_USER_HOOKS_CONFIGURATION_CHANNEL,
		validate: value => { if (value !== undefined) throw new TypeError('Hooks configuration editing takes no arguments'); return undefined; },
		invoke: async () => {
			if (!isLocalConnection()) throw new Error('Edit the Hooks configuration on the connected remote host');
			const path = join(profileRoot, 'config.toml');
			await mkdir(profileRoot, { recursive: true });
			try { await writeFile(path, '', { flag: 'wx' }); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
			await openTextFile(path);
		},
	};
}

export async function openHooksTextFile(path: string): Promise<void> {
	let command: string[];
	switch (process.platform) {
		case 'darwin': command = ['open', '-t', path]; break;
		case 'win32': command = ['notepad.exe', path]; break;
		default: command = ['xdg-open', path];
	}
	await promisify(execFile)(command[0]!, command.slice(1));
}
