import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

/** The normal build and Vite share one locked, source-keyed WASM preparation. */
export async function prepareArkdown(): Promise<void> {
	const root = resolve(import.meta.dirname, '..');
	await new Promise<void>((done, fail) => {
		const child = spawn(process.execPath, [resolve(root, 'build/python.ts'), '-B', 'build/arkdown.py'], { cwd: root, stdio: 'inherit', windowsHide: true });
		child.once('error', fail);
		child.once('close', (code, signal) => code === 0 ? done() : fail(new Error(`Arkdown preparation ${signal ?? code}`)));
	});
}
