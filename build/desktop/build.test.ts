import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

test('Desktop build stops at the failed host or renderer step before bundling', async t => {
	const root = await mkdtemp(join(tmpdir(), 'ash-build-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	for (const directory of ['build/resources', 'build/desktop', 'build/lib', 'build/node_modules/vite/bin', 'node_modules/typescript/bin']) {
		await mkdir(join(root, directory), { recursive: true });
	}
	for (const file of ['build/desktop/build.ts', 'build/desktop/host.ts', 'build/desktop/paths.ts']) {
		await copyFile(resolve(import.meta.dirname, '../..', file), join(root, file));
	}
	await writeFile(join(root, 'build/resources/localization.ts'), `import { appendFile } from 'node:fs/promises'; export async function generateLocalization() { await appendFile(new URL('../../operations.log', import.meta.url), 'localization\\n'); }`);
	await writeFile(join(root, 'package.json'), '{"type":"module"}');
	await writeFile(join(root, 'node_modules/typescript/bin/tsc'), `
    const fs = require('node:fs');
    const path = require('node:path');
    for (const project of process.argv.filter(value => value.startsWith('tsconfig.'))) {
      fs.appendFileSync('operations.log', project + '\\n');
      if (process.env.FAILURE === project) process.exit(1);
      if (project === 'tsconfig.preload.json') {
        const output = '.build/desktop/preload/src/ash/base/parts/sandbox/electron-browser/preload.cjs';
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.writeFileSync(output, process.env.FAILURE === 'preload-import' ? "require('fs')" : "require('electron')");
      }
    }
  `);
	await writeFile(join(root, 'build/node_modules/vite/bin/vite.js'), "require('node:fs').appendFileSync('operations.log', (process.argv.includes('web') ? 'bundle-web' : 'bundle') + '\\n');");
	for (const [failure, expected] of [
		['tsconfig.main.json', ['localization', 'tsconfig.main.json']],
		['preload-import', ['localization', 'tsconfig.main.json', 'tsconfig.preload.json']],
		['tsconfig.renderer.json', ['localization', 'tsconfig.main.json', 'tsconfig.preload.json', 'tsconfig.renderer.json']],
		['', ['localization', 'tsconfig.main.json', 'tsconfig.preload.json', 'tsconfig.renderer.json', 'bundle']],
	] as const) {
		await writeFile(join(root, 'operations.log'), '');
		const result = spawnSync(process.execPath, [join(root, 'build/desktop/build.ts'), 'all'], {
			cwd: tmpdir(), env: { ...process.env, FAILURE: failure }, encoding: 'utf8', windowsHide: true, timeout: 10_000,
		});
		assert.equal(result.error, undefined);
		assert.equal(result.status, failure ? 1 : 0, result.stdout + result.stderr);
		assert.deepEqual((await readFile(join(root, 'operations.log'), 'utf8')).trim().split('\n'), expected);
		assert.equal(JSON.parse(await readFile(join(root, '.build/desktop/package.json'), 'utf8')).type, 'module');
	}
	for (const [command, expected] of [
		['host', ['localization', 'tsconfig.main.json', 'tsconfig.preload.json']],
		['renderer', ['localization', 'tsconfig.renderer.json', 'bundle']],
		['web', ['localization', 'tsconfig.renderer.json', 'bundle-web']],
		['prepare', []],
	] as const) {
		await writeFile(join(root, 'operations.log'), '');
		const result = spawnSync(process.execPath, [join(root, 'build/desktop/build.ts'), command], {
			cwd: tmpdir(), encoding: 'utf8', windowsHide: true, timeout: 10_000,
		});
		assert.equal(result.status, 0, result.stdout + result.stderr);
		assert.deepEqual((await readFile(join(root, 'operations.log'), 'utf8')).trim().split('\n').filter(Boolean), expected);
	}
});
