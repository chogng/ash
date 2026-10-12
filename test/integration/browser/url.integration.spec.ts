import { expect, test, type Page } from '@playwright/test';

const pageErrors = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
	const errors: string[] = [];
	pageErrors.set(page, errors);
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/url.html');
	await expect(page.getByRole('link', { name: 'Chat documentation' })).toBeVisible();
});
test.afterEach(({ page }) => { expect(pageErrors.get(page)).toEqual([]); });

test('a real Chat link confirms before contributed opening; Escape, Copy and one-time Open preserve trust', async ({ page }) => {
	const link = page.getByRole('link', { name: 'Chat documentation' });
	await link.focus();
	await link.press('Enter');
	const dialog = page.getByRole('dialog', { name: 'Open External Link', exact: true });
	await expect(dialog).toBeVisible();
	await expect(dialog).toContainText('https://docs.example.test/guide?q=1#topic');
	expect(await page.evaluate(() => window.ashURLIntegration.contributed)).toEqual([]);
	await page.keyboard.press('Escape');
	await expect(dialog).toHaveCount(0);
	await expect(link).toBeFocused();
	await link.press('Enter');
	await dialog.getByRole('button', { name: 'Copy', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.ashURLIntegration.copied)).toEqual(['https://docs.example.test/guide?q=1#topic']);
	await expect(dialog).toHaveCount(0);
	expect(await page.evaluate(() => window.ashURLIntegration.contributed)).toEqual([]);
	await link.focus();
	await link.press('Enter');
	await dialog.getByRole('button', { name: 'Open', exact: true }).press('Enter');
	await expect.poll(() => page.evaluate(() => window.ashURLIntegration.contributed)).toEqual(['https://docs.example.test/guide?q=1#topic']);
	await link.focus();
	await link.press('Enter');
	await expect(dialog).toBeVisible();
	await page.keyboard.press('Escape');
});

test('keyboard trust selection persists, survives reload and retains a narrow scheme and port', async ({ page }) => {
	const link = page.getByRole('link', { name: 'Chat documentation' });
	await link.click();
	await page.getByRole('button', { name: 'Configure Trusted Domains', exact: true }).click();
	const chooser = page.getByRole('dialog', { name: 'Choose which domains to trust', exact: true });
	await expect(chooser).toBeVisible();
	await chooser.getByRole('combobox').press('Enter');
	await expect.poll(() => page.evaluate(() => window.ashURLIntegration.contributed.length)).toBe(1);
	expect(await page.evaluate(() => window.ashURLIntegration.content)).toContain('https://docs.example.test');
	await page.reload();
	await link.click();
	await expect.poll(() => page.evaluate(() => window.ashURLIntegration.contributed.length)).toBe(1);
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await page.evaluate(() => window.ashURLIntegration.link('http://docs.example.test/guide'));
	await link.click();
	await expect(page.getByRole('dialog', { name: 'Open External Link', exact: true })).toBeVisible();
	await page.keyboard.press('Escape');
	await page.evaluate(() => window.ashURLIntegration.link('https://docs.example.test:8443/guide'));
	await link.click();
	await expect(page.getByRole('dialog', { name: 'Open External Link', exact: true })).toBeVisible();
	await page.keyboard.press('Escape');
});

test('the management command opens a writable editor; saving JSONC applies, invalid edits preserve trust and removal revokes it', async ({ page }) => {
	await page.getByRole('button', { name: 'Manage domains', exact: true }).click();
	await expect(page.locator('#editor .stanza-editor')).toBeVisible();
	const source = '// Preserve this comment\n["https://docs.example.test",]\n';
	await page.evaluate(content => window.ashURLIntegration.edit(content), source);
	await page.getByRole('button', { name: 'Save document', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.ashURLIntegration.content)).toBe(source);
	await page.getByRole('link', { name: 'Chat documentation' }).click();
	await expect.poll(() => page.evaluate(() => window.ashURLIntegration.contributed.length)).toBe(1);
	await page.evaluate(() => window.ashURLIntegration.edit('[false]'));
	await page.getByRole('button', { name: 'Save document', exact: true }).click();
	await expect(page.locator('#save-error')).toContainText('Invalid trusted domain pattern');
	expect(await page.evaluate(() => window.ashURLIntegration.content)).toBe(source);
	await page.evaluate(() => window.ashURLIntegration.edit('[]\n'));
	await page.getByRole('button', { name: 'Save document', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.ashURLIntegration.content)).toBe('[]\n');
	await page.getByRole('link', { name: 'Chat documentation' }).click();
	await expect(page.getByRole('dialog', { name: 'Open External Link', exact: true })).toBeVisible();
	await page.keyboard.press('Escape');
});

test('Chinese dialogs and trust choices remain readable and keyboard accessible across themes', async ({ page }) => {
	await page.evaluate(() => window.ashURLIntegration.setChinese());
	const link = page.getByRole('link', { name: 'Chat documentation' });
	for (const theme of [0, 1, 2]) {
		await page.evaluate(index => window.ashURLIntegration.setTheme(index), theme);
		await link.focus();
		await link.press('Enter');
		const dialog = page.getByRole('dialog', { name: '打开外部链接', exact: true });
		await expect(dialog).toContainText('是否打开此外部网站？');
		await expect(dialog.getByRole('button', { name: '打开', exact: true })).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(dialog.getByRole('button', { name: '复制', exact: true })).toBeFocused();
		await page.keyboard.press('Escape');
		await expect(link).toBeFocused();
	}
	await link.press('Enter');
	await page.getByRole('button', { name: '配置可信域名', exact: true }).press('Enter');
	const chooser = page.getByRole('dialog', { name: '选择要信任的域名', exact: true });
	await expect(chooser).toContainText('信任 https://docs.example.test');
	await chooser.getByRole('combobox').press('Escape');
	await expect(chooser).toHaveCount(0);
	expect(await page.evaluate(() => window.ashURLIntegration.contributed)).toEqual([]);
});

test('disposing a window contribution cancels an active trust picker without granting trust', async ({ page }) => {
	await page.getByRole('link', { name: 'Chat documentation' }).click();
	await page.getByRole('button', { name: 'Configure Trusted Domains', exact: true }).click();
	await expect(page.getByRole('dialog', { name: 'Choose which domains to trust', exact: true })).toBeVisible();
	await page.evaluate(() => window.ashURLIntegration.disposeContribution());
	await expect(page.getByRole('dialog')).toHaveCount(0);
	expect(await page.evaluate(() => window.ashURLIntegration.contributed)).toEqual([]);
	expect(await page.evaluate(() => window.ashURLIntegration.content)).not.toContain('"https://docs.example.test"');
});
