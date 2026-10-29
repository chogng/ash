import { expect } from '@playwright/test';
import { suite, test } from 'mocha';
import { useBrowserTests } from '../../../../../../test/unit/browser/context.js';

suite('treeView browser component', () => {
	const browserTests = useBrowserTests();
	for (const variant of ['', '?dark', '?hc&locale=zh-CN']) {
		test(`extension tree reads, checks, renames, refreshes and remounts ${variant || 'light'}`, async function () {
			const { page } = browserTests;

			const errors: string[] = [];
			page.on('pageerror', error => errors.push(error.message));
			page.on('console', message => { if (message.type() === 'error') { errors.push(message.text()); } });
			await page.goto(`/treeView.html${variant}`);
			try {
				const root = page.getByRole('treeitem').filter({ hasText: 'Root' });
				await expect(root).toBeVisible();
				await root.click();
				await page.keyboard.press('ArrowRight');
				const child = page.getByRole('treeitem').filter({ hasText: 'Child' });
				await expect(child).toBeVisible();
				const checkbox = child.getByRole('checkbox');
				await checkbox.focus();
				await page.keyboard.press('Space');
				await expect.poll(() => page.evaluate(() => window.treeIntegration.requests().some(request => (request.payload as any).method === 'checkbox' && (request.payload as any).isChecked))).toBe(true);
				await expect(checkbox).toBeChecked();
				expect(await page.evaluate(() => window.treeIntegration.commands())).toEqual([]);
				await child.click();
				await page.keyboard.press('F2');
				const rename = page.getByRole('textbox', { name: variant.includes('zh-CN') ? '重命名 Child' : 'Rename Child' });
				await expect(rename).toBeFocused();
				expect(await rename.evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd])).toEqual([0, 5]);
				await rename.fill('Renamed');
				await rename.press('Enter');
				await expect(page.locator('.ash-custom-tree-label').filter({ hasText: /^Renamed$/ })).toBeVisible();
				await page.keyboard.press('F2');
				const cancel = page.getByRole('textbox');
				await cancel.fill('Cancelled');
				await cancel.press('Escape');
				await expect(cancel).toHaveCount(0);
				expect(await page.evaluate(() => window.treeIntegration.requests().filter(request => (request.payload as any).method === 'rename').map(request => (request.payload as any).value))).toEqual(['Renamed']);
				const tree = page.getByRole('tree');
				await tree.focus();
				expect(await page.evaluate(() => window.treeIntegration.accessible(false))).toContain('Renamed: Provider owned');
				expect(await page.evaluate(() => window.treeIntegration.accessible(true))).toContain('F2');
				await expect(tree).toBeFocused();
				await expect(tree).toHaveAttribute('aria-description', /F2/);
				await page.evaluate(() => window.treeIntegration.verbosity(false));
				await page.locator('#outside').focus();
				await tree.focus();
				await expect(tree).not.toHaveAttribute('aria-description');
				const geometry = await page.locator('.ash-custom-tree-row').last().evaluate(row => {
					const text = row.querySelector('.ash-custom-tree-label')!;
					return { overflow: getComputedStyle(text).textOverflow, height: row.getBoundingClientRect().height, width: row.getBoundingClientRect().width };
				});
				expect(geometry.overflow).toBe('ellipsis');
				expect(geometry.height).toBeGreaterThan(0);
				expect(geometry.width).toBeGreaterThan(0);
				await page.keyboard.press('F2');
				await page.getByRole('textbox').fill('Unsubmitted');
				await page.evaluate(() => window.treeIntegration.refresh('From provider'));
				await expect(page.getByRole('textbox')).toHaveValue('Unsubmitted');
				await page.getByRole('textbox').press('Escape');
				await expect(page.getByRole('textbox')).toHaveCount(0);
				expect(await page.evaluate(() => window.treeIntegration.requests().filter(request => (request.payload as any).method === 'rename').length)).toBe(1);
				await expect(page.locator('.ash-custom-tree-label').filter({ hasText: /^From provider$/ })).toBeVisible();
				await page.evaluate(() => window.treeIntegration.move());
				await expect(page.locator('#first .ash-custom-tree-view')).toHaveCount(0);
				await expect(page.locator('#second .ash-custom-tree-view')).toBeVisible();
				await page.getByRole('treeitem').filter({ hasText: 'Root' }).click();
				await page.keyboard.press('ArrowRight');
				await expect(page.locator('#second .ash-custom-tree-label').filter({ hasText: /^From provider$/ })).toBeVisible();
				expect(errors).toEqual([]);
			} finally { await page.evaluate(() => window.treeIntegration?.dispose()); }
		});
	}

	test('retiring an extension tree aborts reads and rejects old refresh identities', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/treeView.html');
		await expect(page.getByRole('treeitem')).toBeVisible();
		const reads = await page.evaluate(() => window.treeIntegration.requests().length);
		await page.evaluate(() => window.treeIntegration.block());
		await expect.poll(() => page.evaluate(() => window.treeIntegration.requests().length)).toBeGreaterThan(reads);
		await page.evaluate(() => window.treeIntegration.stop());
		await expect(page.getByRole('tree')).toHaveCount(0);
		expect(await page.evaluate(() => window.treeIntegration.aborted())).toBe(true);
		expect(await page.evaluate(() => window.treeIntegration.stale())).toBe(true);
		await page.evaluate(() => window.treeIntegration.release());
		await expect(page.getByText('Retired result')).toHaveCount(0);
		await page.evaluate(() => window.treeIntegration.dispose());
		expect(errors).toEqual([]);
	});
});
