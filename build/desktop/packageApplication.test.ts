import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import test from 'node:test';
import { ignoreApplicationFile } from './packageApplication.ts';

test('application copying retains hoisted and nested dependency resolution without the private pnpm store', async t => {
	const root = await mkdtemp(join(tmpdir(), 'ash-package-dependencies-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const source = join(root, 'source');
	const destination = join(root, 'application');
	const files: Record<string, string> = {
		'package.json': '{"name":"ash-fixture"}',
		'dist/main.js': 'runtime entrypoint',
		'resources/tray/icon.png': 'tray artwork',
		'licenses/dependency.txt': 'dependency attribution',
		'THIRD_PARTY_NOTICES.md': 'notices',
		'node_modules/runtime/index.js': 'module.exports = [require("shared"), require("nested")];',
		'node_modules/shared/index.js': 'module.exports = "hoisted dependency";',
		'node_modules/runtime/node_modules/nested/index.js': 'module.exports = "nested dependency";',
		'node_modules/.pnpm/runtime/index.js': 'throw new Error("private cache must not ship");',
		'node_modules/.modules.yaml': 'installation metadata',
		'node_modules/.pnpm-workspace-state-v1.json': '{}',
		'node_modules/.bin/tool': 'developer tool',
		'node_modules/electron/index.js': 'developer runtime package',
		'build/source.ts': 'build-only source',
	};
	for (const [path, content] of Object.entries(files)) {
		const file = join(source, path);
		await mkdir(join(file, '..'), { recursive: true });
		await writeFile(file, content);
	}
	await cp(source, destination, {
		recursive: true,
		dereference: true,
		filter: path => !ignoreApplicationFile(`/${relative(source, path).split(sep).join('/')}`),
	});
	const require = createRequire(join(destination, 'probe.cjs'));
	assert.equal(require.resolve('runtime'), await realpath(join(destination, 'node_modules/runtime/index.js')));
	assert.deepEqual(require('runtime'), ['hoisted dependency', 'nested dependency']);
	for (const path of ['package.json', 'dist/main.js', 'resources/tray/icon.png', 'licenses/dependency.txt', 'THIRD_PARTY_NOTICES.md']) {
		assert.equal(await readFile(join(destination, path), 'utf8'), files[path]);
	}
	for (const path of ['.pnpm', '.modules.yaml', '.pnpm-workspace-state-v1.json', '.bin', 'electron']) {
		await assert.rejects(readFile(join(destination, 'node_modules', path)), { code: 'ENOENT' });
	}
	await assert.rejects(readFile(join(destination, 'build/source.ts')), { code: 'ENOENT' });
});

for (const platform of ['darwin', 'win32', 'linux'] as const) {
	test(`${platform} application copying retains addon loaders and attribution without build inputs or duplicate binaries`, async t => {
		const root = await mkdtemp(join(tmpdir(), 'ash-packaged-addons-'));
		t.after(() => rm(root, { recursive: true, force: true }));
		const source = join(root, 'source');
		const destination = join(root, 'application');
		const files: Record<string, string> = { 'package.json': '{}' };
		for (const [name, binary] of [['native-keymap', 'keymapping.node'], ['native-is-elevated', 'iselevated.node']]) {
			for (const path of ['package.json', 'index.js', 'License.txt', 'ThirdPartyNotices.txt', 'src/keyboard.cc', 'deps/table.inc', 'binding.gyp', 'build/Makefile', 'build/Release/obj.target/source.o', `build/Release/${binary}`, `bin/platform/${binary}`, 'README.md']) {
				files[`node_modules/${name}/${path}`] = path;
			}
		}
		for (const [path, content] of Object.entries(files)) {
			await mkdir(join(source, path, '..'), { recursive: true });
			await writeFile(join(source, path), content);
		}
		await cp(source, destination, {
			recursive: true,
			filter: path => !ignoreApplicationFile(`/${relative(source, path).split(sep).join('/')}`, platform),
		});
		for (const [path, content] of Object.entries(files)) {
			const expected = path === 'package.json' || (!path.includes('native-is-elevated') || platform === 'win32')
				&& /\/(?:package\.json|index\.js|License\.txt|ThirdPartyNotices\.txt|build\/Release\/(?:keymapping|iselevated)\.node)$/u.test(path);
			if (expected) assert.equal(await readFile(join(destination, path), 'utf8'), content);
			else await assert.rejects(stat(join(destination, path)), { code: 'ENOENT' });
		}
	});
}
