import { expect, test } from '@playwright/test';

test('policy stops expose their reason in the live transcript without a retry action', async ({ page }) => {
	await page.goto('/advisor.html');
	await page.getByRole('button', { name: 'Show policy stop' }).click();
	const transcript = page.getByRole('log', { name: 'Chat transcript' });
	await expect(transcript).toHaveAttribute('aria-live', 'polite');
	await expect(transcript.getByText('Automatic review stopped this turn', { exact: true })).toBeVisible();
	await expect(transcript.getByText('Automatic review rejected three consecutive actions.', { exact: true })).toBeVisible();
	await expect(transcript.getByText('Repeated actions were rejected. Review the reason before requesting a safer approach.', { exact: true })).toBeVisible();
	await expect(transcript.getByRole('button')).toHaveCount(0);
});

test('policy stop guidance uses the selected Chinese catalog', async ({ page }) => {
	await page.goto('/advisor.html?locale=zh-CN');
	await page.getByRole('button', { name: 'Show policy stop' }).click();
	const transcript = page.getByRole('log', { name: 'Chat transcript' });
	await expect(transcript.getByText('自动审查已停止本轮执行', { exact: true })).toBeVisible();
	await expect(transcript.getByText('多次操作被拒绝。请先查看原因，再要求采用更安全的方式。', { exact: true })).toBeVisible();
	await expect(transcript.getByRole('button')).toHaveCount(0);
});

test('advisor results are grouped and keyboard disclosure state survives a transcript refresh', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/advisor.html');
	await expect(page.getByRole('log', { name: 'Chat transcript' })).toBeVisible();
	await expect(page.locator('article')).toHaveCount(1);
	const summary = page.locator('summary');
	await expect(summary).toHaveText('Advisor · test/reviewer');
	await expect(page.locator('strong')).toHaveText('cancellation');
	await expect(page.getByText('Tokens: 120 input · 8 output', { exact: false })).toBeVisible();
	await summary.focus();
	await page.keyboard.press('Enter');
	await expect(page.locator('details')).not.toHaveAttribute('open');
	await page.getByRole('button', { name: 'Refresh transcript' }).click();
	await expect(page.locator('details')).not.toHaveAttribute('open');
	await summary.focus();
	await page.keyboard.press('Enter');
	await expect(page.locator('details')).toHaveAttribute('open');
	await expect(page.locator('strong')).toBeVisible();
	expect(errors).toEqual([]);
});

test('transcript keeps a visible message and its DOM node when older history arrives', async ({ page }) => {
	await page.goto('/advisor.html');
	await page.getByRole('button', { name: 'Fill transcript' }).click();
	const anchor = page.locator('[data-item-id="message-20"]');
	await anchor.scrollIntoViewIfNeeded();
	await anchor.evaluate(element => element.setAttribute('data-retained', 'true'));
	const before = await anchor.evaluate(element => element.getBoundingClientRect().top);

	await page.getByRole('button', { name: 'Prepend history' }).click();

	const after = await anchor.evaluate(element => element.getBoundingClientRect().top);
	expect(Math.abs(after - before)).toBeLessThan(2);
	await expect(anchor).toHaveAttribute('data-retained', 'true');
});
