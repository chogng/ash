import { suite, test } from 'mocha';
import { expect } from '@playwright/test';
import { useBrowserTests } from '../../../../../../../../test/unit/browser/context.js';
import type { } from '../../../../../../../../test/fixtures/browser/chatFileTree.page.js';

const data = JSON.stringify({ kind: 'treeData', treeData: { label: 'Workspace', uri: 'file:///workspace', children: [{ label: 'src', uri: 'file:///workspace/src', children: [{ label: 'main.ts', uri: 'file:///workspace/src/main.ts', type: 'file' }] }] } });

suite('Captured Chat file trees in the original resource renderer', () => {
	const browser = useBrowserTests();
	for (const theme of ['light', 'dark', 'hc', 'hcLight']) test(`keyboard navigation opens the original file and retains snapshots in ${theme}`, async () => {
		const { page } = browser;
		await page.goto('/chatFileTree.html');
		await page.evaluate(({ data, theme }) => { window.chatFileTreeFixture.setTheme(theme); window.chatFileTreeFixture.render([data, data]); }, { data, theme });
		await page.evaluate(() => window.chatFileTreeFixture.navigate());
		const trees = page.getByRole('tree');
		await expect(trees.first()).toBeVisible();
		await expect(trees.first()).toBeFocused();
		const root = trees.first();
		await expect(root.locator('.ash-tree-row.focused')).toHaveCSS('outline-style', 'solid');
		await expect(root.locator('.ash-chat-file-tree-label').first()).toHaveCSS('text-overflow', 'ellipsis');
		const geometry = await root.boundingBox();
		expect(geometry!.width).toBeGreaterThan(0);
		expect(geometry!.height).toBeGreaterThanOrEqual(66);
		expect(geometry!.height).toBeLessThanOrEqual(264);
		expect(await root.locator('.ash-tree-row.focused').evaluate(element => getComputedStyle(element).outlineColor)).not.toBe('rgba(0, 0, 0, 0)');
		await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
		await expect(page.locator('#opened')).toHaveText('const captured = 1;');
		expect((await page.evaluate(() => window.chatFileTreeFixture.state())).reads).toBe(1);
		await page.evaluate(() => window.chatFileTreeFixture.navigate());
		await expect(trees.nth(1)).toBeFocused();
		await page.evaluate(() => window.chatFileTreeFixture.navigate());
		await expect(trees.first()).toBeFocused();
		await page.evaluate(() => window.chatFileTreeFixture.navigate(true));
		await expect(trees.nth(1)).toBeFocused();
		await page.keyboard.press('ArrowLeft');
		expect((await page.evaluate(() => window.chatFileTreeFixture.state())).reads).toBe(1);
		await page.evaluate(() => window.chatFileTreeFixture.render([]));
		await expect(trees).toHaveCount(0);
		expect((await page.evaluate(() => window.chatFileTreeFixture.state())).errors).toEqual([]);
	});
	test('Chinese labels, inert markup, source replacement and disposal retain one tree owner', async () => {
		const { page } = browser;
		await page.goto('/chatFileTree.html?zh=1');
		const payload = data.replace('main.ts\"', '<img src=x onerror=alert(1)>\"');
		await page.evaluate(payload => window.chatFileTreeFixture.render([payload]), payload);
		await page.evaluate(() => window.chatFileTreeFixture.navigate());
		await expect(page.getByRole('tree', { name: '文件树：Workspace', exact: true })).toBeVisible();
		await expect(page.getByRole('treeitem').filter({ hasText: '<img src=x onerror=alert(1)>' })).toBeVisible();
		await expect(page.locator('.ash-chat-file-tree img')).toHaveCount(0);
		await page.evaluate(data => window.chatFileTreeFixture.render([data]), data);
		await expect(page.getByRole('tree')).toHaveCount(1);
		await page.evaluate(() => window.chatFileTreeFixture.dispose());
		await expect(page.getByRole('tree')).toHaveCount(0);
	});
});
