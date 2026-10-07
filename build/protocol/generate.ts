import { execFile, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pythonCommand } from '../python.ts';

/** Cargo owns the transitive set of sources that can change exported contracts. */
export async function protocolSourceDirectories(signal?: AbortSignal): Promise<string[]> {
	const { command, args } = pythonCommand(['-B', 'build/protocol/generate.py', '--source-directories']);
	return new Promise((resolvePromise, reject) => {
		execFile(command, args, { cwd: resolve(import.meta.dirname, '../..'), signal }, (error, stdout) => {
			if (error) { reject(error); return; }
			try {
				const directories: unknown = JSON.parse(stdout);
				if (!Array.isArray(directories) || directories.length === 0 || !directories.every(directory => typeof directory === 'string')) throw new Error('Invalid protocol source directories');
				resolvePromise(directories);
			} catch (error) { reject(error); }
		});
	});
}

/** Prepares the cached Rust-owned contract consumed by frontend adapters and build tools. */
export async function generateProtocol(signal?: AbortSignal): Promise<void> {
	await new Promise<void>((resolvePromise, reject) => {
		const { command, args } = pythonCommand(['-B', 'build/protocol/generate.py']);
		const child = spawn(command, args, {
			cwd: resolve(import.meta.dirname, '../..'), stdio: 'inherit', windowsHide: true, signal,
		});
		child.once('error', reject);
		child.once('close', (code, termination) => {
			if (code === 0) resolvePromise();
			else reject(new Error(`Protocol generation ${termination ? `stopped by ${termination}` : `exited with status ${code}`}`));
		});
	});
	signal?.throwIfAborted();
}

if (import.meta.main) await generateProtocol();
