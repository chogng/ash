import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { pythonCommand } from '../python.ts';

test('addon preparation validates installed, cached and rebuilt bindings against Electron', async t => {
	const root = await mkdtemp(join(tmpdir(), 'ash-desktop-addons-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const files: Record<string, string> = {
		'package.json': '{"type":"module"}',
		'node_modules/electron/package.json': '{"name":"electron","version":"44.4.5","main":"index.cjs"}',
		'node_modules/electron/index.cjs': 'module.exports = process.execPath;',
		'node_modules/@electron/rebuild/package.json': '{"type":"module","exports":"./index.js"}',
		'node_modules/@electron/rebuild/index.js': `
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
export async function rebuild(options) {
  await appendFile(join(options.buildPath, 'rebuilds.jsonl'), JSON.stringify({ ...options, python: process.env.PYTHON }) + '\\n');
  if (await readFile(join(options.buildPath, 'fail-build')).catch(() => undefined)) throw new Error('Rebuild failed');
  for (const name of options.onlyModules) {
    const directory = join(options.buildPath, 'node_modules', name, 'build/Release');
    await mkdir(directory, { recursive: true });
    const bad = await readFile(join(options.buildPath, 'bad-build')).catch(() => undefined);
    await writeFile(join(directory, name === 'native-keymap' ? 'keymapping.node' : 'iselevated.node'), bad ? 'broken' : 'loadable');
  }
}`,
	};
	for (const name of ['native-keymap', 'native-is-elevated']) {
		files[`node_modules/${name}/package.json`] = JSON.stringify({ name, version: '1.0.0' });
		files[`node_modules/${name}/src/source.cc`] = 'original source';
		files[`node_modules/${name}/build/Release/${name === 'native-keymap' ? 'keymapping.node' : 'iselevated.node'}`] = 'loadable';
	}
	for (const [file, content] of Object.entries(files)) {
		await mkdir(dirname(join(root, file)), { recursive: true });
		await writeFile(join(root, file), content);
	}
	await mkdir(join(root, 'build/desktop'), { recursive: true });
	await copyFile(join(import.meta.dirname, 'addons.ts'), join(root, 'build/desktop/addons.ts'));
	await copyFile(join(import.meta.dirname, '../python.ts'), join(root, 'build/python.ts'));
	await copyFile(join(import.meta.dirname, '../processes.ts'), join(root, 'build/processes.ts'));
	const previousPython = process.env.PYTHON;
	const expectedPython = pythonCommand([]).command;
	const probes: string[][] = [];
	// This fixture models the loader result, not a fake production addon. The
	// actual Electron binary is exercised separately against the installed modules.
	t.mock.method(childProcess, 'execFile', (_executable: string, args: string[], options: childProcess.ExecFileOptions, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
		probes.push(args);
		assert.equal(options.env?.ELECTRON_RUN_AS_NODE, '1');
		assert.equal(options.windowsHide, true);
		let error: Error | null = null;
		try { assert.equal(readFileSync(args[2]!, 'utf8'), 'loadable'); } catch { error = new Error('Binding cannot load'); }
		queueMicrotask(() => callback(error, '', ''));
		return new childProcess.ChildProcess();
	});
	const { prepareElectronAddons } = await import(pathToFileURL(join(root, 'build/desktop/addons.ts')).href);
	const { pythonCommand: fixturePythonCommand } = await import(pathToFileURL(join(root, 'build/python.ts')).href);
	const binary = join(root, 'node_modules/native-keymap/build/Release/keymapping.node');
	const cacheDirectory = join(root, '.build/desktop-addons/v1', `${process.platform}-${process.arch}`, '44.4.5');
	const rebuilds = async () => (await readFile(join(root, 'rebuilds.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));

	await prepareElectronAddons(root);
	await assert.rejects(readFile(join(root, 'rebuilds.jsonl')), { code: 'ENOENT' });
	assert.deepEqual(probes[0]?.slice(3), ['44.4.5', process.arch, 'getKeyMap', 'getCurrentKeyboardLayout', 'onDidChangeKeyboardLayout']);
	assert.equal((await readdir(cacheDirectory)).length, process.platform === 'win32' ? 2 : 1);

	// A missing installed binding is repaired from the exact source/runtime cache.
	await rm(binary);
	await prepareElectronAddons(root);
	assert.equal(await readFile(binary, 'utf8'), 'loadable');
	await assert.rejects(readFile(join(root, 'rebuilds.jsonl')), { code: 'ENOENT' });

	// A checksum failure must not publish the cached bytes into node_modules.
	const cache = join(cacheDirectory, (await readdir(cacheDirectory)).find(file => file.startsWith('native-keymap-'))!);
	const record = JSON.parse(await readFile(cache, 'utf8'));
	record.data = Buffer.from('tampered').toString('base64');
	await writeFile(cache, JSON.stringify(record));
	await writeFile(binary, 'broken');
	await prepareElectronAddons(root);
	assert.equal((await rebuilds()).length, 1);
	assert.deepEqual((await rebuilds())[0].onlyModules, ['native-keymap']);
	assert.equal((await rebuilds())[0].disablePreGypCopy, true);
	assert.equal((await rebuilds())[0].python, fixturePythonCommand([]).command);
	assert.equal(process.env.PYTHON, previousPython, 'preparation restores the caller environment');

	// Integrity alone is insufficient: even checksummed bytes must load in Electron.
	const incompatible = Buffer.from('incompatible binding');
	await writeFile(cache, JSON.stringify({ sha256: createHash('sha256').update(incompatible).digest('hex'), data: incompatible.toString('base64') }));
	await rm(binary);
	await prepareElectronAddons(root);
	assert.equal((await rebuilds()).length, 2);

	// Changed sources cannot restore the previous version's build artifact.
	await writeFile(join(root, 'node_modules/native-keymap/src/source.cc'), 'changed source');
	await rm(binary);
	await prepareElectronAddons(root);
	assert.equal((await rebuilds()).length, 3);

	// Neither rebuild's metadata nor a zero exit code bypasses the runtime probe.
	await rm(binary);
	await writeFile(join(root, 'bad-build'), 'yes');
	await assert.rejects(prepareElectronAddons(root, { force: true }), /Binding cannot load/);
	await rm(join(root, 'bad-build'));
	await prepareElectronAddons(root);
	assert.equal(await readFile(binary, 'utf8'), 'loadable');
	assert.equal((await rebuilds()).length, 4, 'failed builds must not overwrite the valid cached binding');

	// Compiler failures must preserve both an unset and an explicitly configured interpreter.
	try {
		await writeFile(join(root, 'fail-build'), 'yes');
		for (const configuredPython of [undefined, expectedPython]) {
			if (configuredPython === undefined) delete process.env.PYTHON;
			else process.env.PYTHON = configuredPython;
			const selectedPython = fixturePythonCommand([]).command;
			await assert.rejects(prepareElectronAddons(root, { force: true }), /Rebuild failed/);
			assert.equal((await rebuilds()).at(-1).python, selectedPython);
			assert.equal(process.env.PYTHON, configuredPython);
		}
	} finally {
		if (previousPython === undefined) delete process.env.PYTHON;
		else process.env.PYTHON = previousPython;
	}
});
