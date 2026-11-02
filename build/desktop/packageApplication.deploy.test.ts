import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { parseAllDocuments } from 'yaml';
import { prepareElectronAddons } from './addons.ts';
import { ignoreApplicationFile, prepareProductionDependencyWorkspace, productionDependencyDeployOptions } from './packageApplication.ts';

const repository = resolve(import.meta.dirname, '../..');
const require = createRequire(join(repository, 'package.json'));
const execute = promisify(execFile);

test('real pnpm deployment resolves locked production dependencies and loads native bindings after relocation', {
	skip: process.env.ASH_DEPLOY_PRODUCT_TESTS !== '1' && 'Run with ASH_DEPLOY_PRODUCT_TESTS=1 through pnpm exec node --test',
	timeout: 600_000,
}, async t => {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'ash-deploy-product-')));
	t.after(async () => {
		assert.equal(dirname(root), await realpath(tmpdir()));
		assert(basename(root).startsWith('ash-deploy-product-'));
		await rm(root, { recursive: true, force: true });
	});
	const pnpm = process.env.npm_execpath;
	assert(pnpm, 'Run this test through pnpm exec node --test');
	const pnpmCommand = /\.[cm]?js$/iu.test(pnpm) ? process.execPath : pnpm;
	const pnpmArguments = /\.[cm]?js$/iu.test(pnpm) ? [pnpm] : [];
	const manifest = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8'));
	const version = await execute(pnpmCommand, [...pnpmArguments, '--version'], { cwd: repository, windowsHide: true });
	assert.equal(`pnpm@${version.stdout.trim()}`, manifest.packageManager);
	const source = join(root, 'dependencies');
	const deployed = join(root, 'deployed');
	const delivered = join(root, 'delivered');
	await prepareProductionDependencyWorkspace(repository, source);
	const originalLock = await readFile(join(source, 'pnpm-lock.yaml'), 'utf8');
	const installation = await execute(pnpmCommand, [...pnpmArguments, ...productionDependencyDeployOptions, deployed], {
		cwd: source, windowsHide: true, timeout: 300_000, maxBuffer: 4 * 1024 * 1024,
	});
	t.diagnostic(installation.stdout);
	assert.equal(await readFile(join(source, 'pnpm-lock.yaml'), 'utf8'), originalLock, 'deploy must preserve the source lockfile');
	await prepareElectronAddons(deployed);
	await cp(deployed, delivered, {
		recursive: true, dereference: true,
		filter: path => !ignoreApplicationFile(`/${relative(deployed, path).split(sep).join('/')}`),
	});
	// The delivered app must survive without the deploy source or its pnpm store.
	await rm(source, { recursive: true, force: true });
	await rm(deployed, { recursive: true, force: true });
	const documents = parseAllDocuments(originalLock);
	for (const document of documents) assert.deepEqual(document.errors, []);
	const expectations = join(root, 'locked-dependencies.json');
	await writeFile(expectations, JSON.stringify({ lock: documents.at(-1)!.toJS(), electron: require('electron/package.json').version }));
	const probe = async () => execute(require('electron'), [join(import.meta.dirname, 'fixtures/deployedDependencies.cjs'), delivered, expectations], {
		cwd: delivered, windowsHide: true, timeout: 60_000,
		env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: '', NODE_OPTIONS: '' },
	});
	const result = JSON.parse((await probe()).stdout) as { dependencies: { name: string; version: string; path: string; }[]; bindings: string[]; };
	assert(result.dependencies.some(dependency => dependency.name === 'fontkit'));
	const transitive = result.dependencies.find(dependency => dependency.name === 'brotli');
	assert(transitive, 'fontkit must retain its transitive Brotli dependency');
	assert.deepEqual(result.bindings, process.platform === 'win32' ? ['native-keymap', 'native-is-elevated'] : ['native-keymap']);
	t.diagnostic(`Resolved ${result.dependencies.length} locked dependencies; loaded ${result.bindings.join(', ')} and koffi in Electron`);
	await t.test('rejects a missing transitive production dependency', async () => {
		const removed = join(root, 'removed-dependency');
		await rename(transitive.path, removed);
		try { await assert.rejects(probe(), /Cannot resolve locked dependency brotli/); }
		finally { await rename(removed, transitive.path); }
	});
	await t.test('rejects a corrupt native binding rather than accepting its JavaScript wrapper', async () => {
		const binary = join(delivered, 'node_modules/native-keymap/build/Release/keymapping.node');
		const original = await readFile(binary);
		try {
			await writeFile(binary, 'invalid native binding');
			await assert.rejects(probe(), /ERR_DLOPEN_FAILED/);
		} finally { await writeFile(binary, original); }
	});
});
