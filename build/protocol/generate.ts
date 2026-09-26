import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { syncProtocol } from './sync.ts';
import { pythonCommand } from '../python.ts';

/** Refreshes the canonical Rust-owned snapshot before updating its frontend consumer. */
export async function generateProtocol(signal?: AbortSignal): Promise<void> {
	await new Promise<void>((resolvePromise, reject) => {
		const { command, args } = pythonCommand(['-B', 'build/ash_rs/protocol.py']);
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
	await syncProtocol();
}

if (import.meta.main) await generateProtocol();
