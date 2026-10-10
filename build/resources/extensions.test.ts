import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

test('browser packaging excludes Rust-only extensions and rejects missing JS manifests', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'ash-browser-extensions-'));
	try {
		await mkdir(join(directory, 'build/resources'), { recursive: true });
		await copyFile(resolve(import.meta.dirname, 'extensions.ts'), join(directory, 'build/resources/extensions.ts'));
		await symlink(resolve(import.meta.dirname, '../../node_modules'), join(directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
		await mkdir(join(directory, 'extensions/theme-defaults/themes'), { recursive: true });
		await writeFile(join(directory, 'extensions/theme-defaults/package.json'), JSON.stringify({ publisher: 'test', name: 'theme-defaults', version: '1.0.0' }));
		await mkdir(join(directory, 'extensions/capability'));
		await writeFile(join(directory, 'extensions/capability/Cargo.toml'), '[package]\nname = "capability"\nversion = "1.0.0"\n');
		const run = () => spawnSync(process.execPath, ['build/resources/extensions.ts'], {
			cwd: directory, encoding: 'utf8', timeout: 15_000,
			// This fixture owns its catalog, including any externally configured roots.
			env: { ...process.env, ASH_WEB_EXTENSION_PATHS: '' },
		});
		const packaged = run();
		assert.ifError(packaged.error);
		assert.equal(packaged.status, 0, packaged.stderr);
		const bundle = JSON.parse(await readFile(join(directory, 'src/ash/platform/extensions/common/generated/browser.json'), 'utf8'));
		assert.deepEqual(bundle.catalog.extensions.map((extension: { id: string; }) => extension.id), ['test.theme-defaults']);
		await mkdir(join(directory, 'extensions/broken-js'));
		const broken = run();
		assert.ifError(broken.error);
		assert.notEqual(broken.status, 0);
		assert.match(broken.stderr, /broken-js[/\\]package\.json/u);
	} finally {
		assert.equal(dirname(directory), tmpdir());
		await rm(directory, { recursive: true, force: true });
	}
});
