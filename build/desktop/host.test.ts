import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { bundleWindowsMain, copyHostOutput, writeApplicationChecksums } from './host.ts';
import { createHash } from 'node:crypto';

test('Windows packaging bundles the Main entry and keeps optional modules lazy', async t => {
	const root = await mkdtemp(join(tmpdir(), 'ash-main-bundle-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const directory = join(root, 'src');
	const entry = join(directory, 'main.js');
	await mkdir(directory);
	await writeFile(join(root, 'package.json'), '{"type":"module"}');
	await writeFile(join(directory, 'startup.js'), 'export const message = "ready";');
	await writeFile(join(directory, 'optional.js'), 'console.log("optional");');
	await writeFile(entry, 'import { message } from "./startup.js"; console.log(message); if (process.argv[2]) await import("./optional.js");');

	await bundleWindowsMain(root);
	await rm(join(directory, 'startup.js'));
	await rm(join(directory, 'optional.js'));
	for (const [args, output] of [[[], 'ready'], [['open'], 'ready\noptional']] as const) {
		const result = spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8', windowsHide: true });
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout.trim().replaceAll('\r\n', '\n'), output);
	}
});

test('packaging publishes final desktop assets without hashing metadata or user files', async t => {
	const root = await mkdtemp(join(tmpdir(), 'ash-publish-checksums-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const files = ['dist/main/src/main.js', 'dist/preload/src/ash/base/parts/sandbox/electron-browser/preload.cjs', 'dist/renderer/ash/electron-browser/workbench/workbench.html', 'resources/tray/icon.png'];
	for (const file of files) {
		await mkdir(join(root, file, '..'), { recursive: true });
		await writeFile(join(root, file), file);
	}
	await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'ash-desktop', version: '1.0.0', checksums: { stale: 'old' } }));
	await writeFile(join(root, 'user-settings.json'), 'not an installation asset');
	await writeApplicationChecksums(root);
	const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
	assert.deepEqual(metadata, {
		name: 'ash-desktop', version: '1.0.0',
		checksums: Object.fromEntries(files.map(file => [file, createHash('sha256').update(file).digest('hex')])),
	});
	await rm(join(root, files[0]));
	await assert.rejects(writeApplicationChecksums(root), /omit an entrypoint/);
});

test('macOS checksums record native helper bytes after signing', { skip: process.platform !== 'darwin' }, async t => {
	const root = await mkdtemp(join(tmpdir(), 'ash-signed-checksums-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	for (const path of ['dist/main/src/main.js', 'dist/preload/src/ash/base/parts/sandbox/electron-browser/preload.cjs', 'dist/renderer/ash/electron-browser/workbench/workbench.html']) {
		await mkdir(join(root, path, '..'), { recursive: true });
		await writeFile(join(root, path), 'fixture');
	}
	await mkdir(join(root, 'resources'));
	await writeFile(join(root, 'package.json'), '{}');
	const helper = 'dist/main/helper';
	await copyFile('/usr/bin/true', join(root, helper));
	await writeApplicationChecksums(root);
	const original = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).checksums[helper];
	const signature = spawnSync('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'ash.integrity.fixture', join(root, helper)], { encoding: 'utf8' });
	assert.equal(signature.status, 0, signature.stderr);
	const actual = createHash('sha256').update(await readFile(join(root, helper))).digest('hex');
	assert.notEqual(actual, original, 'Signing changes the bytes covered by the installation manifest');
	await writeApplicationChecksums(root);
	assert.equal(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).checksums[helper], actual);
});

// Windows compiler ownership takes CIM snapshots on every rebuild and cleanup.
for (const mode of ['build', 'watch'] as const) {
	test(`Host ${mode} regenerates deleted outputs when incremental metadata remains`, { timeout: process.platform === 'win32' ? 120_000 : 30_000 }, async t => {
		const temporary = await realpath(await mkdtemp(join(tmpdir(), 'ash-host-')));
		const root = join(temporary, 'workspace', 'project', 'desktop');
		await mkdir(root, { recursive: true });
		let watcher: Awaited<ReturnType<typeof import('./host.ts').watchHost>> | undefined;
		t.after(async () => {
			await watcher?.close();
			await rm(temporary, { recursive: true, force: true });
		});
		const desktop = join(root, '.');
		const output = join(root, '.build/desktop');
		const compiler = resolve(import.meta.dirname, '../../node_modules/@ash/typescript-compiler/bin/tsc');
		const preloadSource = 'src/ash/base/parts/sandbox/electron-browser/preload.cts';
		const browserPreloadSource = 'src/ash/platform/browserView/electron-browser/preload-browserView.ts';
		const preloadOutput = join(output, 'preload', preloadSource.replace(/\.cts$/u, '.cjs'));
		await mkdir(join(desktop, 'src/ash/base/parts/sandbox/electron-browser'), { recursive: true });
		await mkdir(join(root, 'build/desktop'), { recursive: true });
		for (const file of ['host.ts', 'paths.ts']) {
			await copyFile(join(import.meta.dirname, file), join(root, 'build/desktop', file));
		}
		await copyFile(join(import.meta.dirname, '../processes.ts'), join(root, 'build/processes.ts'));
		// Isolate compiler/watch behavior from Rust compilation; the native builder
		// has its own generation-publication tests and real build validation.
		await writeFile(join(root, 'build/python.ts'), 'export let preparations = 0; export async function runPython() { preparations++; }');
		const nativeBuilder = await import(pathToFileURL(join(root, 'build/python.ts')).href) as { readonly preparations: number; };
		for (const name of ['host-logs', 'host-integrity', 'image-opener']) {
			await mkdir(join(root, 'crates', name), { recursive: true });
		}
		const nativeSource = join(root, 'crates/host-logs/lib.rs');
		await writeFile(nativeSource, 'pub const VERSION: u8 = 1;');
		await mkdir(join(root, 'build/lib'), { recursive: true });
		await copyFile(join(import.meta.dirname, '../lib/incrementalOutput.ts'), join(root, 'build/lib/incrementalOutput.ts'));
		await symlink(resolve(import.meta.dirname, '../../node_modules'), join(desktop, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
		await writeFile(join(root, 'package.json'), '{"type":"module"}');
		await mkdir(join(desktop, '.build/protocol/typescript'), { recursive: true });
		await mkdir(join(output, 'localization'), { recursive: true });
		await writeFile(join(desktop, '.build/protocol/typescript/shared.ts'), 'export const protocolVersion = 1;');
		await writeFile(join(output, 'localization/messages.ts'), 'export const label = "initial";');
		await writeFile(join(desktop, 'src/renderer.ts'), 'export const renderer = 1;');
		await writeFile(join(desktop, 'src/main.ts'), 'export { protocolVersion } from "../.build/protocol/typescript/shared.js"; export { label } from "../.build/desktop/localization/messages.js"; export const version = 1;');
		await mkdir(join(desktop, 'src/ash/platform/browserView/electron-browser'), { recursive: true });
		await writeFile(join(desktop, browserPreloadSource), 'declare function require(name: string): unknown; (() => { require("electron"); })();');
		await writeFile(join(desktop, preloadSource), 'declare function require(name: string): unknown; export const electron = require("electron");');
		await writeFile(join(desktop, 'tsconfig.base.json'), '{"compilerOptions":{}}');
		for (const [project, source] of [['main', 'src/main.ts'], ['preload', preloadSource]]) {
			await writeFile(join(desktop, `tsconfig.${project}.json`), JSON.stringify({
				extends: './tsconfig.base.json',
				compilerOptions: {
					module: 'NodeNext', moduleDetection: 'legacy', target: 'ES2022', types: [], rootDir: '.', incremental: true,
					outDir: `.build/desktop/${project}`, tsBuildInfoFile: `.build/desktop/${project}.tsbuildinfo`,
				},
				include: project === 'preload' ? [source, browserPreloadSource] : [source, 'src/extra/*.ts'],
			}));
		}
		const initial = spawnSync(process.execPath, [compiler, '--build', 'tsconfig.main.json', 'tsconfig.preload.json', '--pretty', 'false'], {
			cwd: desktop, encoding: 'utf8', windowsHide: true, timeout: 10_000,
		});

		assert.equal(initial.error, undefined);
		assert.equal(initial.status, 0, initial.stdout + initial.stderr);
		await Promise.all(['main', 'preload'].map(project => rm(join(output, project), { recursive: true })));
		for (const project of ['main', 'preload']) {
			assert.ok((await stat(join(output, `${project}.tsbuildinfo`))).isFile());
		}

		const host: typeof import('./host.ts') = await import(pathToFileURL(join(root, 'build/desktop/host.ts')).href);
		let ready = false;
		const readyStates: boolean[] = [];
		async function until(predicate: () => boolean): Promise<void> {
			const deadline = Date.now() + (process.platform === 'win32' ? 20_000 : 10_000);
			while (Date.now() < deadline) {
				if (predicate()) return;
				await delay(50);
			}
			assert.fail('Host did not publish the expected compilation state');
		}
		if (mode === 'build') {
			await host.buildHost();
		} else {
			watcher = await host.watchHost(value => { ready = value; readyStates.push(value); });
			await until(() => ready);
		}
		assert.equal(nativeBuilder.preparations, 1, 'Startup prepares native helpers once before compiling the Host');
		assert.match(await readFile(join(output, 'main/src/main.js'), 'utf8'), /version = 1/u);
		assert.match(await readFile(preloadOutput, 'utf8'), /require\("electron"\)/u);
		if (mode === 'build') {
			const paths = ['main/src/main.js', 'main.tsbuildinfo', 'preload.tsbuildinfo', 'package.json'].map(path => join(output, path));
			const before = await Promise.all(paths.map(async path => (await stat(path, { bigint: true })).mtimeNs));
			await host.buildHost();
			assert.deepEqual(await Promise.all(paths.map(async path => (await stat(path, { bigint: true })).mtimeNs)), before, 'unchanged Host builds preserve emit and incremental state');
			await rm(join(output, 'main/src/main.js'));
			await host.buildHost();
			assert.match(await readFile(join(output, 'main/src/main.js'), 'utf8'), /version = 1/u);
		}

		if (mode === 'watch') {
			ready = false;
			const previousPreparations = nativeBuilder.preparations;
			await writeFile(nativeSource, 'pub const VERSION: u8 = 2;');
			await until(() => ready);
			assert.ok(nativeBuilder.preparations > previousPreparations, 'Native source edits still prepare helpers before publishing readiness');
			readyStates.length = 0;
			const cache = join(output, 'dev/cache');
			await mkdir(cache, { recursive: true });
			await Promise.all(Array.from({ length: 100 }, (_, index) => writeFile(join(cache, `runtime-${index}.ts`), `export const value = ${index};`)));
			await writeFile(join(output, 'runtime.log'), 'runtime output');
			await writeFile(join(desktop, 'src/renderer.ts'), 'export const renderer = 2;');
			await writeFile(join(desktop, 'src/renderer-added.ts'), 'export const renderer = 3;');
			await delay(800);
			assert.deepEqual(readyStates, [], 'Renderer-only edits, additions, and runtime outputs must not trigger Host compilation');
			ready = false;
			await writeFile(join(desktop, '.build/protocol/typescript/shared.ts'), 'export const protocolVersion = 2;');
			await until(() => ready);
			assert.match(await readFile(join(output, 'main/.build/protocol/typescript/shared.js'), 'utf8'), /protocolVersion = 2/u);
			ready = false;
			await writeFile(join(output, 'localization/messages.ts'), 'export const label = "updated";');
			await until(() => ready);
			assert.match(await readFile(join(output, 'main/.build/desktop/localization/messages.js'), 'utf8'), /updated/u);
			const preloadModified = (await stat(preloadOutput)).mtimeMs;
			ready = false;
			await writeFile(join(desktop, 'src/main.ts'), 'export const version = 2;');
			await until(() => ready);
			assert.match(await readFile(join(output, 'main/src/main.js'), 'utf8'), /version = 2/u);
			assert.equal((await stat(preloadOutput)).mtimeMs, preloadModified, 'Watching keeps unchanged projects incremental');

			readyStates.length = 0;
			await writeFile(join(desktop, 'src/main.ts'), 'export const version: number = "invalid";');
			await until(() => readyStates.length >= 2);
			assert.deepEqual(readyStates, [false, false], 'A failed rebuild must not publish readiness');
			assert.match(await readFile(join(output, 'main/src/main.js'), 'utf8'), /version = "invalid"/u, 'The failed compiler must have consumed the invalid source');
			await writeFile(join(desktop, 'src/main.ts'), 'export const version = 3;');
			await until(() => ready);
			assert.match(await readFile(join(output, 'main/src/main.js'), 'utf8'), /version = 3/u);
			assert.equal((await stat(preloadOutput)).mtimeMs, preloadModified);
			if (process.platform === 'win32') {
				const source = join(desktop, 'src/main.ts');
				const sourceBefore = await stat(source);
				ready = false;
				await writeFile(source, 'export const version = 4;');
				await utimes(source, sourceBefore.atime, sourceBefore.mtime);
				await until(() => ready);
				assert.match(await readFile(join(output, 'main/src/main.js'), 'utf8'), /version = 4/u, 'Equal-size edits with restored mtime still rebuild');
			}
			ready = false;
			await writeFile(join(desktop, 'tsconfig.base.json'), '{"compilerOptions":{"removeComments":true}}');
			await until(() => ready);
			assert.equal(JSON.parse(await readFile(join(output, 'main.tsbuildinfo'), 'utf8')).options.removeComments, true, 'Extended configuration changes remain watched');
			await mkdir(join(desktop, 'src/extra'));
			ready = false;
			await writeFile(join(desktop, 'src/extra/added.ts'), 'export const added = 1;');
			await until(() => ready);
			assert.match(await readFile(join(output, 'main/src/extra/added.js'), 'utf8'), /added = 1/u);
			ready = false;
			await writeFile(join(desktop, 'src/extra/added.ts'), 'export const added = 2;');
			await until(() => ready);
			assert.match(await readFile(join(output, 'main/src/extra/added.js'), 'utf8'), /added = 2/u);
			ready = false;
			await rm(join(desktop, 'src/extra/added.ts'));
			await until(() => ready);
			assert.ok(!JSON.parse(await readFile(join(output, 'main.tsbuildinfo'), 'utf8')).fileNames.some((file: string) => file.endsWith('/extra/added.ts')), 'Removing an input refreshes the compiler inventory');
		}
	});
}

test('packaging selects the current Rust host executables and excludes old running generations', async t => {
	const root = await mkdtemp(join(tmpdir(), 'ash-host-log-package-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const source = join(root, 'main');
	await mkdir(join(source, '.build/desktop'), { recursive: true });
	await writeFile(join(source, 'package.json'), '{"type":"module"}');
	await writeFile(join(source, '.build/desktop/hostLogs.js'), [
		'export const hostLogExecutable = "host-logs/current/ash-host-logs.exe";',
		'export const hostIntegrityExecutable = "host-integrity/current/ash-host-integrity.exe";',
		'export const imageOpenerExecutable = "image-opener/current/ash-image-opener.exe";',
	].join('\n'));
	const directories = ['host-logs', 'host-integrity', 'image-opener'];
	for (const directory of directories) {
		for (const generation of ['old', 'current']) {
			await mkdir(join(source, directory, generation), { recursive: true });
			await writeFile(join(source, directory, generation, `ash-${directory}.exe`), generation);
		}
	}
	const destination = join(root, 'package');
	await copyHostOutput(source, destination);
	for (const directory of directories) {
		assert.equal(await readFile(join(destination, directory, 'current', `ash-${directory}.exe`), 'utf8'), 'current');
		await assert.rejects(stat(join(destination, directory, 'old')), { code: 'ENOENT' });
	}
});
