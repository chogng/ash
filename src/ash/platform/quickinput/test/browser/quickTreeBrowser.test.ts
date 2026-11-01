import { expect } from '@playwright/test';
import { suite, test } from 'mocha';
import { useBrowserTests } from '../../../../../../test/unit/browser/context.js';
import type { } from './fixtures/quickTree.page.js';

suite('Quick Input browser behavior', () => {
	const browser = useBrowserTests();

	for (const kind of ['tree', 'buttons', 'widget']) {
		test(`shared ${kind} chrome supports native actions, busy state and disabled Escape`, async () => {
			const { page } = browser;
			await page.goto('/quickTree.html?shared&locale=zh-CN&theme=hcLight');
			const origin = page.getByRole('button', { name: `Open ${kind}`, exact: true });
			await origin.click();
			const surface = page.locator('.ash-quick-input-host > .ash-quick-pick, .ash-quick-input-host > .ash-quick-widget');
			await expect(surface.locator('.ash-quick-input-title')).toHaveText('Configure');
			await expect(surface.locator('.ash-quick-input-steps')).toHaveText('第 2 步，共 3 步');
			await expect(surface).toHaveAttribute('aria-busy', 'true');
			const action = surface.getByRole('button', { name: 'Title toggle', exact: true });
			await action.click();
			await expect(action).toHaveAttribute('aria-pressed', 'true');
			await surface.locator('.ash-quick-input-title-actions button[aria-haspopup="menu"]').click();
			await page.getByRole('menuitem', { name: 'More setting', exact: true }).click();
			await expect(surface).toBeVisible();
			expect(await page.evaluate(() => window.quickTreeTest.lifecycle)).toEqual([]);
			await surface.getByRole('link', { name: 'Help', exact: true }).click();
			expect(await page.evaluate(() => window.quickTreeTest.opened)).toEqual(['https://example.test/help']);
			await page.evaluate(() => { window.quickTreeTest.setBusy(false); window.quickTreeTest.setEnabled(false); });
			await expect(surface).toHaveAttribute('aria-busy', 'false');
			await expect(action).toBeDisabled();
			await expect(surface).toBeFocused();
			await page.keyboard.press('Escape');
			await expect(surface).toHaveCount(0);
			await expect(origin).toBeFocused();
			expect(await page.evaluate(() => window.quickTreeTest.lifecycle)).toEqual(['will:2', 'did:2']);
		});
	}

	for (const kind of ['tree', 'buttons']) {
		test(`${kind} supports overlay and viewport-point anchors`, async () => {
			const { page } = browser;
			await page.goto('/quickTree.html');
			await page.getByRole('button', { name: `Open ${kind}`, exact: true }).click();
			await page.evaluate(() => window.quickTreeTest.setAnchor('overlay'));
			const surface = page.locator('.ash-quick-input-host > .ash-quick-pick');
			const anchorBounds = await page.getByRole('button', { name: 'Open tree', exact: true }).boundingBox();
			const overlayBounds = await surface.boundingBox();
			expect(Math.abs(overlayBounds!.width - anchorBounds!.width)).toBeLessThan(1);
			await page.evaluate(() => window.quickTreeTest.setAnchor('point'));
			const pointBounds = await surface.boundingBox();
			expect(pointBounds!.x).toBe(200);
			expect(pointBounds!.y).toBe(184);
		});
	}

	for (const variant of [{ theme: 'light', locale: 'en' }, { theme: 'dark', locale: 'zh-CN' }, { theme: 'hc', locale: 'en' }, { theme: 'hcLight', locale: 'en' }]) {
		test(`tree filtering retains hidden selections and collapse state (${variant.theme}, ${variant.locale})`, async () => {
			const { page } = browser;
			await page.goto(`/quickTree.html?${new URLSearchParams(variant)}`);
			const origin = page.getByRole('button', { name: 'Open tree', exact: true });
			await origin.click();
			const dialog = page.getByRole('dialog', { name: 'Tools' });
			const input = dialog.getByRole('combobox');
			const group = dialog.getByRole('treeitem', { name: 'Workspace', exact: true });
			await expect(group).toHaveAttribute('aria-checked', 'mixed');
			await expect(group).toHaveAttribute('aria-expanded', 'false');
			await input.fill('Workspace');
			await expect(dialog.getByRole('treeitem', { name: 'Read', exact: true })).toBeVisible();
			await expect(dialog.getByRole('treeitem', { name: 'Locked', exact: true })).toBeVisible();
			await input.fill('files');
			await expect(dialog.getByRole('treeitem', { name: 'Write, files', exact: true })).toBeVisible();
			await input.fill('Write');
			await expect(group).toHaveAttribute('aria-expanded', 'true');
			const write = dialog.getByRole('treeitem', { name: 'Write, files', exact: true });
			await expect(write).toBeVisible();
			await input.press('ArrowDown');
			await page.keyboard.press('Space');
			await expect(write).toHaveAttribute('aria-checked', 'true');
			await expect(group).toHaveAttribute('aria-checked', 'true');
			expect((await page.evaluate(() => window.quickTreeTest.snapshot())).checked).toEqual(['read', 'write', 'other']);
			await expect(dialog.getByRole('tree')).toBeFocused();
			await expect(input).toHaveAttribute('aria-activedescendant', await write.getAttribute('id') ?? '');
			await input.fill('');
			await expect(group).toHaveAttribute('aria-expanded', 'false');
			await expect(dialog.getByRole('status').filter({ hasText: variant.locale === 'zh-CN' ? '已选择' : 'selected' })).toHaveText(variant.locale === 'zh-CN' ? '已选择 3 项' : '3 selected');
			await input.press('Escape');
			await expect(dialog).toHaveCount(0);
			await expect(origin).toBeFocused();
		});
	}

	test('tree keyboard navigation, native checkboxes, row actions and acceptance use one selection', async () => {
		const { page } = browser;
		await page.goto('/quickTree.html');
		await page.getByRole('button', { name: 'Open tree', exact: true }).click();
		const dialog = page.getByRole('dialog');
		const input = dialog.getByRole('combobox');
		await input.press('Tab'); // Select all
		await page.getByRole('tree').focus();
		await page.getByRole('tree').press('ArrowRight');
		const locked = dialog.getByRole('treeitem', { name: 'Locked', exact: true });
		await expect(locked).toHaveAttribute('aria-disabled', 'true');
		await dialog.getByRole('treeitem', { name: 'Write, files', exact: true }).locator('input[type="checkbox"]').click();
		await expect(dialog.getByRole('treeitem', { name: 'Workspace', exact: true })).toHaveAttribute('aria-checked', 'true');
		await dialog.getByRole('button', { name: 'Details', exact: true }).click();
		expect((await page.evaluate(() => window.quickTreeTest.snapshot())).buttonEvents).toEqual(['write']);
		await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
		await expect(dialog).toHaveCount(0);
		await expect(page.getByRole('status', { name: 'Result' })).toHaveText('["read","write","other"]');
	});

	test('large trees virtualize rows and keep the active descendant mounted', async () => {
		const { page } = browser;
		await page.goto('/quickTree.html?many');
		await page.getByRole('button', { name: 'Open tree', exact: true }).click();
		const input = page.getByRole('combobox');
		expect(await page.getByRole('treeitem').count()).toBeLessThan(50);
		await input.press('Control+End');
		const last = page.getByRole('treeitem', { name: 'Other', exact: true });
		await expect(last).toBeVisible();
		await expect(input).toHaveAttribute('aria-activedescendant', await last.getAttribute('id') ?? '');
		const geometry = await last.evaluate(row => ({ row: row.getBoundingClientRect().toJSON(), text: row.querySelector('.ash-quick-tree-row')!.getBoundingClientRect().toJSON() }));
		expect(geometry.text.top).toBeGreaterThanOrEqual(geometry.row.top);
		expect(geometry.text.bottom).toBeLessThanOrEqual(geometry.row.bottom);
	});

	test('Tab cycles within the tree picker and Escape works from an item action', async () => {
		const { page } = browser;
		await page.goto('/quickTree.html');
		const origin = page.getByRole('button', { name: 'Open tree', exact: true });
		await origin.click();
		const input = page.getByRole('combobox');
		await input.press('Shift+Tab');
		await expect(page.getByRole('button', { name: 'Apply', exact: true })).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(input).toBeFocused();
		await input.fill('Write');
		const details = page.getByRole('button', { name: 'Details', exact: true });
		await details.focus();
		await details.press('Escape');
		await expect(page.getByRole('dialog')).toHaveCount(0);
		await expect(origin).toBeFocused();
	});

	test('task pins survive reopening and reload without running the task', async () => {
		const { page } = browser;
		await page.goto('/quickTree.html');
		await page.getByRole('button', { name: 'Open tasks', exact: true }).click();
		const dialog = page.getByRole('dialog', { name: 'Tasks', exact: true });
		await dialog.getByRole('option').filter({ hasText: 'Test' }).getByRole('button', { name: 'Pin item', exact: true }).click();
		await expect(dialog.getByRole('combobox')).toBeFocused();
		await expect(dialog.getByRole('option').first()).toContainText('Test');
		await expect(page.getByRole('status', { name: 'Result' })).toBeEmpty();
		await page.keyboard.press('Escape');
		await page.reload();
		await page.getByRole('button', { name: 'Open tasks', exact: true }).click();
		await expect(dialog.getByRole('option').first()).toContainText('Test');
		await expect(dialog.getByRole('button', { name: 'Unpin item', exact: true })).toHaveCount(1);
		await expect(dialog.getByRole('option')).toHaveCount(3);
		await expect(dialog.getByRole('option').last().getByRole('button', { name: 'Pin item', exact: true })).toHaveCount(1);
		await dialog.getByRole('combobox').fill('Build');
		await expect(dialog.getByRole('option')).toHaveCount(1);
		await expect(dialog.getByRole('option')).toContainText('Build');
	});

	test('turning off both match fields shows the full tree while retaining the query', async () => {
		const { page } = browser;
		await page.goto('/quickTree.html');
		await page.getByRole('button', { name: 'Open tree', exact: true }).click();
		const input = page.getByRole('combobox');
		await input.fill('missing');
		await expect(page.getByRole('treeitem')).toHaveCount(0);
		await page.evaluate(() => window.quickTreeTest.setFilterOptions(false, false));
		await expect(page.getByRole('treeitem')).toHaveCount(5);
		await expect(input).toHaveValue('missing');
		await page.evaluate(() => window.quickTreeTest.setFilterOptions(true, false));
		await expect(page.getByRole('treeitem')).toHaveCount(0);
	});

	test('tree navigation transfers focus and returns to the input at either boundary', async () => {
		const { page } = browser;
		await page.goto('/quickTree.html');
		await page.getByRole('button', { name: 'Open tree', exact: true }).click();
		const input = page.getByRole('combobox');
		const tree = page.getByRole('tree');
		await input.press('ArrowDown');
		await expect(tree).toBeFocused();
		await expect(page.getByRole('treeitem', { name: 'Other', exact: true })).toHaveAttribute('aria-selected', 'true');
		await tree.press('ArrowDown');
		await expect(input).toBeFocused();
		await input.press('ArrowUp');
		await expect(tree).toBeFocused();
		await expect(page.getByRole('treeitem', { name: 'Workspace', exact: true })).toHaveAttribute('aria-selected', 'true');
		await tree.press('ArrowUp');
		await expect(input).toBeFocused();
	});

	test('description and validation links open through the host and never accept the picker', async () => {
		const { page } = browser;
		await page.goto('/quickTree.html');
		await page.getByRole('button', { name: 'Open tree', exact: true }).click();
		await page.evaluate(() => {
			window.quickTreeTest.setDescription('Read [guide](https://example.test "Docs").');
			window.quickTreeTest.setValidation('Change [settings](command:settings).', 2);
		});
		const dialog = page.getByRole('dialog');
		await dialog.getByRole('link', { name: 'guide', exact: true }).click();
		const settings = dialog.getByRole('link', { name: 'settings', exact: true });
		await settings.press('Enter');
		await settings.press('Space');
		expect(await page.evaluate(() => window.quickTreeTest.opened)).toEqual(['https://example.test', 'command:settings', 'command:settings']);
		await expect(dialog).toBeVisible();
		await expect(dialog.locator('.ash-quick-tree-message')).toHaveAttribute('role', 'status');
		await page.evaluate(() => window.quickTreeTest.setValidation('An error', 3));
		await expect(dialog.getByRole('combobox')).toBeFocused();
		await expect(dialog.locator('.ash-quick-tree-message')).toHaveAttribute('role', 'alert');
		await expect(dialog.getByRole('link', { name: 'settings', exact: true })).toHaveCount(0);
	});

	for (const theme of ['dark', 'light', 'hc', 'hcLight']) {
		test(`image and toggle buttons render in tree and list toolbars (${theme})`, async () => {
			const { page } = browser;
			await page.goto(`/quickTree.html?buttons&theme=${theme}`);
			await page.getByRole('button', { name: 'Open tree', exact: true }).click();
			await page.getByRole('combobox').fill('Write');
			const toggle = page.getByRole('button', { name: 'Toggle tool', exact: true });
			await expect(toggle).toHaveAttribute('aria-pressed', 'false');
			await toggle.click();
			await expect(toggle).toHaveAttribute('aria-pressed', 'true');
			const image = page.getByRole('button', { name: 'Theme image', exact: true });
			const light = theme === 'light' || theme === 'hcLight';
			await expect(image.locator(`.ash-quick-input-button-image-${light ? 'light' : 'dark'}`)).toBeVisible();
			await expect(image.locator(`.ash-quick-input-button-image-${light ? 'dark' : 'light'}`)).toBeHidden();
			await image.focus();
			await page.evaluate(() => window.quickTreeTest.replaceItems());
			await expect(page.getByRole('combobox')).toBeFocused();
			await page.keyboard.press('Escape');
			await page.getByRole('button', { name: 'Open buttons', exact: true }).click();
			const listImage = page.getByRole('button', { name: 'Image', exact: true });
			await expect(listImage.locator(`.ash-quick-input-button-image-${light ? 'light' : 'dark'}`)).toBeVisible();
			await expect(listImage).toHaveCSS('opacity', '1');
			const listToggle = page.getByRole('button', { name: 'Toggle', exact: true });
			await listToggle.click();
			await expect(listToggle).toHaveAttribute('aria-pressed', 'true');
		});
	}

	test('invalid pin storage and deleted task identities never create selectable rows', async () => {
		const { page } = browser;
		for (const pins of ['{broken', '[42]', '{"id":"build"}', '["removed-task"]']) {
			await page.goto(`/quickTree.html?${new URLSearchParams({ pins })}`);
			await page.getByRole('button', { name: 'Open tasks', exact: true }).click();
			const dialog = page.getByRole('dialog', { name: 'Tasks', exact: true });
			await expect(dialog.getByRole('option')).toHaveCount(2);
			await expect(dialog.getByRole('button', { name: 'Unpin item', exact: true })).toHaveCount(0);
			await dialog.getByRole('combobox').press('Escape');
		}
	});
});
