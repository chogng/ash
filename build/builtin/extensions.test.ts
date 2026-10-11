import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

test('browser packaging excludes Rust-only extensions and rejects missing JS manifests', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'ash-browser-extensions-'));
	try {
		await mkdir(join(directory, 'build/builtin'), { recursive: true });
		await copyFile(resolve(import.meta.dirname, 'extensions.ts'), join(directory, 'build/builtin/extensions.ts'));
		await symlink(resolve(import.meta.dirname, '../../node_modules'), join(directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
		await mkdir(join(directory, 'extensions/theme-defaults/themes'), { recursive: true });
		await writeFile(join(directory, 'extensions/theme-defaults/package.json'), JSON.stringify({ publisher: 'test', name: 'theme-defaults', version: '1.0.0' }));
		await mkdir(join(directory, 'extensions/capability'));
		await writeFile(join(directory, 'extensions/capability/Cargo.toml'), '[package]\nname = "capability"\nversion = "1.0.0"\n');
		await mkdir(join(directory, 'extensions/git/src'), { recursive: true });
		await writeFile(join(directory, 'extensions/git/package.json'), JSON.stringify({ publisher: 'test', name: 'git', version: '1.0.0', ashRuntime: { kind: 'rust', entrypoint: 'ash-git-extension' } }));
		await writeFile(join(directory, 'extensions/git/src/main.rs'), 'fn main() {}');
		await writeFile(join(directory, 'extensions/git/Cargo.toml'), '[package]');
		await writeFile(join(directory, 'extensions/git/package.nls.zh-CN.json'), JSON.stringify({ displayName: 'Git 支持' }));
		await mkdir(join(directory, 'extensions/language-pack/translations'), { recursive: true });
		const catalog = { schemaVersion: 1, locale: 'zh-CN', catalogVersion: 'ash-1', bundles: { ash: { hello: '你好' } } };
		await writeFile(join(directory, 'extensions/language-pack/package.json'), JSON.stringify({ publisher: 'test', name: 'language-pack', version: '1.0.0', engines: { ash: '*' }, contributes: { localizations: [{ languageId: 'zh-CN', translations: [{ id: 'ash', path: 'localization/package.json' }] }] } }));
		await mkdir(join(directory, '.build/desktop/localization/extensions/test.language-pack/localization'), { recursive: true });
		await writeFile(join(directory, '.build/desktop/localization/extensions/test.language-pack/localization/package.json'), JSON.stringify(catalog));
		const run = () => spawnSync(process.execPath, ['build/builtin/extensions.ts'], {
			cwd: directory, encoding: 'utf8', timeout: 15_000,
			// This fixture owns its catalog, including any externally configured roots.
			env: { ...process.env, ASH_WEB_EXTENSION_PATHS: '' },
		});
		const packaged = run();
		assert.ifError(packaged.error);
		assert.equal(packaged.status, 0, packaged.stderr);
		const bundle = JSON.parse(await readFile(join(directory, 'src/ash/platform/extensions/common/generated/browser.json'), 'utf8'));
		assert.deepEqual(bundle.catalog.extensions.map((extension: { id: string; }) => extension.id), ['test.git', 'test.language-pack', 'test.theme-defaults']);
		assert.deepEqual(Object.keys(bundle.resources['test.git']).sort(), ['package.json', 'package.nls.zh-CN.json']);
		assert.equal(bundle.catalog.extensions.find((extension: { id: string; }) => extension.id === 'test.language-pack').sourceKind, 'builtIn');
		assert.deepEqual(JSON.parse(Buffer.from(bundle.resources['test.language-pack']['localization/package.json'], 'base64').toString('utf8')), catalog);
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

test('combined Rust and browser packages publish the bundled frontend without its TypeScript sources', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'ash-combined-extension-'));
	try {
		await mkdir(join(directory, 'build/builtin'), { recursive: true });
		await copyFile(resolve(import.meta.dirname, 'extensions.ts'), join(directory, 'build/builtin/extensions.ts'));
		await symlink(resolve(import.meta.dirname, '../node_modules'), join(directory, 'build/node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
		for (const name of ['node_modules', 'crates']) {
			await symlink(resolve(import.meta.dirname, '../../' + name), join(directory, name), process.platform === 'win32' ? 'junction' : 'dir');
		}
		await mkdir(join(directory, 'extensions/theme-defaults/themes'), { recursive: true });
		await writeFile(join(directory, 'extensions/theme-defaults/package.json'), JSON.stringify({ publisher: 'test', name: 'theme-defaults', version: '1.0.0' }));
		await mkdir(join(directory, 'extensions/git/browser'), { recursive: true });
		await mkdir(join(directory, 'extensions/git/src'));
		await writeFile(join(directory, 'extensions/git/package.json'), JSON.stringify({ publisher: 'test', name: 'git', version: '1.0.0', browser: 'browser/main.ts', ashRuntime: { kind: 'rust', entrypoint: 'ash-git-extension' } }));
		await writeFile(join(directory, 'extensions/git/browser/main.ts'), "import { marker } from './helper.js'; export async function activate(): Promise<string> { return marker; }");
		await writeFile(join(directory, 'extensions/git/browser/helper.ts'), "export const marker: string = 'combined-entry-marker';");
		await writeFile(join(directory, 'extensions/git/src/main.rs'), 'fn main() {}');
		await writeFile(join(directory, 'extensions/git/Cargo.toml'), '[package]');
		const result = spawnSync(process.execPath, ['build/builtin/extensions.ts'], { cwd: directory, encoding: 'utf8', timeout: 30_000, env: { ...process.env, ASH_WEB_EXTENSION_PATHS: '' } });
		assert.ifError(result.error);
		assert.equal(result.status, 0, result.stderr);
		const bundle = JSON.parse(await readFile(join(directory, 'src/ash/platform/extensions/common/generated/browser.json'), 'utf8'));
		assert.deepEqual(Object.keys(bundle.resources['test.git']).sort(), ['browser/main.ts', 'package.json']);
		const module = Buffer.from(bundle.resources['test.git']['browser/main.ts'], 'base64').toString('utf8');
		assert.match(module, /combined-entry-marker/);
		assert.doesNotMatch(module, /from ['"]\.\/helper\.js['"]|Promise<string>/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

for (const resource of ['manifest', 'file'] as const) {
	test(`browser packaging rejects an oversized ${resource} before publishing its snapshot`, async () => {
		const directory = await mkdtemp(join(tmpdir(), 'ash-extension-budget-'));
		try {
			await writeFile(join(directory, 'package.json'), JSON.stringify({ publisher: 'test', name: 'budget', version: '1.0.0' }));
			const path = join(directory, resource === 'manifest' ? 'package.json' : 'large.bin');
			const file = await open(path, 'w');
			try { await file.truncate((resource === 'manifest' ? 4 : 16) * 1024 * 1024 + 1); }
			finally { await file.close(); }
			const result = spawnSync(process.execPath, ['build/builtin/extensions.ts'], {
				cwd: resolve(import.meta.dirname, '../..'),
				env: { ...process.env, ASH_WEB_EXTENSION_PATHS: directory },
				encoding: 'utf8', timeout: 30_000,
			});
			assert.equal(result.status, 1);
			assert.match(result.stderr, resource === 'manifest' ? /manifest exceeds its byte limit/ : /exceeds its resource budget/);
		} finally { await rm(directory, { recursive: true, force: true }); }
	});
}
