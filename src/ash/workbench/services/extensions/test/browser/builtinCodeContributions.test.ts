import { expect } from '@playwright/test';
import { suite, test } from 'mocha';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';

suite('codeExtension browser component', () => {
	const browserTests = useBrowserTests();
	test('built-in Code features work without a backend and survive extension host retirement', async function () {
		const { page } = browserTests;

		const networkRequests: string[] = [];
		page.on('request', request => {
			if (request.url().includes('__code_')) networkRequests.push(request.url());
		});
		await page.goto('/codeExtension.html');
		await page.waitForFunction(() => !!window.ashCodeExtension);
		try {
			await expect.poll(() => page.evaluate(() => window.ashCodeExtension.state().minimap)).toBe(true);
			const initial = await page.evaluate(() => window.ashCodeExtension.state());
			expect(initial.ids).toContain('editor.contrib.folding');
			expect(initial.rename).toBe(true);
			expect(initial.folding).toBe(true);
			expect(initial.placeholder).toBe(true);
			for (let cycle = 0; cycle < 4; cycle++) {
				expect((await page.evaluate(() => window.ashCodeExtension.type('('))).text).toBe('()');
				expect((await page.evaluate(() => window.ashCodeExtension.undo())).text).toBe('');
				const edited = await page.evaluate(() => window.ashCodeExtension.edit('draft'));
				const reconnected = await page.evaluate(() => window.ashCodeExtension.reconnect());
				expect(reconnected.modelId).toBe(initial.modelId);
				expect(reconnected.text).toBe('draft');
				expect(reconnected.version).toBe(edited.version);
				expect(reconnected.rename).toBe(true);
				expect(reconnected.folding).toBe(true);
				expect(reconnected.minimap).toBe(true);
				expect(reconnected.backendRequests).toBe(0);
				expect((await page.evaluate(() => window.ashCodeExtension.undo())).text).toBe('');
			}
			expect(networkRequests).toEqual([]);
		} finally {
			await page.evaluate(() => window.ashCodeExtension?.dispose()).catch(() => undefined);
		}
	});
});
