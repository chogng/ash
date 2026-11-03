import { expect } from '@playwright/test';
import { suite, test } from 'mocha';
import { useBrowserTests } from '../../../../../../../test/unit/browser/context.js';
import type { } from '../../../github/test/browser/fixtures/sessionGitHub.page.js';

suite('Sessions input stack browser layout', () => {
	const browserTests = useBrowserTests();

	test('PR refresh retains focus and spacing; selecting a draft releases the slot', async () => {
		const { page } = browserTests;
		await page.goto('/sessionGitHub.html?inputStack');
		const prs = page.locator('.ash-session-chat-input-prs');
		const input = page.locator('textarea.ash-chat-input-container');
		const link = prs.locator('.ash-session-chat-input-pr').filter({ hasText: 'one #7' });
		await expect(link).toBeVisible();
		await expect(prs).toHaveCSS('margin-bottom', '0px');
		await expect(input).toHaveCSS('margin-top', '8px');
		await link.focus();
		await page.evaluate(() => window.ashSessionGitHub.setAttention('checks'));
		await expect(link).toHaveAccessibleName(/Checks failed/);
		await expect(link).toBeFocused();
		const upper = await prs.boundingBox();
		const lower = await input.boundingBox();
		expect(lower!.y - upper!.y - upper!.height).toBeCloseTo(8, 0);
		await link.press('Enter');
		await expect.poll(() => page.evaluate(() => window.ashSessionGitHub.opened)).toEqual(['https://github.com/team/one/pull/7']);
		await link.focus();
		await page.evaluate(() => window.ashSessionGitHub.selectDraft());
		await expect(prs).toBeHidden();
		await expect(input).toBeFocused();
		await expect(input).toHaveCSS('margin-top', '0px');
		await expect(input).toHaveValue('Retained PR draft');
		await page.evaluate(() => window.ashSessionGitHub.dispose());
		await expect(prs).toHaveCount(0);
		await expect(input).toHaveCSS('margin-top', '0px');
	});

	test('the real Sessions composer keeps empty PR and onboarding slots out of its layout', async () => {
		const { page } = browserTests;
		await page.goto('/sessions.html?creator');
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
		await page.locator('.ash-sessions-activity-content').getByRole('button', { name: /^New(?:\.|$)/u }).click();
		const stack = page.locator('.ash-sessions-chat-slot.active .ash-chat-input-stack');
		await expect(stack).toBeVisible();
		await expect(stack.locator('.ash-session-chat-input-prs')).toBeHidden();
		await expect(stack.locator('.ash-chat-input-notice-slot')).toHaveCount(2);
		for (const slot of await stack.locator('.ash-chat-input-notice-slot').all()) await expect(slot).toBeHidden();
		const tip = stack.locator('.ash-chat-input-tip');
		await expect(tip).toBeVisible();
		const input = stack.locator('.ash-chat-input-container');
		await expect(input).toHaveCSS('margin-top', '8px');
		await expect(input).toHaveCSS('border-top-left-radius', '12px');
		await tip.getByRole('button', { name: 'Dismiss tip', exact: true }).click();
		await expect(tip).toHaveCount(0);
		await expect(input).toHaveCSS('margin-top', '0px');
		await stack.screenshot({ path: browserTests.info.outputPath('sessions-input-stack.png') });
	});
});
