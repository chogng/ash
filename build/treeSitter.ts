import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pythonCommand } from './python.ts';

/** Prepare portable release artifacts; grammar compilation belongs to ash-grammars. */
export async function prepareTreeSitterGrammars(): Promise<void> {
	const { command, args } = pythonCommand(['-B', '-m', 'build.lib.grammars', '--wasm']);
	await new Promise<void>((done, fail) => {
		const child = spawn(command, args, {
			cwd: resolve(import.meta.dirname, '..'),
			stdio: 'inherit',
			windowsHide: true,
		});
		child.once('error', fail);
		child.once('close', (code, signal) =>
			code === 0
				? done()
				: fail(
						new Error(
							`Grammar preparation ${signal ? `stopped by ${signal}` : `exited with status ${code}`}`,
						),
					),
		);
	});
}

if (import.meta.main) {
	await prepareTreeSitterGrammars();
}
