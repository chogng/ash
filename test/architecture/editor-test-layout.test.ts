import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'mocha';
import { findDesktopRoot } from './testPaths.js';

const desktopRoot = findDesktopRoot(import.meta.dirname);

test('browser integration entrypoints narrow file filters within their suite', () => {
	function list(editorOnly: boolean, file: string) {
		const result = spawnSync(process.execPath, [
			'test/integration/browser/run.ts',
			...(editorOnly ? ['--editor'] : []),
			file, '--project=chromium', '--list',
		], { cwd: desktopRoot, encoding: 'utf8', timeout: 30_000, windowsHide: true });
		if (result.error) throw result.error;
		return { status: result.status, output: result.stdout + result.stderr };
	}
	const editor = list(true, 'textModel.integration.spec.ts');
	assert.equal(editor.status, 0, editor.output);
	assert.match(editor.output, /textModel\.integration\.spec\.ts/u);
	assert.match(editor.output, /Total: \d+ tests in 1 file/u);
	assert.doesNotMatch(editor.output, /(?:academy|themes|tokenization)\.integration\.spec\.ts/u);
	const outsideEditor = list(true, 'webview.integration.spec.ts');
	assert.equal(outsideEditor.status, 1, outsideEditor.output);
	assert.match(outsideEditor.output, /No tests found/u);
	for (const file of ['academy.integration.spec.ts', 'pdfExtension.integration.spec.ts', 'referenceManager.integration.spec.ts']) {
		const extension = list(true, file);
		assert.equal(extension.status, 1, extension.output);
		assert.match(extension.output, /No tests found/u);
		const integration = list(false, file);
		assert.equal(integration.status, 0, integration.output);
		assert.match(integration.output, /Total: \d+ tests in 1 file/u);
	}
	const allBrowser = list(false, 'webview.integration.spec.ts');
	assert.equal(allBrowser.status, 0, allBrowser.output);
	assert.match(allBrowser.output, /webview\.integration\.spec\.ts/u);
	assert.match(allBrowser.output, /Total: \d+ tests in 1 file/u);
});
