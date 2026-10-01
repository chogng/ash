import { expect, test } from '@playwright/test';

const pageErrors = new WeakMap<object, string[]>();
test.beforeEach(async ({ page }) => {
	const errors: string[] = [];
	pageErrors.set(page, errors);
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/tokenization.html');
	await expect(page.locator('.stanza-editor')).toBeVisible();
});
test.afterEach(async ({ page }) => {
	await page.evaluate(() => window.tokenizationIntegration?.dispose());
	expect(pageErrors.get(page)).toEqual([]);
});

test('all eight parser languages use bundled TextMate grammars in the frontend Worker', async ({ page }) => {
	const samples = [
		['javascript', 'const value = "hello";', 'const', 'keyword'],
		['javascriptreact', 'const view = <div>hello</div>;', 'div', 'tag'],
		['typescript', 'const value: number = 42;', 'const', 'keyword'],
		['typescriptreact', 'const view = <div>hello</div>;', 'div', 'tag'],
		['json', '{"value": 42}', '42', 'number'],
		['jsonc', '// hello\n{"value": 42}', ' hello', 'comment'],
		['rust', 'fn main() {}', 'fn', 'keyword'],
		['shellscript', 'if true; then echo "hello"; fi', 'if', 'keyword'],
	] as const;
	for (const [languageId, text, lexeme, type] of samples) {
		await page.evaluate(({ languageId, text }) => window.tokenizationIntegration.open(languageId, text), { languageId, text });
		await expect.poll(() => page.evaluate(() => window.tokenizationIntegration.state().tokens), { message: languageId }).toContainEqual({ type, text: lexeme });
	}
	expect(await page.evaluate(() => window.tokenizationIntegration.languageState())).toEqual({ initial: ['plaintext'], shell: 'shellscript', resource: 'shellscript', comment: '#', grammar: true, model: 'shellscript' });
	const state = await page.evaluate(() => window.tokenizationIntegration.state());
	expect(state.analyzeCalls).toBeGreaterThan(0);
	expect(state.completedCalls).toBe(0);
	expect(state.errors).toEqual([]);
	expect(page.workers().some(worker => worker.url().includes('textMateSyntaxWorkerMain'))).toBe(true);
});

test('Bazel files select Starlark or bazelrc and tokenize through the bundled grammars', async ({ page }) => {
	const samples = [
		['BUILD', 'starlark', 'cc_library(name = "demo")', 'string', 'demo'],
		['BUILD.bazel', 'starlark', 'cc_library(name = "demo")', 'string', 'demo'],
		['WORKSPACE', 'starlark', 'workspace(name = "demo")', 'string', 'demo'],
		['WORKSPACE.bazel', 'starlark', 'workspace(name = "demo")', 'string', 'demo'],
		['WORKSPACE.bzlmod', 'starlark', 'workspace(name = "demo")', 'string', 'demo'],
		['MODULE.bazel', 'starlark', 'bazel_dep(name = "rules_rust", version = "1.0.0")', 'string', 'rules_rust'],
		['defs.bzl', 'starlark', 'def rule_impl(ctx):\n    return 42\n# a rule', 'keyword', 'return'],
		['custom.BUILD', 'starlark', 'cc_library(name = "demo")', 'string', 'demo'],
		['.bazelrc', 'bazelrc', 'build:release --jobs=8\n# a config', 'keyword', 'build'],
		['user.bazelrc', 'bazelrc', 'try-import %workspace%/local.bazelrc', 'keyword', 'try-import'],
		['bazel.rc', 'bazelrc', 'build --jobs=8', 'number', '8'],
	] as const;
	for (const [filename, languageId, text, type, lexeme] of samples) {
		const actualLanguage = await page.evaluate(({ filename, text }) => window.tokenizationIntegration.openResource(`/project/${filename}`, text), { filename, text });
		expect(actualLanguage, filename).toBe(languageId);
		await expect.poll(() => page.evaluate(({ type, lexeme }) => window.tokenizationIntegration.state().tokens.some(token => token.type === type && token.text.includes(lexeme)), { type, lexeme }), { message: filename }).toBe(true);
	}
	expect((await page.evaluate(() => window.tokenizationIntegration.state())).errors).toEqual([]);
});

test('Starlark editing indents blocks, closes brackets, toggles comments and folds by indentation', async ({ page }) => {
	await page.evaluate(() => window.tokenizationIntegration.openResource('/project/defs.bzl', 'def impl(ctx):'));
	const input = page.locator('.stanza-editor-input');
	await input.focus();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.press('Enter');
	await expect.poll(() => page.evaluate(() => window.tokenizationIntegration.state().text)).toMatch(/^def impl\(ctx\):\n[\t ]+$/u);
	await page.keyboard.type('return ');
	await page.keyboard.type('(');
	await expect.poll(() => page.evaluate(() => window.tokenizationIntegration.state().text)).toMatch(/\n[\t ]+return \(\)$/u);
	await page.keyboard.press('ControlOrMeta+/');
	await expect.poll(() => page.evaluate(() => window.tokenizationIntegration.state().text)).toMatch(/\n[\t ]+#\s*return \(\)$/u);
	await expect.poll(() => page.evaluate(() => window.tokenizationIntegration.state().tokens.some(token => token.type === 'comment' && token.text.includes('return')))).toBe(true);

	await page.evaluate(() => window.tokenizationIntegration.openResource('/project/folding.bzl', 'def impl(ctx):\n    value = 42\n    return value\n'));
	const returnToken = page.locator('.stanza-editor-token.token-keyword').filter({ hasText: /^return$/u });
	await expect(returnToken).toBeVisible();
	await page.locator('.ash-icon-folding-expanded').first().click();
	await expect(returnToken).toHaveCount(0);
	await page.locator('.ash-icon-folding-collapsed').first().click();
	await expect(returnToken).toBeVisible();

	await page.evaluate(() => window.tokenizationIntegration.openResource('/project/.bazelrc', 'build --jobs=8'));
	await input.focus();
	await page.keyboard.press('ControlOrMeta+/');
	await expect.poll(() => page.evaluate(() => window.tokenizationIntegration.state().text)).toMatch(/^#\s*build --jobs=8$/u);
	await expect.poll(() => page.evaluate(() => window.tokenizationIntegration.state().tokens.some(token => token.type === 'comment' && token.text.includes('build')))).toBe(true);
});

test('Force Retokenize action invalidates and refreshes visible tokens', async ({ page }) => {
	await expect(page.locator('.stanza-editor-token.token-keyword').filter({ hasText: /^fn$/ })).toBeVisible();
	const before = await page.evaluate(() => window.tokenizationIntegration.state());
	const result = await page.evaluate(() => window.tokenizationIntegration.forceRetokenize());
	expect(result).toEqual({ version: before.version, accurate: false });
	await expect.poll(() => page.evaluate(() => window.tokenizationIntegration.state().tokenVersion)).toBe(before.version);
	await expect(page.locator('.stanza-editor-token.token-keyword').filter({ hasText: /^fn$/ })).toBeVisible();
});

test('typing, undo and preview tokenize while parser analysis is pending; stale diagnostics are discarded', async ({ page }) => {
	const input = page.locator('.stanza-editor-input');
	await expect(page.locator('.stanza-editor-token.token-keyword').filter({ hasText: /^fn$/ })).toBeVisible();
	await input.focus();
	await page.keyboard.press('ControlOrMeta+Home');
	await page.keyboard.insertText('/* 中文🙂');
	await page.evaluate(() => window.tokenizationIntegration.stopUndo());
	await page.keyboard.insertText(' */');
	await expect.poll(() => page.evaluate(() => window.tokenizationIntegration.state().tokens.some(token => token.type === 'comment' && token.text.includes('中文🙂')))).toBe(true);
	await expect(page.locator('.stanza-editor-token.token-keyword').filter({ hasText: /^fn$/ })).toBeVisible();
	await expect.poll(() => page.evaluate(() => {
		const state = window.tokenizationIntegration.state();
		return state.tokenVersion === state.version;
	})).toBe(true);
	expect((await page.evaluate(() => window.tokenizationIntegration.state())).completedCalls).toBe(0);
	await page.keyboard.press('ControlOrMeta+z');
	await expect.poll(() => page.evaluate(() => window.tokenizationIntegration.state().text)).toBe('/* 中文🙂fn main() {}\n');
	await expect.poll(() => page.evaluate(() => window.tokenizationIntegration.state().tokens.some(token => token.type === 'comment' && token.text.includes('fn main')))).toBe(true);
	await expect(page.locator('.stanza-editor-token.token-keyword')).toHaveCount(0);
	const preview = await page.evaluate(() => window.tokenizationIntegration.preview());
	expect(preview.hasString).toBe(true);
	expect(preview.unchanged).toBe(true);
	const before = await page.evaluate(() => window.tokenizationIntegration.state());
	expect(before.diagnosticVersion).toBeNull();
	let releasedCurrent = false;
	for (let index = 0; index < before.version; index++) {
		await expect.poll(() => page.evaluate(() => window.tokenizationIntegration.state().pendingVersions.length)).toBeGreaterThan(0);
		const revision = await page.evaluate(() => window.tokenizationIntegration.state().pendingVersions[0]!);
		expect(revision).toBeLessThanOrEqual(before.version);
		await page.evaluate(() => window.tokenizationIntegration.releaseAnalysis());
		if (revision === before.version) {
			releasedCurrent = true;
			break;
		}
		await expect.poll(() => page.evaluate(revision => window.tokenizationIntegration.state().pendingVersions.some(value => value > revision), revision)).toBe(true);
		expect((await page.evaluate(() => window.tokenizationIntegration.state())).diagnosticVersion).toBeNull();
	}
	expect(releasedCurrent).toBe(true);
	await expect.poll(() => page.evaluate(() => window.tokenizationIntegration.state().diagnosticVersion)).toBe(before.version);
	expect((await page.evaluate(() => window.tokenizationIntegration.state())).errors).toEqual([]);
});

test('unloading extensions removes language associations, editing rules and grammars together', async ({ page }) => {
	await page.evaluate(() => window.tokenizationIntegration.open('shellscript', 'if true; then echo hello; fi'));
	await expect.poll(() => page.evaluate(() => window.tokenizationIntegration.state().tokens)).toContainEqual({ type: 'keyword', text: 'if' });
	await page.evaluate(() => window.tokenizationIntegration.unloadExtensions());
	expect(await page.evaluate(() => window.tokenizationIntegration.languageState())).toEqual({ initial: ['plaintext'], shell: null, resource: 'plaintext', comment: null, grammar: false, model: 'plaintext' });
	await expect.poll(() => page.evaluate(() => window.tokenizationIntegration.state().tokens)).toEqual([]);
});
