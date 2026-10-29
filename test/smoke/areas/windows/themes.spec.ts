import { readUserSettings, writeUserSettings } from '../../../automation/settings.js';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '../../../automation/test.js';
import { Editor } from '../../../automation/editor.js';

test('Theme Editor opens an installed source outside the workspace and applies a saved user copy', { tag: ['@electron-app-server'] }, async ({ application, workbench }) => {
	const original = await workbench.element.evaluate(element => getComputedStyle(element).getPropertyValue('--ash-editor-background'));
	const popup = workbench.page;
	const originalPages = popup.context().pages().length;
	await workbench.quickaccess.runCommand('workbench.action.openThemeEditor');
	const titlebar = workbench.editors.groupAt(0).title;
	await expect(popup.locator('.ash-theme-editor')).toBeVisible();
	await expect(titlebar).toBeVisible();
	await expect(popup.locator('.ash-workbench-statusbar')).toBeVisible();
	for (const width of [800, 1100, 1440]) {
		await popup.setViewportSize({ width, height: 900 });
		await expect(titlebar.getByRole('button', { name: 'Open Theme…', exact: true })).toBeVisible();
		await expect(titlebar.getByRole('button', { name: 'Save and Apply', exact: true })).toBeVisible();
		await expect.poll(() => titlebar.locator('.ash-dropdown-with-primary-action-view-item').evaluate(element => {
			const main = element.querySelector('.ash-dropdown-with-primary-primary button')!.getBoundingClientRect();
			const arrow = element.querySelector('.ash-dropdown-with-primary-dropdown button')!.getBoundingClientRect();
			const actionSize = parseFloat(getComputedStyle(element).getPropertyValue('--ash-toolbar-actionSize'));
			return {
				mainHeight: main.height,
				arrowHeight: arrow.height,
				arrowWidth: arrow.width,
				actionSize,
				mainHasSize: main.height >= actionSize,
				matchingHeight: Math.abs(main.height - arrow.height) < 0.5,
				squareArrow: Math.abs(arrow.width - arrow.height) < 0.5,
			};
		})).toMatchObject({ mainHasSize: true, matchingHeight: true, squareArrow: true });
		await expect(titlebar.getByRole('button', { name: 'Open Theme (JSON)', exact: true })).toBeVisible();
	}
	const search = popup.getByRole('searchbox', { name: 'Search colors', exact: true });
	await search.fill('editor.background');
	const color = popup.getByRole('textbox', { name: 'Hex color for editor.background', exact: true });
	await expect(color).toBeDisabled();
	await expect(popup.locator('.ash-theme-editor-message')).toHaveText('This theme source is read-only. Use Save as to create an editable user theme.');
	const source = new Editor(popup.locator('.ash-theme-editor-json'));
	await titlebar.getByRole('button', { name: 'Open Theme (JSON)', exact: true }).press('Enter');
	await expect(source.input).toBeFocused();
	await source.waitForEditorContents(text => text.includes('editor.background'));
	await expect(search).toBeHidden();
	await titlebar.getByRole('button', { name: 'Open Theme (UI)', exact: true }).press('Space');
	await expect(search).toBeFocused();
	await expect(search).toHaveValue('editor.background');
	await workbench.quickaccess.runCommand('workbench.action.openThemeEditor');
	expect(popup.context().pages()).toHaveLength(originalPages);
	await expect(popup.locator('.ash-theme-editor')).toHaveCount(1);
	await workbench.menus.select(application, () => titlebar.getByRole('button', { name: 'Theme save actions', exact: true }).click(), ['Save as…']);
	const dialog = popup.getByRole('dialog', { name: 'Save as…', exact: true });
	await dialog.getByRole('textbox', { name: 'Theme name', exact: true }).fill('Shared color picker regression');
	await dialog.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(dialog).toBeHidden();
	await expect(popup.getByRole('status').filter({ hasText: /^Theme saved\.$/ })).toBeVisible();
	const savedTab = workbench.editors.groupAt(0).tabs.filter({ hasText: 'shared-color-picker-regression.json' });
	await expect(savedTab).toHaveAttribute('aria-selected', 'true');
	await search.fill('editor.background');
	await expect(color).toBeEnabled();
	await color.fill('315BC9');
	await color.press('Enter');
	await expect(popup.frameLocator('.ash-theme-editor-preview').locator('#app')).toHaveCSS('--ash-editor-background', '#315bc9');
	await expect(savedTab).toHaveAttribute('aria-label', /unsaved/i);
	await workbench.menus.select(application, () => titlebar.getByRole('button', { name: 'Theme save actions', exact: true }).click(), ['Save']);
	await expect(savedTab).not.toHaveAttribute('aria-label', /unsaved/i);
	await expect(workbench.element).toHaveCSS('--ash-editor-background', original);
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
	await titlebar.getByRole('button', { name: 'Open Theme (JSON)', exact: true }).press('Enter');
	await expect(source.input).toBeFocused();
	await source.input.press('ControlOrMeta+a');
	await popup.keyboard.insertText(JSON.stringify({
		name: 'Shared color picker regression',
		type: 'light',
		colors: { 'editor.background': '#123456' },
	}, null, 2));
	await expect(popup.frameLocator('.ash-theme-editor-preview').locator('#app')).toHaveCSS('--ash-editor-background', '#123456');
	await titlebar.getByRole('button', { name: 'Open Theme (UI)', exact: true }).click();
	await expect(color).toHaveValue('123456');
	await titlebar.getByRole('button', { name: 'Undo', exact: true }).click();
	await expect(color).toHaveValue('2F6FED');
	await expect(popup.getByRole('spinbutton', { name: 'Opacity for editor.background (%)', exact: true })).toHaveValue('40');
	await expect(workbench.element).toHaveCSS('--ash-editor-background', original);
	await titlebar.getByRole('button', { name: 'Save and Apply', exact: true }).click();
	await expect(workbench.element).toHaveCSS('--ash-editor-background', 'rgba(47, 111, 237, 0.4)');
	await workbench.quickaccess.runCommand('workbench.action.closeActiveEditor');
	await expect(popup.locator('.ash-theme-editor')).toHaveCount(0);
	await workbench.quickaccess.runCommand('workbench.action.openThemeEditor');
	const restored = popup;
	await restored.getByRole('searchbox', { name: 'Search colors', exact: true }).fill('editor.background');
	await expect(restored.getByRole('textbox', { name: 'Hex color for editor.background', exact: true })).toBeEnabled();
	await expect(restored.getByRole('textbox', { name: 'Hex color for editor.background', exact: true })).toHaveValue('2F6FED');
	await expect(restored.getByRole('spinbutton', { name: 'Opacity for editor.background (%)', exact: true })).toHaveValue('40');
	if (!('windows' in application)) throw new Error('This scenario requires Desktop');
	const home = await application.evaluate(() => process.env.ASH_HOME!);
	const saved = JSON.parse(await readFile(join(home, 'themes', 'shared-color-picker-regression.json'), 'utf8'));
	expect(saved.colors['editor.background']).toBe('#2f6fed66');
});

test('Theme Editor opens themes in workspace tabs and preserves edits while switching', { tag: ['@electron-app-server'] }, async ({ application, workbench }) => {
	const page = workbench.page;
	const originalPages = page.context().pages().length;
	const original = await workbench.element.evaluate(element => getComputedStyle(element).getPropertyValue('--ash-editor-background'));
	await workbench.quickaccess.runCommand('workbench.action.openThemeEditor');
	const titlebar = workbench.editors.groupAt(0).title;
	const open = titlebar.getByRole('button', { name: 'Open Theme…', exact: true });
	await open.press('Enter');
	const picker = page.locator('.ash-quick-pick');
	const input = picker.getByRole('combobox', { name: 'Open Theme…', exact: true });
	await expect(input).toBeFocused();
	await input.fill('>');
	await expect(picker.getByRole('option')).toHaveCount(0);
	await input.fill('palette.ts');
	await expect(picker.getByRole('option')).toHaveCount(0);
	await input.fill('Ash Dark');
	await picker.getByRole('option').filter({ has: page.getByText('Ash Dark', { exact: true }) }).click();
	await expect(picker).toBeHidden();
	await expect(workbench.editors.groupAt(0).tabs.filter({ hasText: 'light.json' })).toHaveCount(1);
	await expect(workbench.editors.groupAt(0).tabs.filter({ hasText: 'dark.json' })).toHaveCount(1);
	await workbench.menus.select(application, () => titlebar.getByRole('button', { name: 'Theme save actions', exact: true }).click(), ['Save as…']);
	const saveAs = page.getByRole('dialog', { name: 'Save as…', exact: true });
	await saveAs.getByRole('textbox', { name: 'Theme name', exact: true }).fill('Theme switching regression');
	await saveAs.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(saveAs).toBeHidden();
	await expect(page.getByRole('status').filter({ hasText: /^Theme saved\.$/ })).toBeVisible();
	const search = page.getByRole('searchbox', { name: 'Search colors', exact: true });
	await search.fill('editor.background');
	const color = page.getByRole('textbox', { name: 'Hex color for editor.background', exact: true });
	const preview = page.locator('.ash-theme-editor:visible').frameLocator('.ash-theme-editor-preview').locator('#app');
	const beforeEdit = '#' + (await color.inputValue()).replace(/^#/, '').toLowerCase();
	await color.fill('#123456');
	await color.press('Enter');
	await expect(preview).toHaveCSS('--ash-editor-background', '#123456');
	await titlebar.getByRole('button', { name: 'Undo', exact: true }).click();
	await expect(preview).toHaveCSS('--ash-editor-background', beforeEdit);
	await titlebar.getByRole('button', { name: 'Redo', exact: true }).click();
	await expect(preview).toHaveCSS('--ash-editor-background', '#123456');
	const draft = workbench.editors.groupAt(0).tabs.filter({ hasText: 'theme-switching-regression.json' });
	await expect(draft).toHaveAttribute('aria-label', /unsaved/i);
	await open.click();
	await input.fill('Ash Light');
	await picker.getByRole('option').filter({ has: page.getByText('Ash Light', { exact: true }) }).click();
	await expect(workbench.editors.groupAt(0).tabs.filter({ hasText: 'light.json' })).toHaveAttribute('aria-selected', 'true');
	await expect(draft).toHaveAttribute('aria-label', /unsaved/i);
	await draft.click();
	await expect(color).toHaveValue('123456');
	await expect(preview).toHaveCSS('--ash-editor-background', '#123456');
	await expect(workbench.element).toHaveCSS('--ash-editor-background', original);
	expect(page.context().pages()).toHaveLength(originalPages);
});

test('Theme Editor tab close confirms unsaved changes and allows cancel, save and discard', { tag: ['@electron-app-server'] }, async ({ application, workbench }) => {
	const page = workbench.page;
	await workbench.quickaccess.runCommand('workbench.action.openThemeEditor');
	const titlebar = workbench.editors.groupAt(0).title;
	await workbench.menus.select(application, () => titlebar.getByRole('button', { name: 'Theme save actions', exact: true }).click(), ['Save as…']);
	const saveAs = page.getByRole('dialog', { name: 'Save as…', exact: true });
	await saveAs.getByRole('textbox', { name: 'Theme name', exact: true }).fill('Tab close regression');
	await saveAs.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(saveAs).toBeHidden();
	await expect(page.getByRole('status').filter({ hasText: /^Theme saved\.$/ })).toBeVisible();
	const search = page.getByRole('searchbox', { name: 'Search colors', exact: true });
	await search.fill('editor.background');
	const color = page.getByRole('textbox', { name: 'Hex color for editor.background', exact: true });
	await color.fill('#234567');
	const close = () => workbench.quickaccess.runCommand('workbench.action.closeActiveEditor');
	await workbench.dialogs.confirm(application, 'Save Changes', 'Cancel', close);
	await expect(color).toHaveValue('234567');
	await workbench.dialogs.confirm(application, 'Save Changes', 'Save', close);
	await expect(page.locator('.ash-theme-editor')).toHaveCount(0);
	if (!('windows' in application)) throw new Error('Theme file verification requires Desktop');
	const home = await application.evaluate(() => process.env.ASH_HOME!);
	const path = join(home, 'themes', 'tab-close-regression.json');
	const saved = JSON.parse(await readFile(path, 'utf8'));
	expect(saved.colors['editor.background']).toBe('#234567');
	await workbench.quickaccess.runCommand('workbench.action.openThemeEditor');
	await titlebar.getByRole('button', { name: 'Open Theme…', exact: true }).click();
	const picker = page.locator('.ash-quick-pick');
	await picker.getByRole('combobox', { name: 'Open Theme…', exact: true }).fill('Tab close regression');
	await picker.getByRole('option').filter({ has: page.getByText('Tab close regression', { exact: true }) }).click();
	await page.getByRole('searchbox', { name: 'Search colors', exact: true }).fill('editor.background');
	await page.getByRole('textbox', { name: 'Hex color for editor.background', exact: true }).fill('#456789');
	await workbench.dialogs.confirm(application, 'Save Changes', "Don't Save", close);
	expect(JSON.parse(await readFile(path, 'utf8')).colors['editor.background']).toBe('#234567');
});

test('Theme Editor restores a workspace draft and can move it to another window', { tag: ['@electron-app-server'] }, async ({ application, workbench, reloadWorkbench }, testInfo) => {
	const page = workbench.page;
	await workbench.quickaccess.runCommand('workbench.action.openThemeEditor');
	const titlebar = workbench.editors.groupAt(0).title;
	await workbench.menus.select(application, () => titlebar.getByRole('button', { name: 'Theme save actions', exact: true }).click(), ['Save as…']);
	const saveAs = page.getByRole('dialog', { name: 'Save as…', exact: true });
	await saveAs.getByRole('textbox', { name: 'Theme name', exact: true }).fill('Restored theme draft');
	await saveAs.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(saveAs).toBeHidden();
	await expect(page.getByRole('status').filter({ hasText: /^Theme saved\.$/ })).toBeVisible();
	await page.getByRole('searchbox', { name: 'Search colors', exact: true }).fill('editor.background');
	await page.getByRole('textbox', { name: 'Hex color for editor.background', exact: true }).fill('#234567');
	const { workbench: restored } = await reloadWorkbench();
	const theme = restored.page.locator('.ash-theme-editor');
	await expect(theme).toHaveCount(1);
	await expect(theme.frameLocator('.ash-theme-editor-preview').locator('#app')).toHaveCSS('--ash-editor-background', '#234567');
	await expect(restored.editors.groupAt(0).tabs.filter({ hasText: 'restored-theme-draft.json' })).toHaveCount(1);
	expect(restored.page.context().pages()).toHaveLength(1);
	const opened = restored.page.context().waitForEvent('page');
	await restored.quickaccess.runCommand('workbench.action.moveEditorToNewWindow');
	const auxiliary = await opened;
	await expect(auxiliary.locator('.ash-theme-editor')).toHaveCount(1);
	await expect(auxiliary.locator('.ash-editor-title-control')).toBeVisible();
	await expect(auxiliary.frameLocator('.ash-theme-editor-preview').locator('#app')).toHaveCSS('--ash-editor-background', '#234567');
	await expect(theme).toHaveCount(0);
	await auxiliary.getByRole('searchbox', { name: 'Search colors', exact: true }).fill('editor.background');
	await auxiliary.getByRole('textbox', { name: 'Hex color for editor.background', exact: true }).fill('#345678');
	await auxiliary.getByRole('textbox', { name: 'Hex color for editor.background', exact: true }).press('Enter');
	await expect(auxiliary.frameLocator('.ash-theme-editor-preview').locator('#app')).toHaveCSS('--ash-editor-background', '#345678');
	await auxiliary.evaluate(() => window.close());
	await expect.poll(() => auxiliary.isClosed()).toBe(true);
	await expect(theme).toHaveCount(1);
	await expect(theme.frameLocator('.ash-theme-editor-preview').locator('#app')).toHaveCSS('--ash-editor-background', '#345678');
	await restored.page.screenshot({ path: testInfo.outputPath('restored-workspace-theme-draft.png') });
});

test('Theme Editor connects its local file preview and isolates draft colors', { tag: ['@electron-app-server'] }, async ({ application, workbench }, testInfo) => {
	const page = workbench.page;
	const original = await workbench.element.evaluate(element => getComputedStyle(element).getPropertyValue('--ash-editor-background'));
	await workbench.quickaccess.runCommand('workbench.action.openThemeEditor');
	const popup = page;
	await workbench.menus.select(application, () => workbench.editors.groupAt(0).title.getByRole('button', { name: 'Theme save actions', exact: true }).click(), ['Save as…']);
	const saveAs = page.getByRole('dialog', { name: 'Save as…', exact: true });
	await saveAs.getByRole('textbox', { name: 'Theme name', exact: true }).fill('Desktop preview regression');
	await saveAs.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(saveAs).toBeHidden();
	await expect(page.getByRole('status').filter({ hasText: /^Theme saved\.$/ })).toBeVisible();
	const errors: string[] = [];
	popup.on('pageerror', error => errors.push(error.message));
	popup.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
	const editor = popup.locator('.ash-theme-editor:visible');
	const preview = editor.frameLocator('.ash-theme-editor-preview');
	await expect(preview.locator('body')).toHaveAttribute('data-ready', 'true');
	await expect(preview.getByRole('textbox', { name: 'palette.ts', exact: true })).toBeVisible();
	await popup.getByRole('searchbox', { name: 'Search colors' }).fill('editor.background');
	await popup.getByRole('textbox', { name: 'Hex color for editor.background', exact: true }).fill('#234567');
	await popup.getByRole('textbox', { name: 'Hex color for editor.background', exact: true }).press('Enter');
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
	await popup.getByRole('textbox', { name: 'Hex color for sessions.activityBar.foreground', exact: true }).press('Enter');
	await expect(preview.locator('#app')).toHaveCSS('--ash-sessions-activityBar-foreground', '#cc6600');
	await popup.screenshot({ path: testInfo.outputPath('desktop-agent-window-theme-preview.png') });
	await previewWindows.getByRole('tab', { name: 'Workbench', exact: true }).click();
	await expect(preview.getByRole('textbox', { name: 'palette.ts', exact: true })).toBeVisible();
	await expect(preview.locator('#app')).toHaveCSS('--ash-editor-background', '#234567');
	await expect(editor.locator('iframe.ash-theme-editor-preview')).toHaveCount(1);
	await workbench.quickaccess.runCommand('workbench.action.files.save');
	await expect(popup.getByRole('tab', { name: / Copy(?:,|$)/u })).toHaveCount(0);
	await expect(editor.locator('.ash-theme-editor-message')).toHaveText('Theme saved.');
	await expect(workbench.element).toHaveCSS('--ash-editor-background', original);
	await popup.getByRole('searchbox', { name: 'Search colors' }).fill('editor.background');
	await popup.getByRole('textbox', { name: 'Hex color for editor.background', exact: true }).fill('#345678');
	await popup.getByRole('textbox', { name: 'Hex color for editor.background', exact: true }).press('Enter');
	await workbench.quickaccess.runCommand('workbench.action.files.save');
	await expect(editor.locator('.ash-theme-editor-message')).toHaveText('Theme saved.');
	await expect(workbench.element).toHaveCSS('--ash-editor-background', original);
	await popup.getByRole('button', { name: 'Save and Apply', exact: true }).click();
	await expect(workbench.element).toHaveCSS('--ash-editor-background', '#345678');
	await workbench.quickaccess.runCommand('workbench.action.closeActiveEditor');
	await workbench.quickaccess.runCommand('workbench.action.openThemeEditor');
	const restored = page;
	await expect(restored.locator('.ash-theme-editor:visible').frameLocator('.ash-theme-editor-preview').locator('#app')).toHaveCSS('--ash-editor-background', '#345678');
	await restored.getByRole('searchbox', { name: 'Search colors' }).fill('editor.background');
	await expect(restored.getByRole('textbox', { name: 'Hex color for editor.background', exact: true })).toHaveValue('345678');
	await restored.getByRole('tablist', { name: 'Preview window', exact: true }).getByRole('tab', { name: 'Agent Window', exact: true }).click();
	await expect(restored.locator('.ash-theme-editor:visible').frameLocator('.ash-theme-editor-preview').locator('#app')).toHaveCSS('--ash-sessions-activityBar-foreground', '#cc6600');
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
		await expect(commandCenter).toHaveCSS('background-color', 'rgb(43, 43, 43)');
		await expect(commandCenter).toHaveCSS('border-top-color', 'rgb(69, 69, 69)');
		await expect(commandCenter).toHaveCSS('color', 'rgb(204, 204, 204)');
		await expect(statusBar).toHaveCSS('color', 'rgb(204, 204, 204)');
		await commandCenter.hover();
		await expect(commandCenter).toHaveCSS('background-color', 'rgb(51, 51, 51)');
		await expect(commandCenter).toHaveCSS('border-top-color', 'rgb(136, 136, 136)');
		await welcome.hover();
		await expect(commandCenter).toHaveCSS('background-color', 'rgb(43, 43, 43)');
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
		await expect(commandCenter).toHaveCSS('background-color', 'rgb(43, 43, 43)');
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
		await expect(commandCenter).toHaveCSS('background-color', 'rgb(246, 246, 246)');
		await expect(commandCenter).toHaveCSS('border-top-color', 'rgb(208, 208, 208)');
		await commandCenter.hover();
		await expect(commandCenter).toHaveCSS('background-color', 'rgb(235, 235, 235)');
		await expect(commandCenter).toHaveCSS('border-top-color', 'rgb(136, 136, 136)');
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
