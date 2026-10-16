import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { compileExtensionWebviews } from '../builtin/extensionWebviews.ts';

test('Markdown views package formula styles and fonts without a JavaScript formula engine', async () => {
	const root = resolve(import.meta.dirname, '../../extensions/markdown-language-features');
	const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
	const views = await compileExtensionWebviews(root, manifest.ashRuntime.webviews);
	for (const view of manifest.ashRuntime.webviews) {
		assert.match(views.resources[view.style], /@font-face/u);
		assert.match(views.resources[view.style], /KaTeX_Main/u);
		assert.doesNotMatch(views.resources[view.script], /KaTeX parse error|Too many expansions/u);
	}
});
