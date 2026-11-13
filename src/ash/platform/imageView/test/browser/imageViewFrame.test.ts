import { expect } from '@playwright/test';
import { suite, test } from 'mocha';
import { useBrowserTests } from '../../../../../../test/unit/browser/context.js';

suite('Image view message boundary', () => {
	const browserTests = useBrowserTests();
	test('ignores permission operations and continues handling image completion', async () => {
		const { page } = browserTests;
		await page.goto('/imageViewFrame.html');
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		const frame = page.frameLocator('iframe');
		await frame.getByRole('button', { name: 'Send messages', exact: true }).click();
		await expect(frame.locator('output p')).toHaveText(['completed']);
		expect(await page.evaluate(() => window.imageViewMessageFixture.completions())).toEqual([{ kind: 'cancel' }]);
	});
});
