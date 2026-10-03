import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ElectronApplication, Locator } from '@playwright/test';
import type { BrowserWindow, MessageBoxOptions } from 'electron';
import { expect, test } from '../../../automation/test.js';

async function pasteJson(input: Locator, source: string): Promise<void> {
	await input.evaluate((element, source) => {
		const clipboardData = new DataTransfer();
		clipboardData.setData('text/plain', source);
		element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
	}, source);
}

test('Settings JSON opens a pinned tab, reveals a value, saves immediately and persists Chinese labels', async ({ target, workbench, restartWorkbench }) => {
	test.skip(target.workbenchMode !== 'code', 'Requires the Code settings editor');
	let page = workbench.page;
	await workbench.settingsEditor.openUserSettingsUI();
	const settings = page.getByRole('dialog', { name: 'Ash Settings' });
	if (target.kind === 'electron' && process.platform === 'darwin') {
		await workbench.settingsEditor.selectGroup('workbench');
		await workbench.settingsEditor.selectCategory('layout');
		await settings.locator('[data-configuration-key="window.menuStyle"]').getByRole('combobox').click();
		await page.getByRole('option', { name: 'Custom', exact: true }).click();
	}
	await workbench.settingsEditor.selectCategory('editor');
	await settings.getByRole('searchbox').fill('@id:editor.fontSize');
	const row = settings.locator('[data-settings-item-id="editor.fontSize"]');
	const menu = row.getByRole('button', { name: /^More actions/ });
	await menu.focus();
	await menu.press('Enter');
	const edit = page.getByRole('menuitem', { name: 'Edit in settings.json', exact: true });
	await edit.focus();
	await edit.press('Enter');
	await expect(settings).toBeHidden();
	let group = workbench.editors.groupAt(0);
	const tab = group.tabs.filter({ hasText: 'User Settings (JSON)' });
	await expect(tab).toHaveCount(1);
	await expect(tab.locator('..')).not.toHaveClass(/preview/u);
	await expect(group.editor.input).toBeFocused();
	await expect(group.content.locator('.stanza-editor-accessibility-status')).toContainText('2 characters selected');
	await page.keyboard.insertText('23');
	await group.editor.input.press('ControlOrMeta+S');
	await expect(tab.locator('..')).not.toHaveAttribute('data-state', /dirty|conflict/u);

	await workbench.settingsEditor.openUserSettingsUI();
	await workbench.settingsEditor.selectCategory('editor');
	await settings.getByRole('searchbox').fill('@id:editor.fontSize');
	await expect(settings.getByRole('spinbutton', { name: 'Font size', exact: true })).toHaveValue('23');
	await settings.locator('.ash-modal-editor-close').click();
	await page.reload();
	await workbench.waitForReady();
	await workbench.settingsEditor.openUserSettingsUI();
	await workbench.settingsEditor.selectCategory('editor');
	await settings.getByRole('searchbox').fill('@id:editor.fontSize');
	await expect(settings.getByRole('spinbutton', { name: 'Font size', exact: true })).toHaveValue('23');
	await settings.locator('.ash-modal-editor-close').click();

	await workbench.quickaccess.runCommand('workbench.action.configureLocale');
	const picker = page.getByRole('dialog', { name: 'Select Display Language' });
	await picker.getByRole('combobox').fill('简体中文');
	await picker.getByRole('combobox').press('Enter');
	({ workbench } = await restartWorkbench());
	page = workbench.page;
	group = workbench.editors.groupAt(0);
	await workbench.settingsEditor.openUserSettingsUI();
	const chineseSettings = page.getByRole('dialog', { name: 'Ash 设置' });
	await workbench.settingsEditor.selectGroup('workbench');
	await workbench.settingsEditor.selectCategory('appearance');
	await chineseSettings.getByRole('searchbox').fill('@id:editor.semanticTokenColorCustomizations');
	await expect(chineseSettings.locator('[data-settings-item-id="editor.semanticTokenColorCustomizations"]').getByRole('button', { name: '在 JSON 中编辑', exact: true })).toBeVisible();
	await chineseSettings.getByRole('searchbox').fill('@id:editor.tokenColorCustomizations');
	const button = chineseSettings.locator('[data-settings-item-id="editor.tokenColorCustomizations"]').getByRole('button', { name: '在 JSON 中编辑', exact: true });
	await button.focus();
	await expect(button).toHaveCSS('outline-style', 'solid');
	await expect(button).toBeFocused();
	await page.keyboard.press('Space');
	await expect(chineseSettings).toBeHidden();
	await expect(group.tabs.filter({ hasText: '用户设置（JSON）' })).toHaveCount(1);
	await expect(group.editor.input).toBeFocused();
	await expect(group.content.locator('.stanza-editor-accessibility-status')).toContainText('2');
});

test('Saving JSON token customization refreshes Markdown and the canonical profile settings', async ({ application, target, testWorkspace, workbench }) => {
	test.skip(target.workbenchMode !== 'code' || target.appServerMode !== 'required', 'Requires the product grammar resources');
	const page = workbench.page;
	await writeFile(join(testWorkspace.directory, 'settings-style.md'), '# Heading\n');
	const showSidebar = page.getByRole('button', { name: 'Show Primary Side Bar', exact: true });
	if (await showSidebar.isVisible()) await showSidebar.click();
	const file = page.locator('.ash-explorer .ash-tree-row').filter({ hasText: 'settings-style.md' });
	await expect(file).toHaveCount(1);
	await file.click();
	const group = workbench.editors.groupAt(0);
	const heading = group.editor.element.locator('.stanza-editor-token').filter({ hasText: /^\s*Heading$/u });
	await expect(heading).toHaveCSS('font-weight', '700');
	await workbench.settingsEditor.openUserSettingsUI();
	const settings = page.getByRole('dialog', { name: 'Ash Settings' });
	await workbench.settingsEditor.selectGroup('workbench');
	await workbench.settingsEditor.selectCategory('appearance');
	await settings.getByRole('searchbox').fill('@id:editor.tokenColorCustomizations');
	await settings.locator('[data-settings-item-id="editor.tokenColorCustomizations"]').getByRole('button', { name: 'Edit in settings.json', exact: true }).click();
	await expect(group.editor.input).toBeFocused();
	await pasteJson(group.editor.input, JSON.stringify({ textMateRules: [{ scope: 'markup.heading.markdown', settings: { foreground: '#654321', fontStyle: 'italic' } }] }));
	await group.editor.input.press('ControlOrMeta+S');
	const tab = group.tabs.filter({ hasText: 'User Settings (JSON)' });
	await expect(tab.locator('..')).not.toHaveAttribute('data-state', /dirty|conflict/u);
	await file.click();
	await expect(heading).toHaveCSS('color', 'rgb(101, 67, 33)');
	await expect(heading).toHaveCSS('font-style', 'italic');
	await expect(heading).toHaveCSS('font-weight', '400');
	if (target.kind === 'electron' && 'windows' in application) {
		const profile = await application.evaluate(() => process.env.ASH_HOME);
		if (!profile) throw new Error('Test profile is unavailable');
		await expect.poll(async () => JSON.parse(await readFile(join(profile, 'settings.json'), 'utf8'))['editor.tokenColorCustomizations'].textMateRules[0].settings.foreground).toBe('#654321');
	}
	await page.reload();
	await workbench.waitForReady();
	await file.click();
	await expect(heading).toHaveCSS('color', 'rgb(101, 67, 33)');
});

test('Settings JSON rejects invalid values and preserves dirty edits during a configuration conflict', async ({ application, target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'Requires the Code settings editor');
	const page = workbench.page;
	const electron = target.kind === 'electron' ? application as ElectronApplication : undefined;
	if (electron) {
		await electron.evaluate(({ dialog }) => {
			const original = dialog.showMessageBox.bind(dialog);
			const state = globalThis as typeof globalThis & { ashSettingsSaveDialogs?: { messages: MessageBoxOptions[]; restore: () => void } };
			state.ashSettingsSaveDialogs = { messages: [], restore: () => { dialog.showMessageBox = original; } };
			dialog.showMessageBox = (async (...args: [MessageBoxOptions] | [BrowserWindow, MessageBoxOptions]) => {
				state.ashSettingsSaveDialogs!.messages.push(args.length === 1 ? args[0] : args[1]);
				return { response: 0, checkboxChecked: false };
			}) as typeof dialog.showMessageBox;
		});
	}
	try {
		await workbench.quickaccess.runCommand('workbench.action.openSettingsJson');
		const group = workbench.editors.groupAt(0);
		const tab = group.tabs.filter({ hasText: 'User Settings (JSON)' });
		await expect(group.editor.input).toBeFocused();
		await group.editor.input.press('ControlOrMeta+A');
		await expect(group.content.locator('.stanza-editor-accessibility-status')).toContainText('characters selected');
		await pasteJson(group.editor.input, '{ "editor.fontSize": "invalid" }');
		await group.editor.input.press('ControlOrMeta+S');
		if (electron) {
			await expect.poll(() => electron.evaluate(() => JSON.stringify((globalThis as typeof globalThis & { ashSettingsSaveDialogs?: { messages: MessageBoxOptions[] } }).ashSettingsSaveDialogs?.messages))).toContain('editor.fontSize');
		} else {
			const invalid = page.getByRole('dialog', { name: 'Could not save file', exact: true });
			await expect(invalid).toContainText('editor.fontSize');
			await invalid.getByRole('button', { name: 'OK', exact: true }).click();
		}
		await expect(tab.locator('..')).toHaveAttribute('data-state', /dirty|conflict/u);
		await group.editor.waitForEditorFocus();
		await group.editor.input.press('ControlOrMeta+A');
		await expect(group.content.locator('.stanza-editor-accessibility-status')).toContainText('characters selected');
		await pasteJson(group.editor.input, '{ "editor.fontSize": 18 }');

		await workbench.settingsEditor.openUserSettingsUI();
		const settings = page.getByRole('dialog', { name: 'Ash Settings' });
		await workbench.settingsEditor.selectCategory('editor');
		await settings.getByRole('searchbox').fill('@id:editor.fontSize');
		const font = settings.getByRole('spinbutton', { name: 'Font size', exact: true });
		await expect(font).toHaveValue('13');
		await font.fill('20');
		await font.press('Tab');
		await expect(settings.locator('[data-settings-item-id="editor.fontSize"] .ash-settings-indicators')).toBeHidden();
		await settings.locator('.ash-modal-editor-close').click();
		await group.editor.waitForEditorFocus();
		await group.editor.input.press('ControlOrMeta+S');
		if (electron) {
			await expect.poll(() => electron.evaluate(() => JSON.stringify((globalThis as typeof globalThis & { ashSettingsSaveDialogs?: { messages: MessageBoxOptions[] } }).ashSettingsSaveDialogs?.messages))).toContain('file changed on disk');
		} else {
			const conflict = page.getByRole('dialog', { name: 'File changed on disk', exact: true });
			await expect(conflict).toContainText('Your unsaved changes are still open');
			await conflict.getByRole('button', { name: 'OK', exact: true }).click();
		}
		await expect(tab.locator('..')).toHaveAttribute('data-state', /dirty|conflict/u);
		await group.editor.waitForEditorContents(content => content.includes('18'));
	} finally {
		await electron?.evaluate(() => (globalThis as typeof globalThis & { ashSettingsSaveDialogs?: { restore: () => void } }).ashSettingsSaveDialogs?.restore());
	}
});
