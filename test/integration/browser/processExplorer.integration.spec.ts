import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
	page.on('pageerror', error => console.error(error));
	await page.goto('/processExplorer.html');
	await page.waitForFunction(() => Boolean(window.ashProcessExplorerIntegration));
	await page.evaluate(() => window.ashProcessExplorerIntegration.open());
});
test.afterEach(async ({ page }) => { await page.evaluate(() => window.ashProcessExplorerIntegration?.dispose()); });

test('the command collects through IPC and keyboard collapse survives a fresh snapshot', async ({ page }) => {
	const tree = page.getByRole('tree', { name: /^Process Explorer/ });
	await expect(tree).toBeVisible();
	await expect(page.getByRole('treeitem').filter({ hasText: 'Ash Main' })).toContainText('2.5');
	await expect(page.getByRole('treeitem').filter({ hasText: 'Ash Main' })).toContainText('16.0');
	await tree.press('Home'); await tree.press('ArrowDown'); await tree.press('ArrowLeft');
	await expect(page.getByRole('treeitem').filter({ hasText: 'Ash Main' })).toHaveAttribute('aria-expanded', 'false');
	await expect(page.getByRole('treeitem').filter({ hasText: 'Renderer: Editor' })).toHaveCount(0);
	await page.evaluate(() => window.ashProcessExplorerIntegration.update());
	const refresh = page.getByRole('button', { name: 'Refresh', exact: true });
	await refresh.click();
	await expect(page.getByRole('status')).toContainText('2 processes');
	await expect(refresh).toBeFocused();
	await expect(page.getByRole('treeitem').filter({ hasText: 'Ash Main' })).toHaveAttribute('aria-expanded', 'false');
	await tree.focus(); await tree.press('Home'); await tree.press('ArrowDown'); await tree.press('ArrowRight');
	await expect(page.getByRole('treeitem').filter({ hasText: 'worker-new' })).toBeVisible();
	await expect(page.getByRole('treeitem').filter({ hasText: 'Ash Main' })).toContainText('32.0');
	await page.evaluate(() => window.ashProcessExplorerIntegration.open());
	await expect(page.locator('.ash-process-explorer')).toHaveCount(1);
});

test('help and accessible content restore focus and copy includes collapsed descendants', async ({ page }) => {
	const tree = page.getByRole('tree', { name: /^Process Explorer/ });
	await tree.press('Home'); await tree.press('ArrowLeft');
	await page.evaluate(() => window.ashProcessExplorerIntegration.show('help'));
	await expect(page.getByRole('dialog', { name: 'Accessibility Help' }).getByRole('textbox')).toHaveValue(/Right to expand and Left to collapse/);
	await page.keyboard.press('Escape'); await expect(tree).toBeFocused();
	await page.evaluate(() => window.ashProcessExplorerIntegration.show('view'));
	await expect(page.getByRole('dialog', { name: 'Accessible View' }).getByRole('textbox')).toHaveValue(/Renderer: Editor\t1.2\t8.0\t102/);
	await page.keyboard.press('Escape'); await expect(tree).toBeFocused();
	await tree.press('Shift+Tab');
	await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeFocused();
	await page.keyboard.press('ArrowRight');
	await expect(page.getByRole('button', { name: 'Copy process information' })).toBeFocused();
	await page.keyboard.press('Enter');
	expect(await page.evaluate(() => window.ashProcessExplorerIntegration.copy())).toContain('Renderer: Editor\t1.2\t8.0\t102');
	await page.evaluate(() => window.ashProcessExplorerIntegration.verbosity(false));
	await expect(tree).toHaveAttribute('aria-label', 'Process Explorer');
});

test('a failed or malformed refresh preserves the previous snapshot and a retry recovers', async ({ page }) => {
	await page.evaluate(() => window.ashProcessExplorerIntegration.fail(true));
	await page.getByRole('button', { name: 'Refresh', exact: true }).click();
	await expect(page.getByRole('status')).toContainText('previous refresh');
	await expect(page.getByRole('treeitem').filter({ hasText: 'Renderer: Editor' })).toBeVisible();
	await page.evaluate(() => { window.ashProcessExplorerIntegration.fail(false); window.ashProcessExplorerIntegration.update(); });
	await page.getByRole('button', { name: 'Refresh', exact: true }).click();
	await expect(page.getByRole('status')).toContainText('2 processes');
	await page.evaluate(() => window.ashProcessExplorerIntegration.malformed());
	await page.getByRole('button', { name: 'Refresh', exact: true }).click();
	await expect(page.getByRole('status')).toContainText('Could not refresh');
	await expect(page.getByRole('treeitem').filter({ hasText: 'worker-new' })).toBeVisible();
});

test('closing during collection discards the old response and repeated refreshes share one request', async ({ page }) => {
	await page.evaluate(() => window.ashProcessExplorerIntegration.hold());
	await page.getByRole('button', { name: 'Refresh', exact: true }).click();
	await expect(page.getByRole('tree')).toHaveAttribute('aria-busy', 'true');
	await page.getByRole('button', { name: 'Refresh', exact: true }).click();
	expect(await page.evaluate(() => window.ashProcessExplorerIntegration.requests())).toBe(2);
	await page.evaluate(() => window.ashProcessExplorerIntegration.close());
	await page.evaluate(() => window.ashProcessExplorerIntegration.release());
	await expect(page.locator('.ash-process-explorer')).toHaveCount(0);
	await page.evaluate(() => window.ashProcessExplorerIntegration.open());
	await expect(page.getByRole('status')).toContainText('3 processes');
});

test('Chinese labels and high contrast metrics remain readable in a narrow editor', async ({ page }) => {
	await page.goto('/processExplorer.html?locale=zh-CN'); await page.evaluate(() => window.ashProcessExplorerIntegration.open());
	await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeVisible();
	await expect(page.getByRole('status')).toContainText('3 个进程');
	for (const theme of ['light', 'dark', 'hcDark', 'hcLight'] as const) {
		await page.evaluate(theme => { window.ashProcessExplorerIntegration.theme(theme); window.ashProcessExplorerIntegration.resize(420); }, theme);
		const main = page.getByRole('treeitem').filter({ hasText: 'Ash Main' });
		await expect(main).toBeVisible();
		const geometry = await main.evaluate(row => { const columns = [...row.querySelectorAll('.process-explorer-row > span')].map(cell => cell.getBoundingClientRect()); return { width: row.getBoundingClientRect().width, ends: columns.map(cell => cell.right - row.getBoundingClientRect().left) }; });
		expect(geometry.ends.every(end => end <= geometry.width + 1)).toBe(true);
	}
	await page.getByRole('tree').focus(); await page.evaluate(() => window.ashProcessExplorerIntegration.show('help'));
	await expect(page.getByRole('dialog').getByRole('textbox')).toHaveValue(/最近一次成功刷新/);
});
