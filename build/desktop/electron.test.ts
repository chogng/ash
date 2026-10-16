import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { AshApplicationId, AshApplicationName } from '../../src/ash/code/common/application.ts';
import { prepareDevelopmentElectron, resolveDevelopmentElectronExecutable } from './electron.ts';

test('resolving an unprepared macOS runtime fails without creating build outputs', { skip: process.platform !== 'darwin' }, t => {
	const root = mkdtempSync(join(tmpdir(), 'ash-electron-unprepared-'));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const upstream = join(root, 'Electron.app/Contents/MacOS/Electron');
	for (const directory of ['Electron.app/Contents/MacOS', 'resources/darwin', 'node_modules/electron', 'build/desktop']) mkdirSync(join(root, directory), { recursive: true });
	writeFileSync(upstream, 'fixture');
	writeFileSync(join(root, 'Electron.app/Contents/Info.plist'), 'fixture');
	writeFileSync(join(root, 'resources/darwin/ash.icns'), 'fixture');
	writeFileSync(join(root, 'build/desktop/electron.ts'), 'fixture');
	writeFileSync(join(root, 'package.json'), '{"private":true}');
	writeFileSync(join(root, 'node_modules/electron/index.js'), `module.exports = ${JSON.stringify(upstream)};`);
	assert.throws(() => resolveDevelopmentElectronExecutable(root), /Run pnpm prepare:electron/);
	assert.equal(existsSync(join(root, '.build')), false);
});

test('macOS development runtime brands Main and Helpers without changing the installed Electron', { skip: process.platform !== 'darwin' }, () => {
	const root = resolve(import.meta.dirname, '../..');
	const upstream: string = createRequire(join(root, 'package.json'))('electron');
	const sourcePlist = resolve(dirname(upstream), '../Info.plist');
	const sourceBefore = readFileSync(sourcePlist);
	const executable = prepareDevelopmentElectron(root);
	assert.equal(resolveDevelopmentElectronExecutable(root), executable);
	assert.notEqual(executable, upstream);
	assert.equal(executable.endsWith('/Ash.app/Contents/MacOS/Electron'), true);
	const bundle = resolve(dirname(executable), '../..');
	const metadata = plist(bundle);
	assert.equal(metadata.CFBundleName, AshApplicationName);
	assert.equal(metadata.CFBundleDisplayName, AshApplicationName);
	assert.equal(metadata.CFBundleExecutable, 'Electron');
	assert.equal(metadata.CFBundleIdentifier, `${AshApplicationId}.development`);
	assertIcon(bundle, root);
	const frameworks = join(bundle, 'Contents/Frameworks');
	const helpers = readdirSync(frameworks).filter(name => name.includes(' Helper') && name.endsWith('.app'));
	assert.ok(helpers.length > 0);
	for (const helper of helpers) {
		assert.ok(helper.startsWith(`${AshApplicationName} Helper`));
		const path = join(frameworks, helper);
		const metadata = plist(path);
		const name = helper.slice(0, -4);
		assert.equal(metadata.CFBundleName, name);
		assert.equal(metadata.CFBundleDisplayName, name);
		assert.equal(metadata.CFBundleExecutable, name);
		assert.ok(metadata.CFBundleIdentifier.startsWith(`${AshApplicationId}.development.`));
		assert.ok(statSync(join(path, 'Contents/MacOS', name)).isFile());
		assertIcon(path, root);
	}
	execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
	const modified = statSync(join(bundle, 'Contents/Info.plist')).mtimeMs;
	assert.equal(prepareDevelopmentElectron(root), executable);
	assert.equal(resolveDevelopmentElectronExecutable(root), executable);
	assert.equal(statSync(join(bundle, 'Contents/Info.plist')).mtimeMs, modified);
	assert.deepEqual(readFileSync(sourcePlist), sourceBefore);
	// The backend still uses this Electron executable as its Node host.
	const runtime = JSON.parse(execFileSync(executable, ['-e', 'console.log(JSON.stringify({electron:process.versions.electron,execPath:process.execPath}))'], {
		env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8',
	}));
	assert.equal(runtime.execPath, executable);
	assert.ok(runtime.electron);
});

test('bundled launchers resolve the same prepared runtime without running preparation', { skip: process.platform !== 'darwin' }, t => {
	const root = resolve(import.meta.dirname, '../..');
	const expected = prepareDevelopmentElectron(root);
	const directory = mkdtempSync(join(tmpdir(), 'ash-electron-bundled-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const entry = join(directory, 'entry.mjs');
	const output = join(directory, 'bundle.mjs');
	writeFileSync(entry, `import { resolveDevelopmentElectronExecutable } from ${JSON.stringify(join(root, 'build/desktop/electron.ts'))}; console.log(resolveDevelopmentElectronExecutable(${JSON.stringify(root)}));`);
	const esbuild = createRequire(join(root, 'test/scenario/package.json'))('esbuild');
	esbuild.buildSync({ entryPoints: [entry], outfile: output, bundle: true, platform: 'node', format: 'esm', packages: 'external' });
	assert.equal(execFileSync(process.execPath, [output], { encoding: 'utf8' }).trim(), expected);
});

function plist(bundle: string): Record<string, string> {
	return JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(bundle, 'Contents/Info.plist')], { encoding: 'utf8' }));
}

function assertIcon(bundle: string, root: string): void {
	assert.equal(plist(bundle).CFBundleIconFile, 'ash.icns');
	const digest = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');
	assert.equal(digest(join(bundle, 'Contents/Resources/ash.icns')), digest(join(root, 'resources/darwin/ash.icns')));
}
