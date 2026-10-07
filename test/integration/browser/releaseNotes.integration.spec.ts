import { expect, test } from '@playwright/test';

test('release notes render a registered Try This link and ignore other IDs', async ({ page }) => {
	await page.goto('/releaseNotes.html');
	const notes = page.frameLocator('main iframe[title="Release Notes"]');
	await expect(notes.getByRole('heading', { name: 'Ash 0.1' })).toBeVisible();
	await notes.getByRole('link', { name: 'Try Search commands' }).click();
	await expect.poll(() => page.evaluate(() => window.ashReleaseNotesIntegration.opened)).toEqual(['workbench.commandCenter.open']);
	await expect(page.frameLocator('#chinese iframe').getByRole('heading', { name: '查找操作' })).toBeVisible();
	const invalid = page.frameLocator('iframe[title="Invalid links"]');
	await expect(invalid.getByRole('link', { name: 'Unknown' })).toHaveCount(0);
	await expect(invalid.getByRole('link', { name: 'Malformed' })).toHaveCount(0);
});
