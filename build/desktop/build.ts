import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { buildHost, prepareHostOutput } from './host.ts';
import { prepareGenerated } from '../prepare.ts';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const sourceRoot = resolve(repositoryRoot, '.');
// Use the pinned package executable on every platform, including Windows without a shell.
const checker = resolve(sourceRoot, 'node_modules/bun/bin/bun.exe');
const bundler = resolve(repositoryRoot, 'build/node_modules/vite/bin/vite.js');
const config = resolve(import.meta.dirname, 'vite/vite.config.ts');
const [command = 'all', ...extra] = process.argv.slice(2);
const prepared = extra.length === 1 && extra[0] === '--prepared';

if ((extra.length && !prepared) || !['all', 'host', 'renderer', 'web', 'prepare'].includes(command) || (command === 'prepare' && prepared)) {
	throw new Error('Usage: build.ts [all|host|renderer|web|prepare] [--prepared]');
}

if (command === 'prepare') {
	await prepareHostOutput();
} else {
	// CI owns preparation and no-emit checks before reusing these inputs.
	// Direct builds keep the complete preparation and validation path.
	if (!prepared) await prepareGenerated();
	if (command === 'all' || command === 'host') await buildHost();
	if (command === 'all' || command === 'renderer' || command === 'web') {
		if (!prepared) await run(checker, ['check', '-p', 'tsconfig.renderer.json', '--all']);
		await run(process.execPath, [bundler, 'build', '--config', config, ...(command === 'web' ? ['--mode', 'web'] : [])]);
	}
}

async function run(program: string, args: string[]): Promise<void> {
	await new Promise<void>((done, fail) => {
		const child = spawn(program, args, { cwd: sourceRoot, stdio: 'inherit', windowsHide: true });
		child.once('error', fail);
		child.once('close', (code, signal) => {
			if (code === 0) done();
			else fail(new Error(`${program} ${signal ? `stopped by ${signal}` : `exited with status ${code}`}`));
		});
	});
}
