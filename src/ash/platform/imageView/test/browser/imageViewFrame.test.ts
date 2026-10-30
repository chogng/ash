import { expect } from '@playwright/test';
import { suite, test } from 'mocha';
import { useBrowserTests } from '../../../../../../test/unit/browser/context.js';

suite('Image view permission messages', () => {
	const browserTests = useBrowserTests();

	test('starts a native drag while Settings is pending and correlates out-of-order results', async () => {
		const { page } = browserTests;
		await page.goto('/imageViewFrame.html');
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		const frame = page.frameLocator('iframe');
		await frame.getByRole('button', { name: 'Open Settings', exact: true }).click();
		await expect.poll(() => page.evaluate(() => window.imageViewPermissionFixture.calls())).toEqual(['settings']);
		await frame.getByRole('button', { name: 'Drag application', exact: true }).click();
		await expect(frame.locator('output p')).toHaveText(['drag:true']);
		await frame.getByRole('button', { name: 'Copy path', exact: true }).click();
		await expect.poll(() => page.evaluate(() => window.imageViewPermissionFixture.calls())).toEqual(['settings', 'drag', 'copyPath']);
		// Repeated requests for the same operation must not launch another native action.
		await frame.getByRole('button', { name: 'Open Settings', exact: true }).click();
		await page.evaluate(() => window.imageViewPermissionFixture.release('copyPath', false));
		await expect(frame.locator('output p')).toHaveText(['drag:true', 'copyPath:false']);
		await page.evaluate(() => window.imageViewPermissionFixture.release('settings', true));
		await expect(frame.locator('output p')).toHaveText(['drag:true', 'copyPath:false', 'settings:true']);
		expect(await page.evaluate(() => window.imageViewPermissionFixture.calls())).toEqual(['settings', 'drag', 'copyPath']);
	});
});
