import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { buildHost, prepareHostOutput } from './host.ts';
import { generateLocalization } from '../resources/localization.ts';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const sourceRoot = resolve(repositoryRoot, 'app-ts');
const compiler = resolve(sourceRoot, 'node_modules/typescript/bin/tsc');
const bundler = resolve(repositoryRoot, 'build/node_modules/vite/bin/vite.js');
const config = resolve(import.meta.dirname, 'vite/vite.config.ts');
const [command = 'all', ...extra] = process.argv.slice(2);

if (extra.length || !['all', 'host', 'renderer', 'web', 'prepare'].includes(command)) {
	throw new Error('Usage: build.ts [all|host|renderer|web|prepare]');
}

if (command === 'prepare') {
	await prepareHostOutput();
} else {
	await generateLocalization();
	if (command === 'all' || command === 'host') await buildHost();
	if (command === 'all' || command === 'renderer' || command === 'web') {
		await run(compiler, ['-p', 'tsconfig.renderer.json']);
		await run(bundler, ['build', '--config', config, ...(command === 'web' ? ['--mode', 'web'] : [])]);
	}
}

async function run(program: string, args: string[]): Promise<void> {
	await new Promise<void>((done, fail) => {
		const child = spawn(process.execPath, [program, ...args], { cwd: sourceRoot, stdio: 'inherit', windowsHide: true });
		child.once('error', fail);
		child.once('close', (code, signal) => {
			if (code === 0) done();
			else fail(new Error(`${program} ${signal ? `stopped by ${signal}` : `exited with status ${code}`}`));
		});
	});
}
