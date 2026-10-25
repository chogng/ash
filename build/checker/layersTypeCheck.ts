import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withProcessRun } from '../processes.ts';

/** Common is checked by prepare:generated; sandbox preloads retain their own declaration owner. */
export const PROJECTS = [
	{ name: 'browser', config: 'build/checker/tsconfig.browser.json' },
	{ name: 'worker', config: 'build/checker/tsconfig.worker.json' },
	{ name: 'node', config: 'build/checker/tsconfig.node.json' },
	{ name: 'electron-browser', config: 'build/checker/tsconfig.electron-browser.json' },
	{ name: 'electron-main', config: 'build/checker/tsconfig.electron-main.json' },
	{ name: 'electron-utility', config: 'build/checker/tsconfig.electron-utility.json' },
	{ name: 'preload', config: 'tsconfig.preload.json' },
] as const;

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	if (process.argv.length !== 2) throw new Error('Usage: node build/checker/layersTypeCheck.ts');
	const root = resolve(import.meta.dirname, '../..');
	const compiler = resolve(root, 'node_modules/bun', process.platform === 'win32' ? 'bun.exe' : 'bun');
	await withProcessRun(root, async (run, environment) => {
		// Bun parallelizes each check internally; serial projects avoid multiplying its memory/CPU budget.
		for (const project of PROJECTS) {
			if (run.stopped) break;
			console.log(`Checking ${project.name} environment`);
			const result = await run.command(compiler, ['check', '-p', project.config, '--all'], environment);
			if (result.code !== 0) process.exitCode = 1;
		}
	});
}
