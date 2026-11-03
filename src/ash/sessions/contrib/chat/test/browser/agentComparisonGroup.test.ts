import { expect } from '@playwright/test';
import { suite, test } from 'mocha';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';
import type { } from '../../../../../../../test/fixtures/browser/sessions.page.js';

suite('Agent comparison group presentation', () => {
	const browser = useBrowserTests();

	test('shows two independent sessions in one sidebar group and in separate panes', async () => {
		const { page } = browser;
		await page.setViewportSize({ width: 1440, height: 860 });
		await page.goto('/sessions.html?multiHost&comparisonPreview');
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
		await page.evaluate(() => window.ashSessionsIntegration.multiHost!.showComparisonGroup());
		const group = page.locator('[data-section^="group:"]').filter({ hasText: 'Compare · Refactor the cache' });
		await expect(group).toBeVisible();
		await expect(group.getByText('Attempt 1 · Host A', { exact: true })).toBeVisible();
		await expect(group.getByText('Attempt 2 · Host B', { exact: true })).toBeVisible();
		await group.getByRole('button', { name: 'Open comparison Compare · Refactor the cache' }).press('Enter');
		await expect(page.locator('.ash-sessions-chat-slot:visible').filter({ hasText: 'Host A model' })).toHaveCount(1);
		await expect(page.locator('.ash-sessions-chat-slot:visible').filter({ hasText: 'Host B model' })).toHaveCount(1);
		await page.screenshot({ path: browser.info.outputPath('agent-comparison-group.png') });
	});
});
