import type { ElectronApplication } from '@playwright/test';
import { expect, test } from '../../../automation/test.js';

test.use({ openWorkspace: false });

test('editor tab uses the editor surface and shares its pin and close slot', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	const page = workbench.page;
	await page.getByRole('button', { name: 'Application menu' }).click();
	await page.getByRole('menu').first().getByRole('menuitem', { name: 'File' }).hover();
	await page.getByRole('menu').last().getByRole('menuitem', { name: 'New Untitled Text Editor' }).click();

	const ordinary = page.locator('.ash-ordinary-editor-tabs-row .ash-tab.checked');
	await expect(ordinary).toHaveCount(1);
	const untitledName = await ordinary.getByRole('tab').getAttribute('aria-label');
	expect(untitledName).toMatch(/^Untitled-/u);
	await expect(ordinary.locator('.ash-tab-close-action')).toHaveCount(1);
	await expect(ordinary.locator('.ash-tab-close-indicator')).toHaveCount(0);
	await expect(ordinary.getByRole('tab')).toHaveAttribute('aria-description', /Alt\+Enter to pin/u);
	const colors = await ordinary.evaluate(element => {
		const reference = document.createElement('span');
		reference.style.background = 'var(--ash-editor-background)';
		element.append(reference);
		const editor = getComputedStyle(reference).backgroundColor;
		reference.remove();
		return { tab: getComputedStyle(element).backgroundColor, editor };
	});
	expect(colors.tab).toBe(colors.editor);

	await ordinary.getByRole('tab').dblclick();
	const sticky = page.locator('.ash-sticky-editor-tabs-row .ash-tab.checked');
	await expect(sticky).toHaveCount(1);
	const close = sticky.locator('.ash-tab-close-action');
	await expect(close).toHaveCount(1);
	await expect(close.locator('button > .ash-tab-close-indicator')).toHaveCount(1);
	await expect(sticky.getByRole('tab')).toHaveAttribute('aria-description', /Alt\+Enter to unpin/u);
	await page.mouse.move(0, 0);
	await sticky.getByRole('tab').blur();
	await expect(close.locator('.ash-tab-close-indicator')).toBeVisible();
	await sticky.getByRole('tab').hover();
	await expect(close.locator('.ash-tab-close-indicator')).toBeHidden();
	await expect(close.locator('button')).toBeVisible();
	await sticky.getByRole('tab').press('Alt+Enter');
	await expect(page.locator('.ash-sticky-editor-tabs-row .ash-tab')).toHaveCount(0);
	await ordinary.locator('.ash-tab-close-action button').click();
	await expect(page.getByRole('tab', { name: untitledName! })).toHaveCount(0);
});

test('editor tab menu targets the clicked tab and opens from the keyboard', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	test.skip(target.kind === 'electron' && process.platform === 'darwin', 'macOS displays this menu through Electron');
	const page = workbench.page;
	const createUntitled = async (): Promise<void> => {
		await page.getByRole('button', { name: 'Application menu' }).click();
		await page.getByRole('menu').first().getByRole('menuitem', { name: 'File' }).hover();
		await page.getByRole('menu').last().getByRole('menuitem', { name: 'New Untitled Text Editor' }).click();
	};
	await createUntitled();
	const group = workbench.editors.groupAt(0);
	const untitledTabs = group.tabs.filter({ hasText: /Untitled-/u });
	const firstName = await untitledTabs.last().getAttribute('aria-label');
	await createUntitled();
	await expect(untitledTabs).toHaveCount(2);
	const remainingName = await untitledTabs.last().getAttribute('aria-label');
	const first = group.element.getByRole('tab', { name: firstName! });
	const remaining = group.element.getByRole('tab', { name: remainingName! });
	await first.click({ button: 'right' });
	const menu = page.getByRole('menu').last();
	await expect(menu.getByRole('menuitem', { name: 'Close Editor' })).toBeVisible();
	await menu.getByRole('menuitem', { name: 'Close Editor' }).click();
	await expect(first).toHaveCount(0);
	await expect(remaining).toHaveCount(1);
	await remaining.focus();
	await remaining.press('Shift+F10');
	await expect(menu.getByRole('menuitem', { name: 'Pin Editor' })).toBeVisible();
	await menu.getByRole('menuitem', { name: 'Pin Editor' }).click();
	await expect(remaining).toHaveAttribute('aria-description', /Pinned tab/u);
	await createUntitled();
	await expect(untitledTabs).toHaveCount(2);
	await remaining.click({ button: 'right' });
	await menu.getByRole('menuitem', { name: 'Close Other Editors' }).click();
	await expect(group.tabs).toHaveCount(1);
	await expect(remaining).toHaveCount(1);
});

test('macOS Electron editor tab menu targets mouse and keyboard actions', async ({ target, application, workbench }) => {
	test.skip(target.kind !== 'electron' || process.platform !== 'darwin' || target.workbenchMode !== 'code', 'This scenario requires the macOS Code desktop product');
	const electron = application as ElectronApplication;
	const page = workbench.page;
	const group = workbench.editors.groupAt(0);
	await page.keyboard.press('ControlOrMeta+N');
	const untitledTabs = group.tabs.filter({ hasText: /Untitled-/u });
	const firstName = await untitledTabs.last().getAttribute('aria-label');
	await page.keyboard.press('ControlOrMeta+N');
	await expect(untitledTabs).toHaveCount(2);
	const remainingName = await untitledTabs.last().getAttribute('aria-label');

	// Electron menus are outside the renderer DOM; capture the popup and select its actions in the main process.
	await electron.evaluate(({ Menu }) => {
		const probe = { menus: [] as string[][], selected: 'Close Editor' as string | undefined };
		(globalThis as typeof globalThis & { ashEditorTabMenuProbe?: typeof probe }).ashEditorTabMenuProbe = probe;
		const popup = Menu.prototype.popup;
		Menu.prototype.popup = function (options) {
			const labels = this.items.map(item => item.label);
			if (!labels.includes('Close Editor')) return popup.call(this, options);
			probe.menus.push(labels);
			if (probe.selected) this.items.find(item => item.label === probe.selected)?.click();
			probe.selected = undefined;
			options?.callback?.();
		};
	});

	const first = group.element.getByRole('tab', { name: firstName! });
	const remaining = group.element.getByRole('tab', { name: remainingName! });
	await first.click({ button: 'right' });
	await expect.poll(() => electron.evaluate(() => (globalThis as typeof globalThis & { ashEditorTabMenuProbe?: { menus: string[][] } }).ashEditorTabMenuProbe?.menus.length)).toBe(1);
	await expect(first).toHaveCount(0);
	await expect(remaining).toHaveCount(1);

	await electron.evaluate(() => {
		(globalThis as typeof globalThis & { ashEditorTabMenuProbe?: { selected?: string } }).ashEditorTabMenuProbe!.selected = 'Pin Editor';
	});
	await remaining.focus();
	await remaining.press('Shift+F10');
	await expect.poll(() => electron.evaluate(() => (globalThis as typeof globalThis & { ashEditorTabMenuProbe?: { menus: string[][] } }).ashEditorTabMenuProbe?.menus.length)).toBe(2);
	await expect(remaining).toHaveAttribute('aria-description', /Pinned tab/u);
});
