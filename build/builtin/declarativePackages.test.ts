import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { buildDeclarativePackage } from './declarativePackages.ts';
import { readExtensionUiTargets } from './extensionManifest.ts';

for (const [name, kind] of [
	['keymap-sublime', 'editor'],
	['remote-workspace', 'language'],
]) {
	test(`${name} produces a code-free registry submission and preserves localized contributions`, async () => {
		const directory = await mkdtemp(resolve(tmpdir(), 'ash-declarative-'));
		try {
			const output = resolve(directory, 'submission');
			await assert.rejects(buildDeclarativePackage(directory, output), /outside its source directory/);
			await buildDeclarativePackage(resolve(import.meta.dirname, '../../extensions', name!), output);
			const catalog = JSON.parse(await readFile(resolve(output, 'catalog.json'), 'utf8'));
			assert.equal(catalog.packageType, kind);
			assert.deepEqual(catalog.uiTargets, ['ide']);
			assert.equal(catalog.id, `ash/${name}`);
			assert.deepEqual(catalog.capabilities, [{ kind: 'asset', id: `${kind}-resources`, path: kind }]);
			const manifest = JSON.parse(await readFile(resolve(output, 'package', kind!, 'package.json'), 'utf8'));
			assert.equal(manifest.ashDistribution, 'marketplace');
			assert.ok(manifest.contributes);
			assert.ok(!manifest.main && !manifest.browser && !manifest.ashRuntime);
			assert.ok(
				JSON.parse(await readFile(resolve(output, 'package', kind!, 'package.nls.zh-CN.json'), 'utf8'))
					.displayName,
			);
			await assert.rejects(
				buildDeclarativePackage(resolve(import.meta.dirname, '../../extensions', name!), output),
				/Refusing to replace/,
			);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
}

test('A declarative submission rejects executable entry points', async () => {
	const directory = await mkdtemp(resolve(tmpdir(), 'ash-declarative-'));
	try {
		await mkdir(resolve(directory, 'source'));
		await writeFile(
			resolve(directory, 'source/package.json'),
			JSON.stringify({
				name: 'unsafe',
				publisher: 'ash',
				version: '1.0.0',
				contributes: {},
				browser: './main.js',
			}),
		);
		await assert.rejects(
			buildDeclarativePackage(resolve(directory, 'source'), resolve(directory, 'output')),
			/without runtime code/,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('UI target declarations are preserved rather than inferred from technical package types', () => {
	assert.equal(readExtensionUiTargets(undefined), undefined);
	for (const targets of [['ide'], ['agents'], ['ide', 'agents']]) {
		assert.deepEqual(readExtensionUiTargets(targets), targets);
	}
	for (const invalid of [null, [], ['ide', 'ide'], ['web'], ['ide', 'agents', 'ide'], 'agents']) {
		assert.throws(() => readExtensionUiTargets(invalid), /ashUiTargets/u);
	}
});
