import { readUserSettings, writeUserSettings } from '../../../automation/settings.js';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '../../../automation/test.js';
import type { Page } from '@playwright/test';

function handleElectronUnloadDialog(page: Page): void {
	page.on('dialog', async dialog => {
		expect(dialog.type()).toBe('beforeunload');
		// Electron already cancels the unload while the product's save dialog is
		// pending, but CDP may still report a JavaScript dialog that no longer exists.
		await dialog.dismiss().catch(error => {
			if (!(error instanceof Error) || !error.message.includes('No dialog is showing')) throw error;
		});
	});
}

test('Theme Editor opens an installed source outside the workspace and applies a saved user copy', { tag: ['@electron-app-server'] }, async ({ application, workbench }) => {
	const original = await workbench.element.evaluate(element => getComputedStyle(element).getPropertyValue('--ash-editor-background'));
	const opened = workbench.page.context().waitForEvent('page');
	await workbench.quickaccess.runCommand('workbench.action.openThemeEditor');
	const popup = await opened;
	const titlebar = popup.locator('.ash-auxiliary-titlebar');
	for (const width of [540, 800, 1440]) {
		await popup.setViewportSize({ width, height: 900 });
		await expect.poll(() => titlebar.evaluate(element => {
			const title = element.querySelector<HTMLElement>('.ash-titlebar-command-center-custom')!;
			const actions = element.querySelector<HTMLElement>('.ash-titlebar-actions')!;
			const titleBounds = title.getBoundingClientRect();
			const actionBounds = actions.getBoundingClientRect();
			const style = getComputedStyle(element);
			const bounds = element.getBoundingClientRect();
			return titleBounds.width > 0
				&& Math.abs(titleBounds.left + titleBounds.width / 2 - (bounds.left + bounds.width / 2)) <= 1
				&& titleBounds.left >= bounds.left + parseFloat(style.paddingLeft)
				&& titleBounds.right <= actionBounds.left
				&& actionBounds.right <= bounds.right - parseFloat(style.paddingRight) + 1;
		})).toBe(true);
		await expect(titlebar.getByRole('button', { name: 'Switch theme', exact: true })).toBeVisible();
		await expect(titlebar.getByRole('button', { name: 'Save and Apply', exact: true })).toBeVisible();
	}
	const search = popup.getByRole('searchbox', { name: 'Search colors', exact: true });
	await search.fill('editor.background');
	const color = popup.getByRole('textbox', { name: 'Hex color for editor.background', exact: true });
	await expect(color).toBeDisabled();
	await expect(popup.locator('.ash-theme-editor-message')).toHaveText('This theme source is read-only. Use Save as to create an editable user theme.');
	await workbench.quickaccess.runCommand('workbench.action.openThemeEditor');
	expect(workbench.page.context().pages()).toHaveLength(2);
	await workbench.menus.select(application, () => popup.locator('.ash-auxiliary-titlebar').getByRole('button', { name: 'Theme save actions', exact: true }).click(), ['Save as…']);
	const dialog = popup.getByRole('dialog', { name: 'Save as…', exact: true });
	await dialog.getByRole('textbox', { name: 'Theme name', exact: true }).fill('Shared color picker regression');
	await dialog.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(dialog).toBeHidden();
	await expect(popup.getByRole('status').filter({ hasText: /^Theme saved\.$/ })).toBeVisible();
	await search.fill('editor.background');
	await expect(color).toBeEnabled();
	await color.fill('315BC9');
	await color.press('Enter');
	await expect(popup.frameLocator('.ash-theme-editor-preview').locator('#app')).toHaveCSS('--ash-editor-background', '#315bc9');
	const trigger = popup.getByRole('button', { name: 'Choose color for editor.background', exact: true });
	await trigger.press('Enter');
	const picker = popup.getByRole('dialog', { name: 'Color picker', exact: true });
	const value = picker.getByRole('textbox', { name: 'Color value', exact: true });
	await value.fill('2F6FED'); await value.press('Enter');
	const opacity = picker.getByRole('spinbutton', { name: 'Opacity (%)', exact: true });
	await opacity.fill('40'); await opacity.press('Enter');
	await expect(color).toHaveValue('2F6FED');
	await expect(popup.getByRole('spinbutton', { name: 'Opacity for editor.background (%)', exact: true })).toHaveValue('40');
	await picker.getByRole('button', { name: 'Close', exact: true }).click();
	await expect(picker).toBeHidden();
	await expect(trigger).toBeFocused();
	await expect(workbench.element).toHaveCSS('--ash-editor-background', original);
	await popup.locator('.ash-auxiliary-titlebar').getByRole('button', { name: 'Save and Apply', exact: true }).click();
	await expect(workbench.element).toHaveCSS('--ash-editor-background', 'rgba(47, 111, 237, 0.4)');
	await popup.close({ runBeforeUnload: true });
	await expect.poll(() => popup.isClosed()).toBe(true);
	const reopening = workbench.page.context().waitForEvent('page');
	await workbench.quickaccess.runCommand('workbench.action.openThemeEditor');
	const restored = await reopening;
	await restored.getByRole('searchbox', { name: 'Search colors', exact: true }).fill('editor.background');
	await expect(restored.getByRole('textbox', { name: 'Hex color for editor.background', exact: true })).toBeEnabled();
	await expect(restored.getByRole('textbox', { name: 'Hex color for editor.background', exact: true })).toHaveValue('2F6FED');
	await expect(restored.getByRole('spinbutton', { name: 'Opacity for editor.background (%)', exact: true })).toHaveValue('40');
	if (!('windows' in application)) throw new Error('This scenario requires Desktop');
	const home = await application.evaluate(() => process.env.ASH_HOME!);
	const saved = JSON.parse(await readFile(join(home, 'themes', 'shared-color-picker-regression.json'), 'utf8'));
	expect(saved.colors['editor.background']).toBe('#2f6fed66');
});

test('Theme Editor command center switches only themes and keeps undo beside the picker', { tag: ['@electron-app-server'] }, async ({ application, workbench }) => {
	const mainCenterWidth = (await workbench.page.locator('.ash-titlebar-command-center-button').boundingBox())!.width;
	const original = await workbench.element.evaluate(element => getComputedStyle(element).getPropertyValue('--ash-editor-background'));
	const opened = workbench.page.context().waitForEvent('page');
	await workbench.quickaccess.runCommand('workbench.action.openThemeEditor');
	const popup = await opened;
	await popup.setViewportSize({ width: 1440, height: 900 });
	const titlebar = popup.locator('.ash-auxiliary-titlebar');
	const center = titlebar.getByRole('button', { name: 'Switch theme', exact: true });
	await expect(center).toHaveText('Ash Light');
	expect((await center.boundingBox())!.width).toBe(mainCenterWidth);
	const centerBounds = (await center.boundingBox())!;
	expect(Math.abs(centerBounds.x + centerBounds.width / 2 - await popup.evaluate(() => innerWidth / 2))).toBeLessThanOrEqual(1);
	const undo = titlebar.getByRole('button', { name: 'Undo', exact: true });
	const redo = titlebar.getByRole('button', { name: 'Redo', exact: true });
	await expect(undo).toBeDisabled();
	await expect(redo).toBeDisabled();
	expect((await undo.boundingBox())!.x).toBeLessThan((await redo.boundingBox())!.x);
	const redoBounds = (await redo.boundingBox())!;
	expect(redoBounds.x + redoBounds.width).toBeLessThanOrEqual((await center.boundingBox())!.x);
	await expect(titlebar.locator('.ash-titlebar-actions').getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);
	await center.press('Enter');
	const picker = popup.locator('.ash-quick-pick');
	const input = picker.getByRole('combobox', { name: 'Switch theme', exact: true });
	await expect(input).toBeFocused();
	const pickerBounds = (await picker.boundingBox())!;
	expect(Math.abs(pickerBounds.x + pickerBounds.width / 2 - centerBounds.x - centerBounds.width / 2)).toBeLessThanOrEqual(1);
	await input.fill('>');
	await expect(picker.getByRole('option')).toHaveCount(0);
	await input.fill('palette.ts');
	await expect(picker.getByRole('option')).toHaveCount(0);
	await input.fill('Ash Dark');
	await picker.getByRole('option').filter({ has: popup.getByText('Ash Dark', { exact: true }) }).click();
	await expect(center).toHaveText('Ash Dark');
	await expect(picker).toBeHidden();
	await expect(popup.locator('.ash-theme-editor')).toHaveCount(1);
	await expect(popup.locator('.ash-editor-title-control')).toBeHidden();
	expect(workbench.page.context().pages()).toHaveLength(2);
	await expect(workbench.element).toHaveCSS('--ash-editor-background', original);

	await workbench.menus.select(application, () => titlebar.getByRole('button', { name: 'Theme save actions', exact: true }).click(), ['Save as…']);
	const saveAs = popup.getByRole('dialog', { name: 'Save as…', exact: true });
	await saveAs.getByRole('textbox', { name: 'Theme name', exact: true }).fill('Theme switching regression');
	await saveAs.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(saveAs).toBeHidden();
	await expect(center).toHaveText('Theme switching regression');
	await popup.getByRole('searchbox', { name: 'Search colors', exact: true }).fill('editor.background');
	const preview = popup.frameLocator('.ash-theme-editor-preview').locator('#app');
	const color = popup.getByRole('textbox', { name: 'Hex color for editor.background', exact: true });
	const beforeEdit = '#' + (await color.inputValue()).replace(/^#/, '').toLowerCase();
	await expect(preview).toHaveCSS('--ash-editor-background', beforeEdit);
	await color.fill('#123456');
	await color.press('Enter');
	await expect(preview).toHaveCSS('--ash-editor-background', '#123456');
	await expect(undo).toBeEnabled();
	await undo.click();
	await expect(preview).toHaveCSS('--ash-editor-background', beforeEdit);
	await expect(redo).toBeEnabled();
	await redo.click();
	await expect(preview).toHaveCSS('--ash-editor-background', '#123456');
	const switchToLight = async () => {
		await center.click();
		await input.fill('Ash Light');
		await picker.getByRole('option').filter({ has: popup.getByText('Ash Light', { exact: true }) }).click();
	};
	await workbench.dialogs.confirm(application, 'Save Changes', 'Cancel', switchToLight);
	await expect(center).toHaveText('Theme switching regression');
	await expect(preview).toHaveCSS('--ash-editor-background', '#123456');
	await workbench.dialogs.confirm(application, 'Save Changes', "Don't Save", switchToLight);
	await expect(center).toHaveText('Ash Light');
	await expect(workbench.element).toHaveCSS('--ash-editor-background', original);
	expect(workbench.page.context().pages()).toHaveLength(2);
});

test('Theme Editor window close confirms unsaved changes and allows cancel, save and discard', { tag: ['@electron-ui'] }, async ({ application, workbench }) => {
	if (!('windows' in application)) throw new Error('Window close regression requires Electron');
	const opened = workbench.page.context().waitForEvent('page');
	await workbench.quickaccess.runCommand('workbench.action.openThemeEditor');
	const popup = await opened;
	handleElectronUnloadDialog(popup);
	await popup.getByRole('searchbox', { name: 'Search colors', exact: true }).fill('editor.background');
	const color = popup.getByRole('textbox', { name: 'Hex color for editor.background', exact: true });
	await color.fill('#234567');
	const windowName = await popup.evaluate(() => window.name);
	const requestClose = () => application.evaluate(({ BrowserWindow }, name) => {
		BrowserWindow.getAllWindows().find(window => window.webContents.mainFrame.name === name)!.close();
	}, windowName);

	await workbench.dialogs.confirm(application, 'Save Changes', 'Cancel', requestClose);
	await expect(color).toHaveValue('#234567');
	expect(popup.isClosed()).toBe(false);

	// Give the draft a theme file so saving on close exercises the existing file.
	await color.press('ControlOrMeta+S');
	const saveAs = popup.getByRole('dialog');
	await saveAs.getByRole('textbox', { name: 'Theme name', exact: true }).fill('Window close regression');
	await saveAs.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(popup.getByRole('status').filter({ hasText: /^Theme saved\.$/ })).toBeVisible();
	await popup.getByRole('searchbox', { name: 'Search colors', exact: true }).fill('editor.background');
	await color.fill('#345678');
	await workbench.dialogs.confirm(application, 'Save Changes', 'Save', requestClose);
	await expect.poll(() => popup.isClosed()).toBe(true);
	const home = await application.evaluate(() => process.env.ASH_HOME!);
	const saved = JSON.parse(await readFile(join(home, 'themes', 'window-close-regression.json'), 'utf8'));
	expect(saved.colors['editor.background']).toBe('#345678');

	const reopened = workbench.page.context().waitForEvent('page');
	await workbench.quickaccess.runCommand('workbench.action.openThemeEditor');
	const draft = await reopened;
	handleElectronUnloadDialog(draft);
	await draft.getByRole('searchbox', { name: 'Search colors', exact: true }).fill('editor.background');
	await draft.getByRole('textbox', { name: 'Hex color for editor.background', exact: true }).fill('#456789');
	await workbench.dialogs.confirm(application, 'Save Changes', "Don't Save", () => draft.close({ runBeforeUnload: true }));
	await expect.poll(() => draft.isClosed()).toBe(true);
});

test('Theme Editor restores one unsaved draft in its auxiliary window after restart', { tag: ['@electron-ui'] }, async ({ application, workbench, reloadWorkbench }, testInfo) => {
	const mainTabs = workbench.page.getByRole('tablist', { name: 'Open editors', exact: true }).getByRole('tab');
	const originalTabCount = await mainTabs.count();
	const opened = workbench.page.context().waitForEvent('page');
	await workbench.quickaccess.runCommand('workbench.action.openThemeEditor');
	const popup = await opened;
	await expect(popup.locator('.ash-editor-title-control')).toBeHidden();
	await expect(popup.locator('.ash-workbench-statusbar')).toBeHidden();
	const titlebar = popup.locator('.ash-auxiliary-titlebar');
	await expect(titlebar.locator('.ash-titlebar-center > .ash-titlebar-command-center')).toBeHidden();
	await expect(titlebar.getByRole('button', { name: 'Switch theme', exact: true })).toBeVisible();
	await expect(titlebar.getByRole('button', { name: 'Save and Apply', exact: true })).toBeVisible();
	await expect(titlebar.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
	await expect(titlebar.getByRole('button', { name: 'Redo', exact: true })).toBeDisabled();
	const pin = titlebar.getByRole('button', { name: 'Turn On Always on Top', exact: true });
	await expect(pin).toBeEnabled();
	await expect(titlebar.locator('.ash-titlebar-actions')).toHaveCSS('-webkit-app-region', 'no-drag');
	const pinBounds = await pin.boundingBox();
	const titlebarBounds = await titlebar.boundingBox();
	expect(pinBounds && titlebarBounds && pinBounds.x > titlebarBounds.x + titlebarBounds.width * 0.75).toBe(true);
	await pin.click();
	const unpin = titlebar.getByRole('button', { name: 'Turn Off Always on Top', exact: true });
	await expect(unpin).toBeVisible();
	await expect(titlebar.locator('.ash-titlebar-actions [role="toolbar"]')).toBeVisible();
	if (!('windows' in application)) throw new Error('The pin test requires Electron');
	const windowName = await popup.evaluate(() => window.name);
	const readPinState = () => application.evaluate(({ BrowserWindow }, name) => {
		const windows = BrowserWindow.getAllWindows();
		return { pinned: windows.find(window => window.webContents.mainFrame.name === name)?.isAlwaysOnTop(), others: windows.filter(window => window.webContents.mainFrame.name !== name).map(window => window.isAlwaysOnTop()) };
	}, windowName);
	await expect.poll(readPinState).toEqual({ pinned: true, others: [false] });
	await unpin.press('Space');
	await expect(pin).toBeVisible();
	await expect.poll(readPinState).toEqual({ pinned: false, others: [false] });
	await popup.getByRole('searchbox', { name: 'Search colors', exact: true }).fill('editor.background');
	await popup.getByRole('textbox', { name: 'Hex color for editor.background', exact: true }).fill('#234567');
	await expect(popup.frameLocator('.ash-theme-editor-preview').locator('#app')).toHaveCSS('--ash-editor-background', '#234567');
	const title = await popup.title();
	const { workbench: restored } = await reloadWorkbench();
	await expect.poll(() => restored.page.context().pages().length).toBe(2);
	const auxiliary = restored.page.context().pages().find(page => page !== restored.page)!;
	await expect(auxiliary.locator('.ash-theme-editor')).toHaveCount(1);
	await expect(auxiliary.locator('.ash-editor-title-control')).toBeHidden();
	await expect(auxiliary.locator('.ash-workbench-statusbar')).toBeHidden();
	await expect(auxiliary.locator('.ash-auxiliary-titlebar').getByRole('button', { name: 'Turn On Always on Top', exact: true })).toBeVisible();
	await expect.poll(() => auxiliary.locator('.ash-theme-editor').evaluate(element => Math.abs(element.getBoundingClientRect().bottom - window.innerHeight))).toBeLessThanOrEqual(1);
	await expect(auxiliary).toHaveTitle(title);
	await expect(auxiliary.frameLocator('.ash-theme-editor-preview').locator('#app')).toHaveCSS('--ash-editor-background', '#234567');
	await expect(auxiliary.frameLocator('.ash-theme-editor-preview').locator('.ash-workbench-statusbar')).toBeVisible();
	await expect(restored.page.getByRole('tablist', { name: 'Open editors', exact: true }).getByRole('tab')).toHaveCount(originalTabCount);
	await auxiliary.screenshot({ path: testInfo.outputPath('restored-theme-draft.png') });
});

test('Theme Editor connects its local file preview and isolates draft colors', { tag: ['@electron-app-server'] }, async ({ workbench }, testInfo) => {
	const page = workbench.page;
	const original = await workbench.element.evaluate(element => getComputedStyle(element).getPropertyValue('--ash-editor-background'));
	const opened = page.context().waitForEvent('page');
	await workbench.quickaccess.runCommand('workbench.action.openThemeEditor');
	const popup = await opened;
	const errors: string[] = [];
	popup.on('pageerror', error => errors.push(error.message));
	popup.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
	const preview = popup.frameLocator('.ash-theme-editor-preview');
	await expect(preview.locator('body')).toHaveAttribute('data-ready', 'true');
	await expect(preview.getByRole('textbox', { name: 'palette.ts', exact: true })).toBeVisible();
	await popup.getByRole('searchbox', { name: 'Search colors' }).fill('editor.background');
	await popup.getByRole('textbox', { name: 'Hex color for editor.background', exact: true }).fill('#234567');
	await expect(preview.locator('#app')).toHaveCSS('--ash-editor-background', '#234567');
	await expect(workbench.element).toHaveCSS('--ash-editor-background', original);
	for (const size of [{ width: 1100, height: 760 }, { width: 1440, height: 900 }]) {
		await popup.setViewportSize(size);
		await preview.getByRole('button', { name: 'Hide Panel', exact: true }).click();
		await preview.getByRole('button', { name: 'Toggle Panel Visibility', exact: true }).click();
		await expect(preview.getByRole('region', { name: 'Preview only', exact: true })).toBeVisible();
		await expect(preview.locator('.xterm, .ash-terminal-status')).toHaveCount(0);
	}
	const previewWindows = popup.getByRole('tablist', { name: 'Preview window', exact: true });
	await previewWindows.getByRole('tab', { name: 'Agent Window', exact: true }).click();
	await expect(preview.locator('.ash-sessions-window')).toBeVisible();
	await expect(preview.locator('body')).toHaveAttribute('data-ready', 'true');
	await popup.getByRole('searchbox', { name: 'Search colors' }).fill('sessions.activityBar.foreground');
	await popup.getByRole('textbox', { name: 'Hex color for sessions.activityBar.foreground', exact: true }).fill('#cc6600');
	await expect(preview.locator('#app')).toHaveCSS('--ash-sessions-activityBar-foreground', '#cc6600');
	await popup.screenshot({ path: testInfo.outputPath('desktop-agent-window-theme-preview.png') });
	const navigation = preview.locator('.ash-sessions-activity-content');
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
	await expect(page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true })).toHaveAttribute('aria-pressed', 'true');
	await previewWindows.getByRole('tab', { name: 'Workbench', exact: true }).click();
	await expect(preview.getByRole('textbox', { name: 'palette.ts', exact: true })).toBeVisible();
	await expect(preview.locator('#app')).toHaveCSS('--ash-editor-background', '#234567');
	await expect(popup.locator('iframe.ash-theme-editor-preview')).toHaveCount(1);
	await popup.getByRole('button', { name: 'Save', exact: true }).click();
	const dialog = popup.getByRole('dialog');
	await dialog.getByRole('textbox', { name: 'Theme name', exact: true }).fill('Desktop preview regression');
	await dialog.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(popup.getByRole('tab', { name: / Copy(?:,|$)/u })).toHaveCount(0);
	await expect(popup.locator('.ash-theme-editor-message')).toHaveText('Theme saved.');
	await expect(workbench.element).toHaveCSS('--ash-editor-background', original);
	await popup.getByRole('searchbox', { name: 'Search colors' }).fill('editor.background');
	await popup.getByRole('textbox', { name: 'Hex color for editor.background', exact: true }).fill('#345678');
	await popup.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(popup.locator('.ash-theme-editor-message')).toHaveText('Theme saved.');
	await expect(workbench.element).toHaveCSS('--ash-editor-background', original);
	await popup.getByRole('button', { name: 'Save and Apply', exact: true }).click();
	await expect(workbench.element).toHaveCSS('--ash-editor-background', '#345678');
	await Promise.all([popup.waitForEvent('close'), popup.close({ runBeforeUnload: true })]);
	const reopened = page.context().waitForEvent('page');
	await workbench.quickaccess.runCommand('workbench.action.openThemeEditor');
	const restored = await reopened;
	await expect(restored.frameLocator('.ash-theme-editor-preview').locator('#app')).toHaveCSS('--ash-editor-background', '#345678');
	await restored.getByRole('searchbox', { name: 'Search colors' }).fill('editor.background');
	await expect(restored.getByRole('textbox', { name: 'Hex color for editor.background', exact: true })).toHaveValue('#345678');
	await restored.getByRole('tablist', { name: 'Preview window', exact: true }).getByRole('tab', { name: 'Agent Window', exact: true }).click();
	await expect(restored.frameLocator('.ash-theme-editor-preview').locator('#app')).toHaveCSS('--ash-sessions-activityBar-foreground', '#cc6600');
	expect(errors).toEqual([]);
});

test('Seti extension fonts render in Explorer and editor tabs and can be switched off', { tag: ['@electron-app-server'] }, async ({ application, target, workbench }) => {
	if (!('windows' in application)) { return; }
	const home = await application.evaluate(() => process.env.ASH_HOME!);
	await cp('extensions/theme-seti', join(home, 'extensions', 'theme-seti'), { recursive: true });
	await workbench.page.reload();
	await workbench.waitForReady();
	const row = workbench.page.locator('.ash-explorer .ash-tree-row').filter({ hasText: 'main.ts' });
	const icon = row.locator('.ash-file-icon');
	await expect(icon).toHaveCount(1);
	await expect.poll(() => icon.textContent()).not.toBe('');
	await expect.poll(() => icon.evaluate(async element => {
		const family = getComputedStyle(element).fontFamily;
		await document.fonts.load('16px ' + family);
		return family.startsWith('ash-file-icon-') && document.fonts.check('16px ' + family);
	})).toBe(true);
	await row.click();
	const tab = workbench.editors.groupAt(0).tabs.filter({ hasText: 'main.ts' });
	const tabIcon = tab.locator('.ash-icon-label-icon');
	await expect(tabIcon).toHaveClass(/ash-file-icon/u);
	await expect(tabIcon).toHaveAttribute('aria-hidden', 'true');
	await expect.poll(async () => tabIcon.textContent()).toBe(await icon.textContent());
	const geometry = await tabIcon.evaluate(element => {
		const bounds = element.getBoundingClientRect();
		const text = element.parentElement!.querySelector('.ash-icon-label-text')!.getBoundingClientRect();
		return { width: bounds.width, height: bounds.height, beforeText: bounds.right <= text.left };
	});
	expect(geometry).toEqual({ width: 16, height: 16, beforeText: true });
	await expect.poll(() => tabIcon.evaluate(async element => {
		const family = getComputedStyle(element).fontFamily;
		await document.fonts.load('16px ' + family);
		return document.fonts.check('16px ' + family);
	})).toBe(true);
	const tabId = await tab.getAttribute('id');
	for (const id of [null, 'vs-seti']) {
		await (async id => {
			const snapshot = await readUserSettings(workbench.page);
			const values = JSON.parse(snapshot.content);
			values['workbench.iconTheme'] = id;
			await writeUserSettings(workbench.page, JSON.stringify(values), snapshot.revision);
		})(id);
		await expect(icon).toHaveCount(id === null ? 0 : 1);
		if (id === null) {
			await expect(tabIcon).toBeEmpty();
			await expect(tabIcon).not.toHaveClass(/is-reserved/u);
			await expect(tabIcon).toBeHidden();
		}
		else await expect.poll(() => tabIcon.textContent()).not.toBe('');
		await expect(tab).toHaveAttribute('id', tabId!);
	}
});

test('Workbench follows system color changes without reopening the window', async ({ application, workbench }) => {
	for (const scheme of ['dark', 'light'] as const) {
		await workbench.setAppearance(application, scheme);
		await expect(workbench.element).toHaveAttribute('data-color-theme', `ash-${scheme}`);
		await expect(workbench.element).toHaveCSS('color-scheme', scheme);
	}
});

test.describe('Workbench shell colors', () => {
	test.use({ openWorkspace: false });

	test('Dark and light themes color the shell and Welcome together', async ({ application, workbench }, testInfo) => {
		const titleBar = workbench.element.locator('.ash-workbench-titlebar');
		const activityBar = workbench.element.locator('.ash-workbench-activitybar');
		const selectedActivity = activityBar.locator('.ash-composite-bar-item.checked').first();
		const statusBar = workbench.element.locator('.ash-workbench-statusbar');
		const commandCenter = titleBar.locator('.ash-titlebar-command-center-button');
		const welcome = workbench.editors.groupAt(0).welcome;

		// An empty window starts with the sidebar hidden, so select a view before asserting its selected colors.
		await activityBar.getByRole('tab', { name: 'Explorer', exact: true }).click();
		await expect(activityBar.getByRole('tab', { name: 'Explorer', exact: true })).toHaveAttribute('aria-selected', 'true');

		await workbench.setAppearance(application, 'dark');
		await expect(workbench.element).toHaveAttribute('data-color-theme', 'ash-dark');
		await expect(welcome).toHaveCSS('background-color', 'rgb(30, 30, 30)');
		await expect(titleBar).toHaveCSS('background-color', 'rgb(30, 30, 30)');
		await expect(titleBar).toHaveCSS('color', 'rgb(204, 204, 204)');
		await expect(activityBar).toHaveCSS('background-color', 'rgb(37, 37, 38)');
		await expect(selectedActivity).toHaveCSS('color', 'rgb(204, 204, 204)');
		await expect.poll(() => selectedActivity.evaluate(element => getComputedStyle(element, '::after').backgroundColor)).toBe('rgb(55, 55, 55)');
		await expect(statusBar).toHaveCSS('background-color', 'rgb(30, 30, 30)');
		await welcome.hover();
		await expect(commandCenter).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		await expect(commandCenter).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
		await expect(commandCenter).toHaveCSS('color', 'rgb(204, 204, 204)');
		await expect(statusBar).toHaveCSS('color', 'rgb(204, 204, 204)');
		await commandCenter.hover();
		await expect(commandCenter).toHaveCSS('background-color', 'rgb(51, 51, 51)');
		await expect(commandCenter).toHaveCSS('border-top-color', 'rgb(69, 69, 69)');
		await welcome.hover();
		await expect(commandCenter).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		await commandCenter.focus();
		await commandCenter.press('Tab');
		await workbench.page.keyboard.press('Shift+Tab');
		await expect(commandCenter).toBeFocused();
		await expect(commandCenter).toHaveCSS('outline-style', 'solid');
		await expect(commandCenter).toHaveCSS('border-top-color', 'rgb(136, 136, 136)');
		await commandCenter.hover();
		await expect(commandCenter).toHaveCSS('background-color', 'rgb(51, 51, 51)');
		await expect(commandCenter).toHaveCSS('border-top-color', 'rgb(136, 136, 136)');
		await welcome.hover();
		await commandCenter.press('Enter');
		await expect(commandCenter).toHaveAttribute('aria-expanded', 'true');
		await expect(commandCenter).toHaveCSS('background-color', 'rgb(30, 30, 30)');
		await workbench.page.keyboard.press('Escape');
		await expect(commandCenter).toHaveAttribute('aria-expanded', 'false');
		await expect(commandCenter).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		await commandCenter.press('Tab');
		await expect(commandCenter).not.toBeFocused();
		await workbench.element.screenshot({ path: testInfo.outputPath('dark-command-center.png') });

		await workbench.setAppearance(application, 'light');
		await expect(workbench.element).toHaveAttribute('data-color-theme', 'ash-light');
		await expect(welcome).toHaveCSS('background-color', 'rgb(255, 255, 255)');
		await expect(titleBar).toHaveCSS('background-color', 'rgb(255, 255, 255)');
		await expect(activityBar).toHaveCSS('background-color', 'rgb(248, 248, 248)');
		await expect(selectedActivity).toHaveCSS('color', 'rgb(31, 31, 31)');
		await expect(statusBar).toHaveCSS('background-color', 'rgb(255, 255, 255)');
		await welcome.hover();
		await expect(commandCenter).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		await commandCenter.hover();
		await expect(commandCenter).toHaveCSS('background-color', 'rgb(235, 235, 235)');
		await expect(commandCenter).toHaveCSS('border-top-color', 'rgb(208, 208, 208)');
		await workbench.element.screenshot({ path: testInfo.outputPath('light-command-center-hover.png') });
	});
});

test('Settings modal dims and restores Electron window controls', { tag: ['@electron-ui', '@electron-app-server'] }, async ({ application, target, workbench }) => {
	if (!('windows' in application)) return;
	const hasOverlay = await application.evaluate(({ BrowserWindow }) => {
		if (process.platform === 'darwin') return false;
		const state = globalThis as unknown as { modalControlColors: { color?: string; symbolColor?: string; }[]; };
		state.modalControlColors = [];
		const window = BrowserWindow.getAllWindows()[0]!;
		const setOverlay = window.setTitleBarOverlay.bind(window);
		window.setTitleBarOverlay = options => {
			state.modalControlColors.push({ color: options.color, symbolColor: options.symbolColor });
			setOverlay(options);
		};
		return true;
	});
	test.skip(!hasOverlay, 'macOS window buttons use a separate host control');
	const page = workbench.page;
	await workbench.setAppearance(application, 'light');
	await expect(workbench.element).toHaveAttribute('data-color-theme', 'ash-light');
	await workbench.settingsEditor.openUserSettingsUI();
	await expect(page.getByRole('dialog', { name: 'Ash Settings' })).toBeVisible();
	await expect.poll(() => application.evaluate(() => {
		const colors = (globalThis as unknown as { modalControlColors: { color?: string; symbolColor?: string; }[]; }).modalControlColors.at(-1);
		return !!colors && colors.color !== '#ffffff' && colors.symbolColor !== '#424242';
	})).toBe(true);
	await page.getByRole('button', { name: 'Close Ash Settings' }).click();
	await expect(page.getByRole('dialog', { name: 'Ash Settings' })).toHaveCount(0);
	await expect.poll(() => application.evaluate(() => (globalThis as unknown as { modalControlColors: { color?: string; symbolColor?: string; }[]; }).modalControlColors.at(-1))).toEqual({ color: '#ffffff', symbolColor: '#424242' });
});

test('Desktop migrates a user theme through the file provider and applies its colors', { tag: ['@electron-ui', '@electron-app-server'] }, async ({ application, target, workbench }) => {
	if (!('windows' in application)) return;
	const hasOverlay = await application.evaluate(({ BrowserWindow }) => {
		const state = globalThis as unknown as { themeUpdates: { color?: string; symbolColor?: string; }[]; };
		state.themeUpdates = [];
		if (process.platform === 'darwin') return false;
		const window = BrowserWindow.getAllWindows()[0]!;
		const setOverlay = window.setTitleBarOverlay.bind(window);
		window.setTitleBarOverlay = options => {
			state.themeUpdates.push({ color: options.color, symbolColor: options.symbolColor });
			setOverlay(options);
		};
		return true;
	});
	const home = await application.evaluate(() => process.env.ASH_HOME!);
	await mkdir(join(home, 'themes'), { recursive: true });
	await writeFile(join(home, 'themes', 'test-migration.json'), JSON.stringify({ version: 1, id: 'test-migration', label: 'Test Migration', colorScheme: 'dark', colors: { 'editor.background': '#123456', 'titleBar.background': '#18293a', 'titleBar.actionForeground': '#fedcba' } }));
	await workbench.page.reload();
	await workbench.waitForReady();
	const source = JSON.parse(await readFile(join(home, 'themes', 'test-migration.json'), 'utf8'));
	expect(source.name).toBe('Test Migration');
	expect(source.version).toBeUndefined();
	await (async () => {
		const snapshot = await readUserSettings(workbench.page);
		const values = JSON.parse(snapshot.content);
		values['workbench.colorTheme'] = 'test-migration';
		await writeUserSettings(workbench.page, JSON.stringify(values), snapshot.revision);
	})();
	await expect.poll(() => workbench.element.evaluate(element => getComputedStyle(element).getPropertyValue('--ash-editor-background').trim())).toBe('#123456');
	await writeFile(join(home, 'themes', 'test-migration.json'), JSON.stringify({
		name: 'Test Migration', type: 'dark',
		colors: { 'editor.background': '#304050', 'titleBar.background': '#18293a', 'titleBar.actionForeground': '#fedcba' },
	}));
	await expect.poll(() => workbench.element.evaluate(element => getComputedStyle(element).getPropertyValue('--ash-editor-background').trim())).toBe('#304050');
	if (hasOverlay) {
		await expect.poll(() => application.evaluate(() => (globalThis as unknown as { themeUpdates: { color?: string; symbolColor?: string; }[]; }).themeUpdates.at(-1))).toEqual({ color: '#18293a', symbolColor: '#fedcba' });
	}
});


test('structured theme settings persist scoped colors and token rules after reload', async ({ workbench }) => {
	const page = workbench.page;
	const entries = [
		{ setting: 'workbench.colorCustomizations', key: '[Ash Dark][Ash Light]', value: { 'editor.selectionBackground': '#123456' } },
		{ setting: 'editor.tokenColorCustomizations', key: 'variables', value: { foreground: '#654321', fontStyle: 'bold' } },
		{ setting: 'editor.semanticTokenColorCustomizations', key: 'rules', value: { 'variable.readonly': { foreground: '#fedcba', italic: false } } },
	];
	const openAppearance = async (): Promise<void> => {
		await workbench.quickaccess.runCommand('workbench.action.openSettings');
		const settings = page.getByRole('dialog', { name: 'Ash Settings' });
		await settings.locator('[data-settings-group-id="workbench"]').click();
		await settings.locator('[data-settings-category-id="appearance"]').click();
	};
	await openAppearance();
	for (const entry of entries) {
		const setting = page.locator('[data-configuration-key="' + entry.setting + '"]');
		await setting.getByRole('button', { name: /^Add / }).click();
		const row = setting.locator('.ash-string-map-row').last();
		await row.locator('[data-pattern-part="key"]').fill(entry.key);
		await row.locator('[data-pattern-part="value"]').fill(JSON.stringify(entry.value));
		await row.locator('[data-pattern-part="value"]').press('Tab');
		await expect(row.locator('[data-pattern-part="value"]')).not.toHaveAttribute('aria-invalid', 'true');
		await expect(row.locator('[data-pattern-part="value"]')).toBeEnabled();
		await expect(setting.locator('.ash-string-map-row')).toHaveCount(1);
	}
	await expect.poll(() => workbench.element.evaluate(element => getComputedStyle(element).getPropertyValue('--ash-editor-selectionBackground').trim())).toBe('#123456');
	await page.getByRole('dialog', { name: 'Ash Settings' }).locator('.ash-modal-editor-close').click();
	await page.reload();
	await workbench.waitForReady();
	await openAppearance();
	for (const entry of entries) {
		const row = page.locator('[data-configuration-key="' + entry.setting + '"] .ash-string-map-row');
		await expect(row.locator('[data-pattern-part="key"]')).toHaveValue(entry.key);
		await expect(row.locator('[data-pattern-part="value"]')).toHaveValue(JSON.stringify(entry.value));
	}
	await expect.poll(() => workbench.element.evaluate(element => getComputedStyle(element).getPropertyValue('--ash-editor-selectionBackground').trim())).toBe('#123456');
});
