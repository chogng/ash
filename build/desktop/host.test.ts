import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
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
		const root = await mkdtemp(join(tmpdir(), 'ash-host-'));
		let watcher: Awaited<ReturnType<typeof import('./host.ts').watchHost>> | undefined;
		t.after(async () => {
			await watcher?.close();
			await rm(root, { recursive: true, force: true });
		});
		const desktop = join(root, '.');
		const output = join(root, '.build/desktop');
		const compiler = resolve(import.meta.dirname, '../../node_modules/@ash/typescript-compiler/bin/tsc');
		const preloadSource = 'src/ash/base/parts/sandbox/electron-browser/preload.cts';
		const preloadOutput = join(output, 'preload', preloadSource.replace(/\.cts$/u, '.cjs'));
		await mkdir(join(desktop, 'src/ash/base/parts/sandbox/electron-browser'), { recursive: true });
		await mkdir(join(root, 'build/desktop'), { recursive: true });
		for (const file of ['host.ts', 'paths.ts']) {
			await copyFile(join(import.meta.dirname, file), join(root, 'build/desktop', file));
		}
		await symlink(resolve(import.meta.dirname, '../../node_modules'), join(desktop, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
		await writeFile(join(root, 'package.json'), '{"type":"module"}');
		await writeFile(join(desktop, 'src/main.ts'), 'export const version = 1;');
		await writeFile(join(desktop, preloadSource), 'declare function require(name: string): unknown; export const electron = require("electron");');
		for (const [project, source] of [['main', 'src/main.ts'], ['preload', preloadSource]]) {
			await writeFile(join(desktop, `tsconfig.${project}.json`), JSON.stringify({
				compilerOptions: {
					module: 'NodeNext', target: 'ES2022', types: [], rootDir: '.', incremental: true,
					outDir: `.build/desktop/${project}`, tsBuildInfoFile: `.build/desktop/${project}.tsbuildinfo`,
				},
				include: [source],
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

		if (mode === 'watch') {
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
		}
	});
}
