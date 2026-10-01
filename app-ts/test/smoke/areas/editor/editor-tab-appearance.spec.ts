import type { ElectronApplication, Locator } from '@playwright/test';
import { expect, test } from '../../../automation/test.js';

test.use({ openWorkspace: false });

test('tab command groups close and split the clicked tabs from mouse and keyboard', async ({ target, application, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'Requires the Code product');
	const page = workbench.page;
	const systemMenu = target.kind === 'electron' && process.platform === 'darwin';
	const electron = application as ElectronApplication;
	if (systemMenu) {
		await electron.evaluate(({ Menu }) => {
			const popup = Menu.prototype.popup;
			const probe = { selected: '', restore: () => { Menu.prototype.popup = popup; } };
			(globalThis as typeof globalThis & { ashTabCommandsProbe: typeof probe }).ashTabCommandsProbe = probe;
			Menu.prototype.popup = function (options) {
				if (!this.items.some(item => item.label === 'Close Editor')) return popup.call(this, options);
				const selected = this.items.find(item => item.label === probe.selected);
				if (!selected?.enabled) throw new Error(`Tab action is unavailable: ${probe.selected}`);
				selected.click();
				options?.callback?.();
			};
		});
	}
	try {
		const choose = async (tab: Locator, label: string, keyboard = false): Promise<void> => {
			if (systemMenu) {
				await electron.evaluate((_, selected) => {
					(globalThis as typeof globalThis & { ashTabCommandsProbe: { selected: string } }).ashTabCommandsProbe.selected = selected;
				}, label);
			}
			if (keyboard) {
				await tab.focus();
				await tab.press('Shift+F10');
			} else {
				await tab.click({ button: 'right' });
			}
			if (!systemMenu) await page.getByRole('menu').last().getByRole('menuitem', { name: label, exact: true }).click();
		};
		await workbench.quickaccess.runCommand('workbench.action.closeAllEditors');
		const source = workbench.editors.groupAt(0);
		const names: string[] = [];
		for (let index = 0; index < 3; index++) {
			const opened = await workbench.editors.newUntitledFile();
			await expect(source.tabs).toHaveCount(index + 1);
			names.push((await opened.getAttribute('aria-label'))!);
		}
		const first = source.element.getByRole('tab', { name: names[0], exact: true });
		const second = source.element.getByRole('tab', { name: names[1], exact: true });
		const third = source.element.getByRole('tab', { name: names[2], exact: true });
		await choose(first, 'Split Right');
		await expect(workbench.editors.groups).toHaveCount(2);
		const copied = workbench.editors.groupAt(1);
		await expect(copied.tabs).toHaveCount(1);
		await expect(copied.tabs).toHaveAttribute('aria-label', names[0]);
		await expect(third).toHaveAttribute('aria-selected', 'true');
		const originalBounds = (await source.element.boundingBox())!;
		const copiedBounds = (await copied.element.boundingBox())!;
		expect(copiedBounds.x).toBeGreaterThan(originalBounds.x);
		await choose(copied.tabs, 'Close All in Group', true);
		await expect(copied.tabs).toHaveCount(0);
		await expect(source.tabs).toHaveCount(3);
		await first.click();
		await second.click({ modifiers: ['ControlOrMeta'] });
		await choose(first, 'Split Down', true);
		await expect(workbench.editors.groups).toHaveCount(3);
		const down = workbench.editors.groups.filter({ has: page.getByRole('tab', { name: names[0], exact: true }) }).nth(1);
		const downTabs = down.getByRole('tab');
		await expect(downTabs).toHaveCount(2);
		expect(await downTabs.evaluateAll(tabs => tabs.map(tab => tab.getAttribute('aria-label')))).toEqual(names.slice(0, 2));
		const downBounds = (await down.boundingBox())!;
		expect(downBounds.y).toBeGreaterThan((await source.element.boundingBox())!.y);
		await choose(downTabs.first(), 'Close All in Group');
		await expect(workbench.editors.groups.filter({ has: page.getByRole('tab', { name: names[0], exact: true }) })).toHaveCount(1);
		await third.click();
		await choose(second, 'Close to the Right', true);
		await expect(third).toHaveCount(0);
		await expect(source.tabs).toHaveCount(2);
		await choose(first, 'Pin Editor', true);
		await expect(first).toHaveAttribute('aria-description', /Pinned tab/u);
		const dirty = await workbench.editors.newUntitledFile();
		await expect(source.tabs).toHaveCount(3);
		const dirtyName = (await dirty.getAttribute('aria-label'))!;
		const dirtyInput = source.content.getByRole('textbox', { name: dirtyName, exact: true });
		await expect(dirtyInput).toBeFocused();
		await page.keyboard.insertText('unsaved text');
		await expect(dirty).toHaveAttribute('aria-label', /unsaved changes/u);
		await choose(second, 'Close Saved');
		await expect(second).toHaveCount(0);
		await expect(first).toHaveCount(1);
		await expect(dirty).toHaveCount(1);
		await expect(source.tabs).toHaveCount(2);
	} finally {
		if (systemMenu) {
			await electron.evaluate(() => {
				const globals = globalThis as typeof globalThis & { ashTabCommandsProbe?: { restore(): void } };
				globals.ashTabCommandsProbe!.restore();
				delete globals.ashTabCommandsProbe;
			});
		}
	}
});

test('editor tabs distinguish the active document from the tab strip across themes', async ({ workbench }) => {
	const page = workbench.page;
	// Deliberately issue consecutive commands to cover the product's queued creation behavior.
	await page.keyboard.press('ControlOrMeta+N');
	await page.keyboard.press('ControlOrMeta+N');
	const group = workbench.editors.groupAt(0);
	await expect(group.tabs).toHaveCount(2);
	await expect(group.element.getByRole('tab', { name: 'Untitled-2', exact: true })).toHaveAttribute('aria-selected', 'true');
	await expect(group.content.getByRole('textbox', { name: 'Untitled-2', exact: true })).toBeFocused();
	const strip = group.title.locator('.ash-editor-tabs-and-actions');
	const active = strip.locator('.ash-tab.checked');
	const inactive = strip.locator('.ash-tab:not(.checked):not(.selected)').first();
	for (const [theme, documentColor, stripColor, inactiveColor] of [
		['Ash Dark', 'rgb(30, 30, 30)', 'rgb(37, 37, 38)', 'rgb(37, 37, 38)'],
		['Ash Light', 'rgb(255, 255, 255)', 'rgb(243, 243, 243)', 'rgb(238, 238, 238)'],
		['Ash High Contrast Dark', 'rgb(0, 0, 0)', 'rgb(0, 0, 0)', 'rgb(0, 0, 0)'],
		['Ash High Contrast Light', 'rgb(255, 255, 255)', 'rgb(255, 255, 255)', 'rgb(255, 255, 255)'],
	] as const) {
		await workbench.quickaccess.runCommand('workbench.action.selectTheme');
		const picker = page.locator('.ash-quick-pick').getByRole('combobox');
		await picker.fill(theme);
		await picker.press('Enter');
		await expect(page.locator('.ash-quick-pick')).toHaveCount(0);
		await expect(strip).toHaveCSS('background-color', stripColor);
		await expect(active).toHaveCSS('background-color', documentColor);
		await expect(inactive).toHaveCSS('background-color', inactiveColor);
		const tab = active.getByRole('tab');
		await tab.focus();
		await expect(tab).toHaveCSS('outline-style', 'solid');
		await tab.press('Alt+Enter');
		await expect(group.title.locator('.ash-sticky-editor-tabs-row .ash-tab.checked')).toHaveCSS('background-color', documentColor);
		await expect(strip).toHaveCSS('background-color', stripColor);
		await active.getByRole('button', { name: 'Unpin Editor', exact: true }).click();
	}
});

test('double-clicking Welcome keeps it in the ordinary row and preserves an explicit pin', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	const page = workbench.page;
	const welcome = page.getByRole('tab', { name: 'Welcome', exact: true });
	const ordinary = page.locator('.ash-ordinary-editor-tabs-row .ash-tab').filter({ has: welcome });
	await expect(ordinary).toHaveCount(1);
	const tabId = await welcome.getAttribute('id');
	const originalLabel = await welcome.elementHandle();
	const originalText = await welcome.locator('.ash-icon-label-text').elementHandle();
	await welcome.dblclick();
	await expect(ordinary).toHaveCount(1);
	await expect(ordinary).not.toHaveClass(/preview/u);
	await expect(page.locator('.ash-sticky-editor-tabs-row .ash-tab')).toHaveCount(0);
	await expect(welcome).toHaveAttribute('id', tabId!);
	expect(await welcome.evaluate((element, original) => element === original, originalLabel)).toBe(true);
	expect(await welcome.locator('.ash-icon-label-text').evaluate((element, original) => element === original, originalText)).toBe(true);
	await originalLabel?.dispose();
	await originalText?.dispose();
	await expect(workbench.editors.groupAt(0).content.getByRole('button').first()).toBeFocused();
	await welcome.dblclick();
	await expect(ordinary).toHaveCount(1);
	await welcome.press('Alt+Enter');
	const sticky = page.locator('.ash-sticky-editor-tabs-row .ash-tab').filter({ has: welcome });
	await expect(sticky).toHaveCount(1);
	await welcome.dblclick();
	await expect(sticky).toHaveCount(1);
	await expect(workbench.editors.groupAt(0).content.getByRole('button').first()).toBeFocused();
	await welcome.press('ControlOrMeta+k');
	await welcome.press('Shift+Enter');
	await expect(ordinary).toHaveCount(1);
});

test('pin commands follow the focused inactive tab and preserve editor selection', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	const page = workbench.page;
	const group = workbench.editors.groupAt(0);
	const firstOpened = await workbench.editors.newUntitledFile();
	const untitled = group.tabs.filter({ hasText: /Untitled-/u });
	const firstName = await firstOpened.getAttribute('aria-label');
	const secondOpened = await workbench.editors.newUntitledFile();
	await expect(untitled).toHaveCount(2);
	const secondName = await secondOpened.getAttribute('aria-label');
	const first = group.element.getByRole('tab', { name: firstName!, exact: true });
	const second = group.element.getByRole('tab', { name: secondName!, exact: true });
	await first.focus();
	await first.press('Alt+Enter');
	await expect(group.title.locator('.ash-sticky-editor-tabs-row').getByRole('tab', { name: firstName!, exact: true })).toHaveCount(1);
	await expect(second).toHaveAttribute('aria-selected', 'true');
	await expect(first).toHaveAttribute('aria-selected', 'false');
	await expect(first).toBeFocused();
	await first.press('ControlOrMeta+k');
	await first.press('Shift+Enter');
	await expect(group.title.locator('.ash-sticky-editor-tabs-row .ash-tab')).toHaveCount(0);
	await expect(second).toHaveAttribute('aria-selected', 'true');
	await expect(first).toBeFocused();
	await first.press('Alt+Enter');
	await group.title.locator('.ash-sticky-editor-tabs-row').getByRole('button', { name: 'Unpin Editor', exact: true }).click();
	await expect(group.title.locator('.ash-sticky-editor-tabs-row .ash-tab')).toHaveCount(0);
	await expect(second).toHaveAttribute('aria-selected', 'true');
	await expect(first).toHaveAttribute('aria-selected', 'false');
	await expect(first).toBeFocused();
});

test('pinned editor action stays Unpin on hover and returns the editor to the ordinary row', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	const page = workbench.page;
	await workbench.editors.newUntitledFile();

	const ordinary = page.locator('.ash-ordinary-editor-tabs-row .ash-tab.checked');
	await expect(ordinary).toHaveCount(1);
	await expect(ordinary.getByRole('tab')).toHaveAttribute('aria-label', /^Untitled-/u);
	const untitledName = await ordinary.getByRole('tab').getAttribute('aria-label');
	await expect(ordinary.locator('.ash-tab-close-action')).toHaveCount(1);
	await expect(ordinary.getByRole('tab')).toHaveAttribute('aria-description', /Pin Editor to pin/u);
	const colors = await ordinary.evaluate(element => {
		const reference = document.createElement('span');
		reference.style.background = 'var(--ash-editor-background)';
		element.append(reference);
		const editor = getComputedStyle(reference).backgroundColor;
		reference.remove();
		return { tab: getComputedStyle(element).backgroundColor, editor };
	});
	expect(colors.tab).toBe(colors.editor);
	await expect(ordinary).toHaveCSS('border-bottom-width', '0px');
	const closeGeometry = await ordinary.locator('.ash-tab-close-action button').evaluate(button => {
		const rect = button.getBoundingClientRect();
		const icon = button.querySelector('.ash-icon')!.getBoundingClientRect();
		return { width: rect.width, height: rect.height, iconWidth: icon.width, iconHeight: icon.height, left: icon.left - rect.left, right: rect.right - icon.right };
	});
	expect(closeGeometry).toEqual({ width: 22, height: 22, iconWidth: 16, iconHeight: 16, left: 3, right: 3 });

	await ordinary.getByRole('tab').press('Alt+Enter');
	const sticky = page.locator('.ash-sticky-editor-tabs-row .ash-tab.checked');
	await expect(sticky).toHaveCount(1);
	await expect(sticky).toHaveCSS('border-bottom-width', '0px');
	const unpin = sticky.getByRole('button', { name: 'Unpin Editor', exact: true });
	await expect(sticky.locator('.ash-tab-close-action')).toHaveCount(0);
	await expect(unpin.locator('svg')).toHaveAttribute('data-ash-icon-id', 'pinned');
	await expect(sticky.getByRole('tab')).toHaveAttribute('aria-description', /Unpin Editor to unpin/u);
	await page.mouse.move(0, 0);
	await sticky.getByRole('tab').blur();
	await expect(unpin).toBeVisible();
	await sticky.getByRole('tab').hover();
	await unpin.hover();
	await expect(unpin.locator('svg')).toBeVisible();
	await expect(unpin.locator('svg')).toHaveAttribute('data-ash-icon-id', 'pinned');
	await expect(sticky.getByRole('button', { name: /^Close /u })).toHaveCount(0);
	await unpin.click();
	await expect(page.locator('.ash-sticky-editor-tabs-row .ash-tab')).toHaveCount(0);
	await expect(ordinary.getByRole('tab')).toHaveAttribute('aria-label', untitledName!);
	await ordinary.getByRole('tab').press('Alt+Enter');
	await unpin.focus();
	await unpin.press('Enter');
	await expect(page.locator('.ash-sticky-editor-tabs-row .ash-tab')).toHaveCount(0);
	await expect(ordinary.getByRole('tab')).toBeFocused();
	await ordinary.locator('.ash-tab-close-action button').click();
	await expect(page.getByRole('tab', { name: untitledName! })).toHaveCount(0);
});

test('editor tab menu targets the clicked tab and opens from the keyboard', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'This scenario requires the Code product');
	test.skip(target.kind === 'electron' && process.platform === 'darwin', 'macOS displays this menu through Electron');
	const page = workbench.page;
	const createUntitled = (): Promise<Locator> => workbench.editors.newUntitledFile(async () => {
		await page.getByRole('button', { name: 'Application menu' }).click();
		await page.getByRole('menu').first().getByRole('menuitem', { name: 'File' }).hover();
		await page.getByRole('menu').last().getByRole('menuitem', { name: 'New Untitled Text Editor' }).click();
	});
	const firstOpened = await createUntitled();
	const group = workbench.editors.groupAt(0);
	const untitledTabs = group.tabs.filter({ hasText: /Untitled-/u });
	const firstName = await firstOpened.getAttribute('aria-label');
	const remainingOpened = await createUntitled();
	await expect(untitledTabs).toHaveCount(2);
	const remainingName = await remainingOpened.getAttribute('aria-label');
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
	const firstOpened = await workbench.editors.newUntitledFile();
	const untitledTabs = group.tabs.filter({ hasText: /Untitled-/u });
	const firstName = await firstOpened.getAttribute('aria-label');
	const remainingOpened = await workbench.editors.newUntitledFile();
	await expect(untitledTabs).toHaveCount(2);
	const remainingName = await remainingOpened.getAttribute('aria-label');

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


test('editor icon setting updates existing tabs and survives pinning', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'Requires the Code product');
	const page = workbench.page;
	await workbench.editors.newUntitledFile();
	const group = workbench.editors.groupAt(0);
	await expect(group.tabs.filter({ hasText: /Untitled-/u }).locator('.ash-icon-label-icon')).toBeHidden();
	await workbench.quickaccess.runCommand('workbench.action.openWelcome');
	const tab = group.tabs.filter({ hasText: 'Welcome' });
	const icon = tab.locator('.ash-icon-label-icon');
	await expect(icon).toHaveAttribute('aria-hidden', 'true');
	await expect(icon).toHaveClass(/is-reserved/u);
	await expect(icon.locator('svg')).toHaveAttribute('data-ash-icon-id', 'home');
	const tabId = await tab.getAttribute('id');
	await workbench.quickaccess.runCommand('workbench.action.openSettings');
	const settings = page.locator('.ash-settings-editor');
	await settings.locator('[data-settings-category-id="editor"]').click();
	await settings.getByRole('searchbox', { name: 'Search settings' }).fill('workbench.editor.showIcons');
	const toggle = settings.locator('[data-configuration-key="workbench.editor.showIcons"]');
	await expect(toggle).toBeChecked();
	await toggle.focus();
	await toggle.press('Space');
	await expect(toggle).not.toBeChecked();
	await expect(icon).not.toHaveClass(/is-reserved/u);
	await expect(icon).toBeHidden();
	await expect(tab).toHaveAttribute('id', tabId!);
	await toggle.press('Space');
	await expect(toggle).toBeChecked();
	await expect(icon).toHaveClass(/is-reserved/u);
	await page.locator('.ash-modal-editor-close').click();
	await tab.press('Alt+Enter');
	await expect(group.title.locator('.ash-sticky-editor-tabs-row .ash-tab-label .ash-icon-label-icon')).toHaveClass(/is-reserved/u);
});
