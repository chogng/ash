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

test('reply code blocks inherit editor fonts and update without replacing content or changing inline code', async ({ page }) => {
	await page.goto('/advisor.html');
	await page.getByRole('button', { name: 'Show code reply' }).click();
	const block = page.locator('.ash-markdown pre');
	const code = block.locator('code');
	const paragraph = page.locator('.ash-markdown p');
	const inlineCode = paragraph.locator('code');
	const bodyFont = await paragraph.evaluate(element => getComputedStyle(element).fontSize);
	const inlineFont = await inlineCode.evaluate(element => getComputedStyle(element).fontFamily);
	await code.evaluate(element => element.setAttribute('data-retained', 'true'));
	await page.getByRole('button', { name: 'Update editor typography' }).click();
	await expect(code).toHaveCSS('font-size', '16px');
	await expect(code).toHaveCSS('line-height', '26px');
	await expect.poll(() => code.evaluate(element => getComputedStyle(element).fontFamily)).toMatch(/^"Courier New",/u);
	await expect(block).toHaveCSS('white-space', 'pre');
	expect(await block.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
	const unwrappedHeight = await block.evaluate(element => element.getBoundingClientRect().height);
	await page.getByRole('button', { name: 'Customize code blocks' }).click();
	await expect(code).toHaveCSS('font-size', '20px');
	await expect(code).toHaveCSS('line-height', '30px');
	await expect.poll(() => code.evaluate(element => getComputedStyle(element).fontFamily)).toMatch(/^Arial,/u);
	await expect(code).toHaveAttribute('data-retained', 'true');
	await expect(paragraph).toHaveCSS('font-size', bodyFont);
	await expect(inlineCode).toHaveCSS('font-family', inlineFont);
	await page.getByRole('button', { name: 'Turn code wrap on' }).click();
	await expect(block).toHaveCSS('white-space', 'pre-wrap');
	expect(await block.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThan(2);
	expect(await block.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThan(unwrappedHeight);
	await page.getByRole('button', { name: 'Restore code defaults' }).click();
	await expect(code).toHaveCSS('font-size', '16px');
	await expect(code).toHaveCSS('line-height', '26px');
	await expect(block).toHaveCSS('white-space', 'pre');
	await expect(code).toHaveAttribute('data-retained', 'true');
	await page.getByRole('button', { name: 'Use automatic editor line height' }).click();
	await expect(code).toHaveCSS('font-size', '18px');
	await expect(code).toHaveCSS('line-height', `${Math.round(18 * (process.platform === 'darwin' ? 1.5 : 1.35))}px`);
});

test('changing code typography keeps the first visible reply in place while reading history', async ({ page }) => {
	await page.goto('/advisor.html');
	await page.getByRole('button', { name: 'Fill code history' }).click();
	await page.locator('[data-item-id="code-20"]').scrollIntoViewIfNeeded();
	const before = await page.locator('.ash-chat-list-widget').evaluate(view => {
		const top = view.getBoundingClientRect().top;
		const anchor = [...view.querySelectorAll<HTMLElement>('article')].find(row => row.getBoundingClientRect().bottom > top)!;
		anchor.dataset.retained = 'true';
		return { id: anchor.dataset.itemId!, top: anchor.getBoundingClientRect().top };
	});
	await page.getByRole('button', { name: 'Customize code blocks' }).click();
	const anchor = page.locator(`[data-item-id="${before.id}"]`);
	await expect(anchor).toHaveAttribute('data-retained', 'true');
	await expect(anchor.locator('pre code')).toHaveCSS('font-size', '20px');
	const after = await anchor.evaluate(element => element.getBoundingClientRect().top);
	expect(Math.abs(after - before.top)).toBeLessThan(2);
});
