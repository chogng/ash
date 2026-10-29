import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { compileExtensionWebviews } from './extensionWebviews.ts';

test('Rust extension views bundle static assets and track imported source dependencies', async () => {
	const root = await realpath(await mkdtemp(resolve(tmpdir(), 'ash-extension-view-')));
	try {
		await mkdir(resolve(root, 'src'));
		await writeFile(resolve(root, 'src/view.js'), 'import { message } from "./shared.js"; import "./view.css"; document.body.textContent = message;');
		await writeFile(resolve(root, 'src/shared.js'), 'export const message = "Markdown view";');
		await writeFile(resolve(root, 'src/view.css'), 'body { color: red; }');
		const result = await compileExtensionWebviews(root, [{ entry: 'src/view.js', script: 'media/view.js', style: 'media/view.css' }]);
		assert.match(result.resources['media/view.js'], /Markdown view/);
		assert.match(result.resources['media/view.css'], /color:red/);
		assert.ok(result.files.includes(resolve(root, 'src/shared.js')));
		assert.ok(result.files.includes(resolve(root, 'src/view.css')));
	} finally { await rm(root, { recursive: true, force: true }); }
});

test('extension view declarations reject resources outside the package and output collisions', async () => {
	for (const entry of ['../other.js', '/other.js', 'file:///other.js', 'src\\view.js']) {
		await assert.rejects(compileExtensionWebviews('.', [{ entry, script: 'media/view.js', style: 'media/view.css' }]), /resource path/);
	}
	await assert.rejects(compileExtensionWebviews('.', [{ entry: 'src/view.js', script: 'media/view.js', style: 'media/view.js' }]), /Duplicate/);
});
