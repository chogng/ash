import { expect } from '@playwright/test';
import { suite, test } from 'mocha';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';

suite('Extension image editor Webview boundary', () => {
	const browser = useBrowserTests();
	test('ignores permission requests, rejects Pin, and keeps completion on the document-scoped Webview channel', async () => {
		await browser.page.goto('/imageEditorWebview.html');
		const frame = browser.page.frameLocator('iframe').frameLocator('iframe');
		await expect(frame.getByRole('button', { name: 'Send messages' })).toBeEnabled();
		await frame.getByRole('button', { name: 'Send messages' }).click();
		await expect(frame.locator('output p')).toHaveText(['rejected', 'completed']);
		expect(await browser.page.evaluate(() => window.imageEditorMessageFixture.completions())).toEqual([{ kind: 'cancel' }]);
	});
});
