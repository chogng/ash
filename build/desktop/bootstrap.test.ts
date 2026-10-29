import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

test('Electron bootstrap keeps the event loop responsive after launcher output pipes close', { timeout: 10_000 }, async t => {
	const root = await mkdtemp(join(tmpdir(), 'ash-bootstrap-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const electron = join(root, 'electron.mjs');
	await writeFile(electron, 'export const app = { enableSandbox() {} };');
	const repository = resolve(import.meta.dirname, '../..');
	const config = ts.readConfigFile(join(repository, 'tsconfig.main.json'), ts.sys.readFile);
	const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, repository);
	for (const file of ['bootstrap', 'ash/base/common/errors']) {
		const output = join(root, `${file}.js`);
		await mkdir(resolve(output, '..'), { recursive: true });
		const source = await readFile(join(repository, `src/${file}.ts`), 'utf8');
		// The fixture retains the product's ESM package scope during single-file emit.
		await writeFile(output, ts.transpileModule(source, { compilerOptions: options, fileName: `${file}.mts` }).outputText);
	}
	await writeFile(join(root, 'package.json'), '{"type":"module"}');
	const bootstrap = pathToFileURL(join(root, 'bootstrap.js')).href;
	const script = `
		import { registerHooks } from 'node:module';
		registerHooks({ resolve(specifier, context, nextResolve) {
			if (specifier === 'electron/main') return { url: ${JSON.stringify(pathToFileURL(electron).href)}, shortCircuit: true };
			return nextResolve(specifier, context);
		} });
		const { bootstrapElectronMain } = await import(${JSON.stringify(bootstrap)});
		bootstrapElectronMain();
		let exceptions = 0;
		process.on('uncaughtExceptionMonitor', () => { exceptions++; });
		process.on('message', () => {
			console.log('Writing to the closed launcher stdout');
			console.error('Writing to the closed launcher stderr');
			Promise.reject(new Error('An ordinary rejection still uses the error handler'));
			setTimeout(() => process.send({ exceptions }, () => process.exit(0)), 100);
		});
		process.send('ready');
	`;
	const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
		stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
		env: { ...process.env, NODE_OPTIONS: undefined },
	});
	t.after(() => {
		if (child.exitCode === null) child.kill();
	});
	let result: unknown;
	let stderr = '';
	child.stderr!.on('data', data => {
		stderr += data.toString();
	});
	child.on('message', message => {
		if (message === 'ready') {
			child.stdout!.destroy();
			child.stderr!.destroy();
			child.send('pipes closed');
		} else {
			result = message;
		}
	});
	const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, fail) => {
		child.once('error', fail);
		child.once('exit', (code, signal) => done({ code, signal }));
	});
	assert.deepEqual(exit, { code: 0, signal: null }, stderr);
	assert.deepEqual(result, { exceptions: 0 });
});
