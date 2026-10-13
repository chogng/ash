import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { generateProtocol } from './protocol/generate.ts';

const root = resolve(import.meta.dirname, '..');

/** One preparation owner for direct builds and pnpm lifecycle entrypoints. */
export async function prepareGenerated(): Promise<void> {
	await generateProtocol();
	const { generateLocalization } = await import('./resources/localization.ts');
	await generateLocalization();
	await runBun(['check', '-p', 'tsconfig.common.json', '--all']);
	const { prepareBuiltinExtensions } = await import('./builtin/extensions.ts');
	await prepareBuiltinExtensions();
	await runBun(['build/resources/icons/generate.ts', '--check']);
}

async function runBun(args: string[]): Promise<void> {
	await new Promise<void>((done, fail) => {
		const child = spawn(resolve(root, 'node_modules/bun/bin/bun.exe'), args, { cwd: root, stdio: 'inherit', windowsHide: true });
		child.once('error', fail);
		child.once('close', (code, signal) => code === 0 ? done() : fail(new Error(`Preparation ${signal ? `stopped by ${signal}` : `exited with status ${code}`}`)));
	});
}

if (import.meta.main) { await prepareGenerated(); }
