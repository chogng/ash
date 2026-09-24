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
