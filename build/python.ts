import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface PythonHost {
	readonly platform: NodeJS.Platform;
	readonly environment: NodeJS.ProcessEnv;
	readonly fileExists: (path: string) => boolean;
}

const currentHost: PythonHost = { platform: process.platform, environment: process.env, fileExists: existsSync };

export function pythonCommand(args: string[], host: PythonHost = currentHost): { command: string; args: string[]; } {
	const configured = host.environment.PYTHON;
	if (configured) return { command: configured, args };
	const repositoryPython = resolve(import.meta.dirname, '../scripts/.venv', host.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
	if (host.fileExists(repositoryPython) || host.platform === 'win32') return { command: repositoryPython, args };
	if (host.platform === 'darwin') {
		for (const candidate of [
			'/opt/homebrew/opt/python@3.12/libexec/bin/python3',
			'/usr/local/opt/python@3.12/libexec/bin/python3',
		]) {
			if (host.fileExists(candidate)) return { command: candidate, args };
		}
	}
	return { command: 'python3', args };
}

if (import.meta.main) {
	const { command, args } = pythonCommand(process.argv.slice(2));
	const child = spawn(command, args, { stdio: 'inherit', windowsHide: true });
	child.once('error', error => {
		console.error(error);
		process.exitCode = 1;
	});
	child.once('close', (code, signal) => {
		process.exitCode = signal ? 1 : (code ?? 1);
	});
}
