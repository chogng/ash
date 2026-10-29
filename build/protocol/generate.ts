import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { pythonCommand, runPython } from '../python.ts';

/** Cargo owns the transitive set of sources that can change exported contracts. */
export async function protocolSourceDirectories(signal?: AbortSignal): Promise<string[]> {
	const { command, args } = pythonCommand(['-B', 'build/protocol/generate.py', '--source-directories']);
	return new Promise((resolvePromise, reject) => {
		execFile(command, args, { cwd: resolve(import.meta.dirname, '../..'), signal }, (error, stdout) => {
			if (error) {
				reject(error);
				return;
			}
			try {
				const directories: unknown = JSON.parse(stdout);
				if (!Array.isArray(directories) || directories.length === 0 || !directories.every(directory => typeof directory === 'string')) throw new Error('Invalid protocol source directories');
				resolvePromise(directories);
			} catch (error) {
				reject(error);
			}
		});
	});
}

/** Prepares the cached Rust-owned contract consumed by frontend adapters and build tools. */
export async function generateProtocol(signal?: AbortSignal): Promise<void> {
	await runPython(['-B', 'build/protocol/generate.py'], {
		cwd: resolve(import.meta.dirname, '../..'),
		operation: 'Protocol generation',
		signal,
	});
}

if (import.meta.main) await generateProtocol();
