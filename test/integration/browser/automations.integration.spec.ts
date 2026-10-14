import { test, expect } from '@playwright/test';

for (const [locale, theme] of [['en', 'light'], ['zh-CN', 'dark'], ['zh-CN', 'hcDark'], ['en', 'hcLight']] as const) {
	test(`Automations uses cards, a commit-aware dialog and host dispatch (${locale}, ${theme})`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto(`/automations.html?locale=${locale}&theme=${theme}`);
		await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
		expect(await page.evaluate(() => ({ sessions: window.ashAutomations.registered, workbench: window.ashAutomations.workbenchRegistered }))).toEqual({ sessions: true, workbench: false });
		const zh = locale === 'zh-CN';
		await expect(page.locator('[data-part="customview"]')).toBeVisible();
		await expect(page.getByRole('heading', { name: zh ? '自动化' : 'Automations', exact: true })).toBeVisible();
		await page.getByRole('button', { name: zh ? '新建自动化' : 'New automation', exact: true }).press('Enter');
		const dialog = page.getByRole('dialog');
		const name = dialog.getByLabel(zh ? '名称' : 'Name', { exact: true });
		await expect(name).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(dialog.getByLabel(zh ? '指令' : 'Instructions', { exact: true })).toBeFocused();
		await name.fill('Keyboard review');
		await dialog.getByLabel(zh ? '指令' : 'Instructions', { exact: true }).fill('Review changes');
		await page.evaluate(() => window.ashAutomations.selectDirectory('/other'));
		await expect(dialog.getByLabel(zh ? '执行目录' : 'Directory', { exact: true })).toHaveValue('/captured');
		await name.focus();
		const style = await name.evaluate(element => {
			const style = getComputedStyle(element);
			return { outline: style.outlineStyle, border: style.borderTopStyle, color: style.color, width: element.getBoundingClientRect().width };
		});
		expect(style.outline).toBe('solid');
		expect(style.border).toBe('solid');
		expect(style.color).not.toBe('rgba(0, 0, 0, 0)');
		expect(style.width).toBeGreaterThan(0);
		await dialog.screenshot({ path: test.info().outputPath('automation-dialog.png') });
		await dialog.getByRole('button', { name: zh ? '保存自动化' : 'Save automation', exact: true }).press('Enter');
		await expect(dialog).toHaveCount(0);
		expect(await page.evaluate(() => window.ashAutomations.saved[0]?.directory)).toBe('/captured');
		await expect(page.getByRole('button', { name: 'Keyboard review', exact: true })).toBeVisible();
		await expect(page.getByRole('article').first()).toHaveAttribute('aria-label', 'Keyboard review');
		const content = await page.evaluate(() => window.ashAutomations.help());
		expect(content.help).toContain('Tab');
		expect(content.view).toContain(zh ? '需要输入' : 'Needs input');
		await page.getByRole('button', { name: zh ? '停止运行' : 'Stop run', exact: true }).press('Enter');
		const card = page.getByRole('article', { name: 'Scheduled review' });
		const runNow = card.getByRole('button', { name: zh ? '立即运行' : 'Run now', exact: true });
		await expect(runNow).toBeEnabled();
		await runNow.press('Enter');
		await expect(page.locator('.ash-automation-history')).toContainText(zh ? '运行中' : 'Running');
		await page.setViewportSize({ width: 360, height: 640 });
		await page.getByRole('button', { name: zh ? '新建自动化' : 'New automation', exact: true }).press('Enter');
		await dialog.getByLabel(zh ? '计划' : 'Schedule', { exact: true }).selectOption('weekly');
		const cancel = dialog.getByRole('button', { name: zh ? '取消' : 'Cancel', exact: true });
		await cancel.scrollIntoViewIfNeeded();
		const geometry = await dialog.evaluate(element => {
			const bounds = element.getBoundingClientRect();
			return { top: bounds.top, bottom: bounds.bottom, fits: element.scrollWidth <= element.clientWidth };
		});
		expect(geometry.top).toBeGreaterThanOrEqual(0);
		expect(geometry.bottom).toBeLessThanOrEqual(640);
		expect(geometry.fits).toBe(true);
		await expect(cancel).toBeInViewport();
		await dialog.screenshot({ path: test.info().outputPath('automation-dialog-narrow.png') });
		await page.keyboard.press('Escape');
		await expect(dialog).toHaveCount(0);
		expect(await page.locator('.ash-custom-view-page').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
		await page.locator('[data-part="customview"]').screenshot({ path: test.info().outputPath('automations-cards.png') });
		await page.getByRole('button', { name: zh ? '打开对话' : 'Open conversation', exact: true }).press('Enter');
		await expect.poll(() => page.evaluate(() => window.ashAutomations.opened)).toEqual([['background-session', 'background-thread']]);
		await expect(page.locator('[data-part="customview"]')).toBeHidden();
		expect(await page.evaluate(() => window.ashAutomations.stops())).toBe(1);
		await page.evaluate(() => window.ashAutomations.reopen());
		await expect(page.locator('.ash-automation-history')).toContainText(zh ? '运行中' : 'Running');
		await page.evaluate(() => window.ashAutomations.finish());
		expect(await page.evaluate(() => window.ashAutomations.errors)).toEqual([]);
		expect(errors).toEqual([]);
	});
}

test('Automation edit preserves the draft on commit failure and a remote revision conflict', async ({ page }) => {
	await page.goto('/automations.html?locale=zh-CN&theme=dark');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	const edit = page.getByRole('button', { name: 'Scheduled review', exact: true });
	await edit.press('Enter');
	const dialog = page.getByRole('dialog');
	await dialog.getByLabel('名称', { exact: true }).fill('Unsaved edit');
	await page.evaluate(() => window.ashAutomations.rejectSave());
	await dialog.getByRole('button', { name: '保存自动化', exact: true }).press('Enter');
	await expect(dialog.getByRole('status')).toContainText('Rejected test write');
	await expect(dialog.getByLabel('名称', { exact: true })).toHaveValue('Unsaved edit');
	await page.evaluate(() => window.ashAutomations.remoteEdit());
	await dialog.getByRole('button', { name: '保存自动化', exact: true }).press('Enter');
	await expect(dialog.getByRole('status')).toContainText('已发生更改');
	await page.keyboard.press('Escape');
	await expect(dialog).toHaveCount(0);
	await expect(edit).toBeFocused();
	expect(await page.evaluate(() => window.ashAutomations.saved)).toEqual([]);
});

test('Automations retains saved cards but disables mutations when its host disconnects', async ({ page }) => {
	await page.goto('/automations.html');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	await page.evaluate(() => window.ashAutomations.disconnect());
	await expect(page.getByRole('button', { name: 'Scheduled review', exact: true })).toBeDisabled();
	await expect(page.getByRole('button', { name: 'New automation', exact: true })).toBeDisabled();
	await expect(page.locator('.ash-automations').getByRole('status')).toContainText('unavailable');
});

test('Sessions hides the automation entry without a provider capability', async ({ page }) => {
	await page.goto('/automations.html?available=0');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	expect(await page.evaluate(() => window.ashAutomations.registered)).toBe(false);
	await expect(page.locator('[data-part="customview"]')).toBeHidden();
	await expect(page.getByRole('button', { name: 'New automation', exact: true })).toHaveCount(0);
});

test('A committed automation closes its dialog even when history refresh fails', async ({ page }) => {
	await page.goto('/automations.html?locale=zh-CN');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	await page.getByRole('button', { name: '新建自动化', exact: true }).click();
	const dialog = page.getByRole('dialog');
	await dialog.getByLabel('名称', { exact: true }).fill('Saved once');
	await dialog.getByLabel('指令', { exact: true }).fill('Review changes');
	await page.evaluate(() => window.ashAutomations.failHistory());
	await dialog.getByRole('button', { name: '保存自动化', exact: true }).click();
	await expect(dialog).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Saved once', exact: true })).toBeEnabled();
	await expect(page.getByText('无法刷新运行历史。当前显示上次可用的历史，可使用“刷新”重试。', { exact: true })).toBeVisible();
	expect(await page.evaluate(() => window.ashAutomations.saved.length)).toBe(1);
	await page.evaluate(() => window.ashAutomations.retryHistory());
	await expect(page.getByText('无法刷新运行历史。当前显示上次可用的历史，可使用“刷新”重试。', { exact: true })).toBeHidden();
	expect(await page.evaluate(() => window.ashAutomations.saved.length)).toBe(1);
});

test('Sessions navigation hides Automations and Back/Forward restores each destination', async ({ page }) => {
	await page.goto('/automations.html');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	await page.evaluate(() => window.ashAutomations.openDraft());
	await expect(page.locator('[data-part="customview"]')).toBeHidden();
	expect(await page.evaluate(() => window.ashAutomations.selectedTitle())).toBe('New draft');
	await page.evaluate(() => window.ashAutomations.back());
	await expect(page.locator('[data-part="customview"]')).toBeVisible();
	await page.evaluate(() => window.ashAutomations.back());
	await expect(page.locator('[data-part="customview"]')).toBeHidden();
	expect(await page.evaluate(() => window.ashAutomations.selectedTitle())).toBe('Draft');
	await page.evaluate(() => window.ashAutomations.forward());
	await expect(page.locator('[data-part="customview"]')).toBeVisible();
	await page.evaluate(() => window.ashAutomations.forward());
	await expect(page.locator('[data-part="customview"]')).toBeHidden();
	expect(await page.evaluate(() => window.ashAutomations.selectedTitle())).toBe('New draft');
	expect(await page.evaluate(() => window.ashAutomations.stops())).toBe(0);
});

test('A run that fails before creating a conversation reports the host failure', async ({ page }) => {
	await page.goto('/automations.html');
	await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
	await page.getByRole('button', { name: 'Stop run', exact: true }).click();
	await page.evaluate(() => window.ashAutomations.deferRun());
	await page.getByRole('button', { name: 'Run now', exact: true }).click();
	await expect(page.locator('.ash-automation-history')).toContainText('Pending');
	await page.evaluate(() => window.ashAutomations.failRun());
	await expect.poll(() => page.evaluate(() => window.ashAutomations.errors)).toEqual(['Automation Scheduled review: Could not create session']);
	await expect(page.locator('.ash-automation-history')).toContainText('Failed');
});
