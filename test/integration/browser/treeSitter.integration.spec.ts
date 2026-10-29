import { test } from '../../fixtures/browser/rustSyntaxProcessFixture.js';
import structures from '../../fixtures/tree-sitter/structure.json' with { type: 'json' };
import samples from '../../fixtures/tree-sitter/languages.json' with { type: 'json' };
import { expect } from '@playwright/test';

test('Python Rust backend paints syntax and preserves editing and undo', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/treeSitter.html');
	await expect.poll(() => page.evaluate(() => window.treeSitterIntegration?.state().execution)).toBe('rust');
	expect(page.workers().some(worker => /treeSitter/u.test(worker.url()))).toBe(false);
	await expect(page.locator('.stanza-editor-token.token-keyword').filter({ hasText: /^def$/ })).toBeVisible();
	await expect
		.poll(() => page.evaluate(() => window.treeSitterIntegration.state()))
		.toMatchObject({
			tokens: expect.arrayContaining([
				expect.objectContaining({ type: 'string', text: expect.stringContaining('你好🙂') }),
			]),
		});
	await page.evaluate(() => window.treeSitterIntegration.edit());
	await expect
		.poll(() =>
			page.evaluate(() =>
				window.treeSitterIntegration
					.state()
					.tokens.some(token => token.type === 'string' && token.text.includes('updated ')),
			),
		)
		.toBe(true);
	await page.evaluate(() => window.treeSitterIntegration.undo());
	await expect
		.poll(() => page.evaluate(() => window.treeSitterIntegration.state().text))
		.toBe('def greet(name):\n    return "你好🙂"\n');
	expect(await page.evaluate(() => window.treeSitterIntegration.state().errors)).toEqual([]);
	expect(errors).toEqual([]);
	await page.evaluate(() => window.treeSitterIntegration.dispose());
});

test('Disconnected Web keeps local WASM highlighting, editing and undo', async ({ page }) => {
	await page.goto('/treeSitter.html?backend=offline');
	await expect.poll(() => page.evaluate(() => window.treeSitterIntegration?.state().execution)).toBe('worker');
	await page.evaluate(() => window.treeSitterIntegration.ready());
	await expect(page.locator('.stanza-editor-token.token-keyword').filter({ hasText: /^def$/ })).toBeVisible();
	await page.evaluate(() => window.treeSitterIntegration.edit());
	await page.evaluate(() => window.treeSitterIntegration.ready());
	expect(
		await page.evaluate(() =>
			window.treeSitterIntegration
				.state()
				.tokens.some(token => token.type === 'string' && token.text.includes('updated ')),
		),
	).toBe(true);
	await page.evaluate(() => window.treeSitterIntegration.undo());
	expect(await page.evaluate(() => window.treeSitterIntegration.state().text)).toBe(
		'def greet(name):\n    return "你好🙂"\n',
	);
	expect(await page.evaluate(() => window.treeSitterIntegration.state().errors)).toEqual([]);
});

test('Rust disconnect falls back locally and reconnects with the live dirty buffer and undo history', async ({
	page,
}) => {
	await page.goto('/treeSitter.html');
	await expect.poll(() => page.evaluate(() => window.treeSitterIntegration?.state().execution)).toBe('rust');
	await page.evaluate(() => window.treeSitterIntegration.ready());
	await page.evaluate(() => window.treeSitterIntegration.edit());
	const firstDirty = await page.evaluate(() => window.treeSitterIntegration.state().text);
	await page.evaluate(() => window.treeSitterIntegration.disconnectBackend());
	await expect.poll(() => page.evaluate(() => window.treeSitterIntegration.state().execution)).toBe('worker');
	await page.evaluate(() => window.treeSitterIntegration.edit());
	await page.evaluate(() => window.treeSitterIntegration.ready());
	const offline = await page.evaluate(() => window.treeSitterIntegration.state());
	expect(offline.text).not.toBe(firstDirty);
	expect(offline.tokens.some(token => token.type === 'string' && token.text.includes('updated updated '))).toBe(true);
	await page.evaluate(() => window.treeSitterIntegration.reconnectBackend());
	await expect.poll(() => page.evaluate(() => window.treeSitterIntegration.state().execution)).toBe('rust');
	await page.evaluate(() => window.treeSitterIntegration.ready());
	expect(await page.evaluate(() => window.treeSitterIntegration.state())).toMatchObject({
		text: offline.text,
		version: offline.version,
		errors: [],
	});
	await page.evaluate(() => window.treeSitterIntegration.undo());
	expect(await page.evaluate(() => window.treeSitterIntegration.state().text)).toBe(firstDirty);
});

test('100000 lines retain local editing and dirty text through Rust and WASM transitions', async ({ page }) => {
	await page.goto('/treeSitter.html');
	await expect.poll(() => page.evaluate(() => window.treeSitterIntegration?.state().execution)).toBe('rust');
	await page.evaluate(() => {
		const lines: string[] = [];
		for (let index = 0; index < 25000; index++)
			lines.push(`function item${index}() {`, '  return "value";', '}', '');
		window.treeSitterIntegration.open('javascript', lines.join('\n'));
	});
	await page.evaluate(() => window.treeSitterIntegration.ready());
	expect(await page.evaluate(() => window.treeSitterIntegration.state().lines)).toBe(100000);
	await page.evaluate(() => window.treeSitterIntegration.disconnectBackend());
	await expect.poll(() => page.evaluate(() => window.treeSitterIntegration.state().execution)).toBe('worker');
	await page.evaluate(() => window.treeSitterIntegration.edit());
	await page.evaluate(() => window.treeSitterIntegration.ready());
	expect(
		await page.evaluate(() =>
			window.treeSitterIntegration
				.state()
				.tokens.some(token => token.type === 'string' && token.text.includes('updated ')),
		),
	).toBe(true);
	const version = await page.evaluate(() => window.treeSitterIntegration.state().version);
	await page.evaluate(() => window.treeSitterIntegration.reconnectBackend());
	await expect.poll(() => page.evaluate(() => window.treeSitterIntegration.state().execution)).toBe('rust');
	await page.evaluate(() => window.treeSitterIntegration.ready());
	expect(await page.evaluate(() => window.treeSitterIntegration.state().version)).toBe(version);
	expect(
		await page.evaluate(() =>
			window.treeSitterIntegration
				.state()
				.tokens.some(token => token.type === 'string' && token.text.includes('updated ')),
		),
	).toBe(true);
	await page.evaluate(() => window.treeSitterIntegration.undo());
	await page.evaluate(() => window.treeSitterIntegration.ready());
	expect(
		await page.evaluate(() =>
			window.treeSitterIntegration.state().text.startsWith('function item0() {\n  return "value";\n}'),
		),
	).toBe(true);
	expect(await page.evaluate(() => window.treeSitterIntegration.state().errors)).toEqual([]);
});

for (const sample of samples) {
	test(`${sample.language} Rust grammar paints ${sample.lexeme}`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/treeSitter.html');
		await expect.poll(() => page.evaluate(() => !!window.treeSitterIntegration)).toBe(true);
		await page.evaluate(sample => window.treeSitterIntegration.open(sample.language, sample.text), sample);
		await expect
			.poll(() => page.evaluate(() => window.treeSitterIntegration.state()))
			.toMatchObject({
				shared: true,
				execution: 'rust',
				errors: [],
				tokens: expect.arrayContaining([
					expect.objectContaining({ type: sample.tokenType, text: expect.stringContaining(sample.lexeme) }),
				]),
			});
		expect(errors).toEqual([]);
		await page.evaluate(() => window.treeSitterIntegration.dispose());
	});
}

test('new project languages retain highlights through offline edits and undo', async ({ page }) => {
	await page.goto('/treeSitter.html?backend=offline');
	await expect.poll(() => page.evaluate(() => window.treeSitterIntegration?.state().execution)).toBe('worker');
	const languages = new Set([
		'c',
		'cpp',
		'java',
		'csharp',
		'powershell',
		'bat',
		'dockerfile',
		'makefile',
		'dotenv',
		'dockercompose',
		'lua',
		'ruby',
		'php',
		'swift',
		'dart',
		'jsonl',
		'snippets',
		'log',
		'r',
		'julia',
		'clojure',
		'groovy',
		'coffeescript',
		'perl',
	]);
	for (const sample of samples.filter(sample => languages.has(sample.language))) {
		await page.evaluate(sample => window.treeSitterIntegration.open(sample.language, sample.text), sample);
		await page.evaluate(() => window.treeSitterIntegration.ready());
		const original = await page.evaluate(() => window.treeSitterIntegration.state().text);
		const expected = expect.objectContaining({
			type: sample.tokenType,
			text: expect.stringContaining(sample.lexeme),
		});
		expect(await page.evaluate(() => window.treeSitterIntegration.state())).toMatchObject({
			execution: 'worker',
			errors: [],
			tokens: expect.arrayContaining([expected]),
		});
		// An inserted newline changes every row coordinate without changing the language's syntax.
		await page.locator('.stanza-editor').click();
		await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home');
		await page.keyboard.press('Enter');
		await page.evaluate(() => window.treeSitterIntegration.ready());
		expect(await page.evaluate(() => window.treeSitterIntegration.state().text.replace(/\r\n/g, '\n'))).toBe(
			'\n' + original.replace(/\r\n/g, '\n'),
		);
		await page.evaluate(() => window.treeSitterIntegration.undo());
		await page.evaluate(() => window.treeSitterIntegration.ready());
		expect(await page.evaluate(() => window.treeSitterIntegration.state())).toMatchObject({
			text: original,
			errors: [],
			tokens: expect.arrayContaining([expected]),
		});
	}
});

for (const sample of [
	{
		language: 'html',
		text: '<script>const value = "你好🙂";</script>\n<style>body { color: red; }</style>',
		lexeme: 'const',
		tokenType: 'keyword',
	},
	{
		language: 'html',
		text: '<script type="application/json">{"value": 42}</script>',
		lexeme: '42',
		tokenType: 'number',
	},
	{ language: 'html', text: '<style>body { color: red; }</style>', lexeme: 'color', tokenType: 'property' },
	{ language: 'php', text: '<?php echo "你好🙂"; ?><h1>Hello</h1>', lexeme: 'h1', tokenType: 'tag' },
	{
		language: 'markdown',
		text: '# Title\n\n```python\ndef greet():\n    return "你好🙂"\n```\n',
		lexeme: 'def',
		tokenType: 'keyword',
	},
	{ language: 'markdown', text: 'Some **strong text**.\n', lexeme: 'strong text', tokenType: 'text' },
	{
		language: 'diff',
		text: 'diff --git a/main.js b/main.js\n--- a/main.js\n+++ b/main.js\n@@ -1 +1 @@\n-const old = 1;\n+const value = 2;\n',
		lexeme: 'const',
		tokenType: 'keyword',
	},
]) {
	test(`${sample.language} highlights embedded ${sample.lexeme} with original coordinates`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/treeSitter.html');
		await expect.poll(() => page.evaluate(() => !!window.treeSitterIntegration)).toBe(true);
		await page.evaluate(sample => window.treeSitterIntegration.open(sample.language, sample.text), sample);
		await expect
			.poll(() => page.evaluate(() => window.treeSitterIntegration.state()))
			.toMatchObject({
				shared: true,
				execution: 'rust',
				errors: [],
				tokens: expect.arrayContaining([
					expect.objectContaining({ type: sample.tokenType, text: expect.stringContaining(sample.lexeme) }),
				]),
			});
		expect(errors).toEqual([]);
		await page.evaluate(() => window.treeSitterIntegration.dispose());
	});
}

for (const backend of ['rust', 'offline'])
	for (const locale of ['en', 'zh-CN']) {
		test(`Token inspection reports live embedded captures and restores focus in ${locale} (${backend})`, async ({
			page,
		}) => {
			const errors: string[] = [];
			page.on('pageerror', error => errors.push(error.message));
			await page.goto(`/treeSitter.html?locale=${locale}&backend=${backend}`);
			await expect.poll(() => page.evaluate(() => !!window.treeSitterIntegration)).toBe(true);
			await page.evaluate(() => {
				const source = '<script>const label = "你好🙂";</script>';
				window.treeSitterIntegration.open('html', source);
				window.treeSitterIntegration.inspect(1, source.indexOf('你好') + 1);
			});
			const report = page.locator('textarea.ash-inspect-editor-tokens-content');
			await expect
				.poll(() =>
					page.evaluate(() =>
						window.treeSitterIntegration.state().errors.length
							? window.treeSitterIntegration.state().errors
							: document.querySelector('textarea.ash-inspect-editor-tokens-content')
								? 'ready'
								: 'waiting',
					),
				)
				.toBe('ready');
			await expect(report).toBeVisible();
			const value = await report.inputValue();
			expect(value).toContain(locale === 'en' ? 'Embedded language: javascript' : '内嵌语言：javascript');
			expect(value).toContain(locale === 'en' ? 'Tree-sitter captures:' : 'Tree-sitter 捕获：');
			expect(value).toContain('string');
			expect(value).toContain('你好🙂');
			expect(value).toContain(backend === 'rust' ? 'Tree-sitter / Rust' : 'Tree-sitter / WASM');
			expect(value).not.toContain('No TextMate grammar');
			await expect(report).toBeFocused();
			await page.keyboard.press('Tab');
			await expect(
				page.getByRole('button', { name: locale === 'en' ? 'Close' : '关闭', exact: true }),
			).toBeFocused();
			await page.keyboard.press('Shift+Tab');
			await expect(report).toBeFocused();
			expect(await page.evaluate(() => window.treeSitterIntegration.showInspectionHelp())).toBe(true);
			await expect(page.getByRole('dialog').last().getByRole('textbox')).toHaveValue(/Tree-sitter/);
			await page.keyboard.press('Escape');
			await expect(report).toBeFocused();
			await page.keyboard.press('Escape');
			await expect(report).toHaveCount(0);
			await expect.poll(() => page.evaluate(() => window.treeSitterIntegration.focused())).toBe(true);
			expect(await page.evaluate(() => window.treeSitterIntegration.state().errors)).toEqual([]);
			expect(errors).toEqual([]);
			await page.evaluate(() => window.treeSitterIntegration.dispose());
		});
	}

test('Token inspection discards a pending report when its editor model is replaced', async ({ page }) => {
	await page.goto('/treeSitter.html');
	await expect.poll(() => page.evaluate(() => !!window.treeSitterIntegration)).toBe(true);
	await page.evaluate(async () => {
		window.treeSitterIntegration.open('html', '<script>const value = "old";</script>');
		window.treeSitterIntegration.inspect(1, 24);
		window.treeSitterIntegration.open('python', 'print("new")');
		await window.treeSitterIntegration.waitForInspection();
	});
	await expect(page.locator('textarea.ash-inspect-editor-tokens-content')).toHaveCount(0);
	expect(await page.evaluate(() => window.treeSitterIntegration.state().errors)).toEqual([]);
	await page.evaluate(() => window.treeSitterIntegration.dispose());
});

test('Token inspection drops a retired Rust session when the connection changes', async ({ page }) => {
	await page.goto('/treeSitter.html');
	await expect.poll(() => page.evaluate(() => window.treeSitterIntegration?.state().execution)).toBe('rust');
	await page.evaluate(async () => {
		window.treeSitterIntegration.open('html', '<script>const label = "old";</script>');
		window.treeSitterIntegration.inspect(1, 24);
		await window.treeSitterIntegration.disconnectBackend();
		await window.treeSitterIntegration.waitForInspection();
	});
	await expect(page.locator('textarea.ash-inspect-editor-tokens-content')).toHaveCount(0);
	expect(await page.evaluate(() => window.treeSitterIntegration.state().errors)).toEqual([]);
	await expect.poll(() => page.evaluate(() => window.treeSitterIntegration.state().execution)).toBe('worker');
	expect(await page.evaluate(() => window.treeSitterIntegration.focused())).toBe(true);
});

for (const [index, fixture] of structures.entries()) {
	test(`${fixture.language} Rust structure fixture ${index}: package folds and outline`, async ({ page }) => {
		await page.goto('/treeSitter.html');
		await expect.poll(() => page.evaluate(() => !!window.treeSitterIntegration)).toBe(true);
		await page.evaluate(fixture => window.treeSitterIntegration.open(fixture.language, fixture.text), fixture);
		const facts = await page.evaluate(() => window.treeSitterIntegration.facts());
		for (const name of fixture.symbols) expect(facts.symbols.map(symbol => symbol.name)).toContain(name);
		for (const [start, end] of fixture.folds)
			expect(facts.folds).toEqual(
				expect.arrayContaining([expect.objectContaining({ startLineIndex: start, endLineIndex: end })]),
			);
		if ('exactSymbols' in fixture && fixture.exactSymbols)
			expect(facts.symbols.map(symbol => symbol.name)).toEqual(fixture.symbols);
		if ('noFolds' in fixture && fixture.noFolds) expect(facts.folds).toEqual([]);
		expect(await page.evaluate(() => window.treeSitterIntegration.state().errors)).toEqual([]);
		await page.evaluate(() => window.treeSitterIntegration.dispose());
	});
}
