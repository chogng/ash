import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { build } from 'vite';
import { webUpdatePlugin } from './webUpdatePlugin.ts';

test('Web deployments stamp the same content identity into both entry pages and their relative manifest', async t => {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'ash-web-update-')));
	t.after(() => rm(root, { recursive: true, force: true }));
	const entries = ['browser/workbench/workbench.html', 'browser/sessions/sessions.html'];
	for (const entry of entries) {
		await mkdir(join(root, entry, '..'), { recursive: true });
		await writeFile(
			join(root, entry),
			'<!doctype html><html><head><title>Ash</title></head><body><script type="module" src="/main.js"></script></body></html>',
		);
	}
	await writeFile(join(root, 'main.js'), 'import "./style.css";globalThis.ashFixture="first";');
	await writeFile(join(root, 'style.css'), 'body{color:black}');
	const compile = async (): Promise<string> => {
		const result = await build({
			configFile: false,
			root,
			base: './',
			logLevel: 'silent',
			plugins: [webUpdatePlugin()],
			build: { write: false, rolldownOptions: { input: entries.map(entry => join(root, entry)) } },
		});
		assert.ok(!Array.isArray(result) && 'output' in result);
		const manifest = result.output.find(output => output.fileName === 'web-version.json');
		assert.ok(manifest?.type === 'asset');
		const { version } = JSON.parse(String(manifest.source));
		assert.match(version, /^[a-f0-9]{64}$/u);
		for (const entry of entries) {
			const html = result.output.find(output => output.fileName === entry);
			assert.ok(html?.type === 'asset');
			const stamp = /<meta name="ash-web-build" content="([a-f0-9]+)" data-version-url="([^"]+)"/u.exec(
				String(html.source),
			);
			assert.equal(stamp?.[1], version);
			assert.equal(
				new URL(stamp![2], `https://ash.example/prefix/${entry}`).href,
				'https://ash.example/prefix/web-version.json',
			);
		}
		return version;
	};
	const initial = await compile();
	assert.equal(await compile(), initial, 'Identical frontend artifacts must not announce an update');
	await writeFile(join(root, 'main.js'), 'import "./style.css";globalThis.ashFixture="next";');
	const changedCode = await compile();
	assert.notEqual(changedCode, initial);
	await writeFile(join(root, 'style.css'), 'body{color:white}');
	assert.notEqual(await compile(), changedCode);
});
