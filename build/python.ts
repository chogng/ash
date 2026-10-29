import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ProcessRun } from './processes.ts';

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

/** Keep compiler and helper descendants in the same cancellation lifetime as their Python builder. */
export async function runPython(arguments_: string[], options: { cwd: string; environment?: NodeJS.ProcessEnv; operation: string; signal?: AbortSignal; }): Promise<void> {
	const { signal } = options;
	signal?.throwIfAborted();
	const run = new ProcessRun(options.cwd, undefined, 5_000);
	const abort = (): void => { void run.stop('SIGTERM').catch(() => { /* The finally block awaits and reports cleanup errors. */ }); };
	signal?.addEventListener('abort', abort, { once: true });
	try {
		const { command, args } = pythonCommand(arguments_);
		// An inherited active stdin pipe can stall the Windows Python launcher.
		// A dedicated group is safe only while the caller owns its cancellation;
		// ordinary CLI preparation still receives the terminal's group signals.
		const child = spawn(command, args, { cwd: options.cwd, env: options.environment ?? process.env, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true, detached: signal !== undefined && process.platform !== 'win32' });
		const exited = new Promise<void>((resolvePromise, reject) => {
			child.once('error', reject);
			child.once('close', (code, termination) => {
				if (code === 0) resolvePromise();
				else reject(new Error(termination ? `${options.operation} stopped by ${termination}` : `${options.operation} exited with status ${code ?? 'unknown'}`));
			});
		});
		// Ownership discovery can yield while a failed spawn already rejects.
		void exited.catch(() => { });
		await run.own(child);
		await exited;
		signal?.throwIfAborted();
	} finally {
		signal?.removeEventListener('abort', abort);
		await run.close();
	}
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
