import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { writeApplicationChecksums } from './host.ts';
import { createHash } from 'node:crypto';

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

for (const mode of ['build', 'watch'] as const) {
	test(`Host ${mode} regenerates deleted outputs when incremental metadata remains`, { timeout: 30_000 }, async t => {
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
		await mkdir(join(root, 'build/lib'), { recursive: true });
		await copyFile(join(import.meta.dirname, '../lib/incrementalOutput.ts'), join(root, 'build/lib/incrementalOutput.ts'));
		await symlink(resolve(import.meta.dirname, '../../node_modules'), join(desktop, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
		await writeFile(join(root, 'package.json'), '{"type":"module"}');
		await mkdir(join(desktop, '.build/protocol/typescript'), { recursive: true });
		await mkdir(join(output, 'localization'), { recursive: true });
		await writeFile(join(desktop, '.build/protocol/typescript/shared.ts'), 'export const protocolVersion = 1;');
		await writeFile(join(output, 'localization/messages.ts'), 'export const label = "initial";');
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
				include: project === 'preload' ? [source, browserPreloadSource] : [source],
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
			for (let attempt = 0; attempt < 200; attempt++) {
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
			readyStates.length = 0;
			const cache = join(output, 'dev/cache');
			await mkdir(cache, { recursive: true });
			await Promise.all(Array.from({ length: 100 }, (_, index) => writeFile(join(cache, `runtime-${index}.ts`), `export const value = ${index};`)));
			await writeFile(join(output, 'runtime.log'), 'runtime output');
			await delay(500);
			assert.deepEqual(readyStates, [], 'Runtime and cache output must never trigger a Host compilation');
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
			await writeFile(join(desktop, 'src/main.ts'), 'export const version = 3;');
			await until(() => ready);
			assert.match(await readFile(join(output, 'main/src/main.js'), 'utf8'), /version = 3/u);
			assert.equal((await stat(preloadOutput)).mtimeMs, preloadModified);
			ready = false;
			await writeFile(join(desktop, 'tsconfig.base.json'), '{"compilerOptions":{"removeComments":true}}');
			await until(() => ready);
			assert.equal(JSON.parse(await readFile(join(output, 'main.tsbuildinfo'), 'utf8')).options.removeComments, true, 'Extended configuration changes remain watched');
		}
	});
}
