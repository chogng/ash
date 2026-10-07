import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, lstat, readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { ShellCommandOperation } from '../common/nativeHost.js';

/** Reads the desktop process's effective privilege, independently of its App Server. */
export async function isAdmin(): Promise<boolean> {
	if (process.platform === 'win32') {
		const { default: isElevated } = await import('native-is-elevated');
		return isElevated();
	}
	return process.geteuid!() === 0;
}

interface ShellCommandApplication {
	readonly isPackaged: boolean;
	readonly executablePath: string;
}

/** Installs or removes the desktop launcher without replacing another installation. */
export async function performShellCommand(operation: ShellCommandOperation, application: ShellCommandApplication): Promise<string> {
	if (process.platform !== 'darwin') {
		throw new Error('Shell command installation requires macOS');
	}
	if (!application.isPackaged) {
		throw new Error('Shell command installation requires a packaged Ash application');
	}
	const appBundle = dirname(dirname(dirname(application.executablePath)));
	if (!basename(appBundle).endsWith('.app')) {
		throw new Error('The Ash application bundle is unavailable');
	}
	const launcher = `#!/bin/sh\n# Ash desktop launcher\nexec /usr/bin/open -n -a '${appBundle.replaceAll("'", "'\\''")}' --args "$@"\n`;
	const { stdout: shellPath } = await promisify(execFile)(process.env.SHELL ?? '/bin/zsh', ['-lc', 'printf %s "$PATH"'], { encoding: 'utf8', timeout: 5_000 });
	const eligible = new Set(['/usr/local/bin', '/opt/homebrew/bin', join(homedir(), '.local', 'bin'), join(homedir(), 'bin')]);
	const directories = [...new Set(shellPath.split(delimiter).filter(path => eligible.has(path)))];
	if (directories.length === 0) {
		throw new Error('Add a writable bin directory to PATH before installing the ash command');
	}
	for (const directory of directories) {
		const commandPath = join(directory, 'ash');
		let existing: Awaited<ReturnType<typeof lstat>> | undefined;
		try {
			existing = await lstat(commandPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				throw error;
			}
		}
		if (existing) {
			if (!existing.isFile() || !(await readFile(commandPath, 'utf8')).startsWith('#!/bin/sh\n# Ash desktop launcher\n')) {
				throw new Error(`${commandPath} belongs to another installation`);
			}
			if (operation === 'uninstall') {
				await unlink(commandPath);
			} else {
				await writeFile(commandPath, launcher);
				await chmod(commandPath, 0o755);
			}
			return commandPath;
		}
		if (operation === 'install') {
			try {
				await access(directory, constants.W_OK);
			} catch {
				continue;
			}
			await writeFile(commandPath, launcher, { flag: 'wx', mode: 0o755 });
			return commandPath;
		}
	}
	throw new Error(operation === 'install' ? 'No writable bin directory is available in PATH' : 'The ash command is not installed in PATH');
}
