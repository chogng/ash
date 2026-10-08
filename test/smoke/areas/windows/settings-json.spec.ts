import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../../../automation/test.js';
import type { PlaywrightApplication } from '../../../automation/playwrightDriver.js';
import { Workbench } from '../../../automation/workbench.js';

async function pasteJson(input: Locator, source: string): Promise<void> {
	await input.evaluate((element, source) => {
		const clipboardData = new DataTransfer();
		clipboardData.setData('text/plain', source);
		element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
	}, source);
}

async function captureCopiedSetting(application: PlaywrightApplication, page: Page): Promise<{ read(): Promise<string>; restore(): Promise<void>; }> {
	if ('windows' in application) {
		await application.evaluate(({ clipboard }) => {
			const captured = globalThis as typeof globalThis & { settingsCopyText: string; restoreSettingsCopy(): void; };
			const write = clipboard.writeText.bind(clipboard);
			captured.settingsCopyText = '';
			clipboard.writeText = async text => { captured.settingsCopyText = text; await write(text); };
			captured.restoreSettingsCopy = () => { clipboard.writeText = write; };
		});
		return {
			// Read the captured IPC write, never the user's system clipboard.
			read: () => application.evaluate(() => (globalThis as typeof globalThis & { settingsCopyText: string; }).settingsCopyText),
			restore: () => application.evaluate(() => { (globalThis as typeof globalThis & { restoreSettingsCopy(): void; }).restoreSettingsCopy(); }),
		};
	}
	await page.evaluate(() => {
		const captured = globalThis as typeof globalThis & { settingsCopyText: string; restoreSettingsCopy(): void; };
		const write = navigator.clipboard.writeText.bind(navigator.clipboard);
		captured.settingsCopyText = '';
		// Each test owns its browser context; keep clipboard data inside that context.
		navigator.clipboard.writeText = async text => { captured.settingsCopyText = text; };
		captured.restoreSettingsCopy = () => { navigator.clipboard.writeText = write; };
	});
	return {
		read: () => page.evaluate(() => (globalThis as typeof globalThis & { settingsCopyText: string; }).settingsCopyText),
		restore: () => page.evaluate(() => { (globalThis as typeof globalThis & { restoreSettingsCopy(): void; }).restoreSettingsCopy(); }),
	};
}

for (const locale of ['en', 'zh-CN']) {
	test(`Modified Settings composes filters and restores saved overrides (${locale})`, async ({ application, workbench, restartWorkbench, reloadWorkbench, runningApplication }, testInfo) => {
		const chinese = locale === 'zh-CN';
		if (chinese) {
			await workbench.quickaccess.runCommand('workbench.action.configureLocale');
			const picker = workbench.page.getByRole('dialog', { name: 'Select Display Language' });
			await picker.getByRole('combobox').fill('简体中文');
			await picker.getByRole('combobox').press('Enter');
			({ application, workbench } = await restartWorkbench());
		}
		await workbench.settingsEditor.openUserSettingsUI();
		let settings = workbench.settingsEditor.element;
		await settings.getByRole('searchbox').fill('@id:editor.fontSize');
		const fontDefault = Number(await settings.locator('[data-settings-item-id="editor.fontSize"]').getByRole('spinbutton').inputValue());
		await settings.locator('.ash-modal-editor-close').click();
		await workbench.quickaccess.runCommand('workbench.action.openSettingsJson');
		const group = workbench.editors.groupAt(0);
		const saved = {
			'window.menuStyle': 'custom', 'workbench.locale': locale, 'editor.fontSize': fontDefault,
			'workbench.activityBar.badges': false, 'editor.lineHeight': 0, 'window.zoomLevel': 0, 'window.title': '',
			'[typescript]': { 'editor.fontFamily': 'Language-only font' },
		};
		await group.editor.input.press('ControlOrMeta+A');
		await pasteJson(group.editor.input, JSON.stringify(saved, null, 2));
		await group.editor.input.press('ControlOrMeta+S');
		await expect(group.tabs.filter({ hasText: chinese ? '用户设置（JSON）' : 'User Settings (JSON)' }).locator('..')).not.toHaveAttribute('data-state', /dirty|conflict/u);
		const readSaved = async (): Promise<unknown> => {
			if ('windows' in application) {
				const profile = await application.evaluate(() => process.env.ASH_HOME!);
				return JSON.parse(await readFile(join(profile, 'settings.json'), 'utf8'));
			}
			return workbench.page.evaluate(async () => {
				const database = await new Promise<IDBDatabase>((resolve, reject) => {
					const request = indexedDB.open('ash-configuration');
					request.onsuccess = () => resolve(request.result);
					request.onerror = () => reject(request.error);
				});
				try {
					return await new Promise<unknown>((resolve, reject) => {
						const request = database.transaction('resources', 'readonly').objectStore('resources').get('settings.json');
						request.onsuccess = () => resolve(JSON.parse(request.result.document.source));
						request.onerror = () => reject(request.error);
					});
				} finally { database.close(); }
			});
		};
		await expect.poll(readSaved).toEqual(saved);
		const assertModified = async (): Promise<void> => {
			await workbench.settingsEditor.openUserSettingsUI();
			settings = workbench.settingsEditor.element;
			await settings.getByRole('searchbox').fill('@modified');
			for (const key of ['editor.fontSize', 'workbench.activityBar.badges', 'editor.lineHeight', 'window.title', ...('windows' in application ? ['window.zoomLevel'] : [])]) {
				await expect(settings.locator(`[data-settings-item-id="${key}"]`)).toHaveCount(1);
			}
			// Zoom is contributed only by Desktop; zero still has to survive on a shared setting in both clients.
			if (!('windows' in application)) await expect(settings.locator('[data-settings-item-id="window.zoomLevel"]')).toHaveCount(0);
			await expect(settings.locator('[data-settings-item-id="editor.fontFamily"]')).toHaveCount(0);
			await expect(settings.locator('[data-settings-item-id="grep.backend"]')).toHaveCount(0);
			await settings.getByRole('searchbox').fill('@id:editor.fontSize');
			await settings.getByRole('button', { name: chinese ? '筛选设置' : 'Filter Settings', exact: true }).press('Enter');
			await workbench.page.getByRole('menuitem', { name: chinese ? '已修改' : 'Modified', exact: true }).press('Enter');
			await expect(settings.getByRole('searchbox')).toHaveValue('@id:editor.fontSize @modified');
			await expect(settings.getByRole('searchbox')).toBeFocused();
			await expect(settings.locator('.ash-settings-content-tree [data-settings-item-id]')).toHaveCount(1);
			await settings.getByRole('searchbox').fill('@modified font @id:editor.fontSize');
			await workbench.settingsEditor.selectEditorCategory('editor-fonts');
			await expect(settings.locator('.ash-settings-navigation-tree [data-settings-category-id]')).toHaveCount(1);
		};
		await assertModified();
		await settings.locator('.ash-modal-editor-close').click();
		({ application, workbench } = await reloadWorkbench());
		await assertModified();
		const row = settings.locator('[data-settings-item-id="editor.fontSize"]');
		await row.getByRole('button', { name: chinese ? /的更多操作$/u : /^More actions for /u }).press('Enter');
		await workbench.page.getByRole('menuitem', { name: chinese ? '重置设置' : 'Reset Setting', exact: true }).press('Enter');
		await expect(row).toHaveCount(0);
		await expect(settings.locator('.ash-settings-navigation-tree [data-settings-category-id], .ash-settings-navigation-tree [data-settings-group-id]')).toHaveCount(0);
		await expect(settings.locator('.ash-settings-navigation-empty')).toBeVisible();
		await expect(settings.getByRole('status').filter({ hasText: chinese ? '未找到设置。' : 'No settings found.' }).last()).toBeVisible();
		const { 'editor.fontSize': _removed, ...remaining } = saved;
		await expect.poll(readSaved).toEqual(remaining);
		await settings.getByRole('searchbox').fill('@modified @id:window.title window');
		await expect(settings.locator('[data-settings-item-id="window.title"]')).toHaveCount(1);
		await settings.getByRole('button', { name: chinese ? '筛选设置' : 'Filter Settings', exact: true }).press('Enter');
		await workbench.page.getByRole('menuitem', { name: chinese ? '清除筛选条件' : 'Clear Filters', exact: true }).press('Enter');
		await expect(settings.getByRole('searchbox')).toHaveValue('window');
		await settings.locator('.ash-modal-editor-close').click();
		await testInfo.attach('modified-settings-diagnostics', { body: JSON.stringify(runningApplication.diagnostics), contentType: 'application/json' });
		expect(runningApplication.diagnostics.errors).toEqual([]);
	});

	test(`Copy Setting as JSON preserves values and saves through the settings resource (${locale})`, async ({ application, workbench, restartWorkbench, reloadWorkbench }) => {
		const chinese = locale === 'zh-CN';
		if (chinese) {
			await workbench.quickaccess.runCommand('workbench.action.configureLocale');
			const picker = workbench.page.getByRole('dialog', { name: 'Select Display Language' });
			await picker.getByRole('combobox').fill('简体中文');
			await picker.getByRole('combobox').press('Enter');
			({ application, workbench } = await restartWorkbench());
		}
		const page = workbench.page;
		const title = 'Copy test "quoted" \\ path\n中文';
		const tokenColors = { textMateRules: [{ scope: ['keyword', 'string'], settings: { foreground: '#ff1122' } }] };
		await workbench.quickaccess.runCommand('workbench.action.openSettingsJson');
		const group = workbench.editors.groupAt(0);
		await group.editor.input.press('ControlOrMeta+A');
		await pasteJson(group.editor.input, JSON.stringify({
			'window.menuStyle': 'custom', 'window.title': title, 'editor.tokenColorCustomizations': tokenColors,
			...(chinese ? { 'workbench.locale': 'zh-CN' } : {}),
		}, null, 2));
		await group.editor.input.press('ControlOrMeta+S');
		const tab = group.tabs.filter({ hasText: chinese ? '用户设置（JSON）' : 'User Settings (JSON)' });
		await expect(tab.locator('..')).not.toHaveAttribute('data-state', /dirty|conflict/u);
		const copySettings = async (): Promise<string[]> => {
			const currentPage = workbench.page;
			const capture = await captureCopiedSetting(application, currentPage);
			const fragments: string[] = [];
			try {
				await workbench.settingsEditor.openUserSettingsUI();
				const settings = workbench.settingsEditor.element;
				await workbench.settingsEditor.selectGroup('workbench');
				await workbench.settingsEditor.selectCategory('appearance');
				for (const [key, value] of [['window.title', title], ['editor.tokenColorCustomizations', tokenColors]] as const) {
					await settings.getByRole('searchbox').fill(`@id:${key}`);
					const row = settings.locator(`[data-settings-item-id="${key}"]`);
					const more = row.getByRole('button', { name: chinese ? /更多操作/u : /^More actions/u });
					await more.focus();
					await more.press('Enter');
					const action = currentPage.getByRole('menuitem', { name: chinese ? '复制设置为 JSON' : 'Copy Setting as JSON', exact: true });
					await action.focus();
					await expect(action).toBeFocused();
					await action.press('Enter');
					await expect(more).toBeFocused();
					await expect.poll(capture.read).toBe(`${JSON.stringify(key)}: ${JSON.stringify(value, null, 2)}`);
					fragments.push(await capture.read());
				}
				await settings.locator('.ash-modal-editor-close').click();
			} finally {
				await capture.restore();
			}
			return fragments;
		};
		const fragments = await copySettings();
		await workbench.quickaccess.runCommand('workbench.action.openSettingsJson');
		await group.editor.input.press('ControlOrMeta+A');
		await pasteJson(group.editor.input, `{\n"window.menuStyle": "custom",\n${fragments.join(',\n')}${chinese ? ',\n"workbench.locale": "zh-CN"' : ''}\n}`);
		await group.editor.input.press('ControlOrMeta+S');
		await expect(tab.locator('..')).not.toHaveAttribute('data-state', /dirty|conflict/u);
		if ('windows' in application) {
			const profile = await application.evaluate(() => process.env.ASH_HOME!);
			await expect.poll(async () => JSON.parse(await readFile(join(profile, 'settings.json'), 'utf8'))).toEqual({
				'window.menuStyle': 'custom', 'window.title': title, 'editor.tokenColorCustomizations': tokenColors, ...(chinese ? { 'workbench.locale': 'zh-CN' } : {}),
			});
		} else {
			await expect.poll(() => page.evaluate(async () => {
				const database = await new Promise<IDBDatabase>((resolve, reject) => {
					const request = indexedDB.open('ash-configuration');
					request.onsuccess = () => resolve(request.result);
					request.onerror = () => reject(request.error);
				});
				try {
					return await new Promise<string>((resolve, reject) => {
						const request = database.transaction('resources').objectStore('resources').get('settings.json');
						request.onsuccess = () => resolve(request.result.document.source);
						request.onerror = () => reject(request.error);
					});
				} finally { database.close(); }
			}).then(source => JSON.parse(source))).toEqual({
				'window.menuStyle': 'custom', 'window.title': title, 'editor.tokenColorCustomizations': tokenColors, ...(chinese ? { 'workbench.locale': 'zh-CN' } : {}),
			});
		}
		({ application, workbench } = await reloadWorkbench());
		// Copy again from the reopened configuration owner, independent of editor viewport state.
		await expect(await copySettings()).toEqual(fragments);
	});
}

test('Code Action settings offer save modes and persist file and notebook configuration', async ({ workbench, reloadWorkbench }) => {
	await workbench.quickaccess.runCommand('workbench.action.openSettingsJson');
	let group = workbench.editors.groupAt(0);
	await expect(group.editor.input).toBeFocused();
	await group.editor.input.press('ControlOrMeta+A');
	await pasteJson(group.editor.input, JSON.stringify({
		'editor.codeActionsOnSave': { 'source.organizeImports': '' },
		'notebook.codeActionsOnSave': { 'notebook.source.fixAll': 'explicit' },
	}, null, 2));
	await group.editor.input.press('ControlOrMeta+Home');
	await group.editor.input.press('ArrowDown');
	await group.editor.input.press('ArrowDown');
	await group.editor.input.press('End');
	await group.editor.input.press('ArrowLeft');
	await group.editor.input.press('Control+Space');
	await expect(group.content.getByRole('option', { name: /^"always" /u })).toBeVisible();
	await expect(group.content.getByRole('option', { name: /^"never" /u })).toBeVisible();
	await group.editor.input.press('ArrowDown');
	await group.editor.input.press('Enter');
	await group.editor.input.press('ControlOrMeta+S');
	const tab = group.tabs.filter({ hasText: 'User Settings (JSON)' });
	await expect(tab.locator('..')).not.toHaveAttribute('data-state', /dirty|conflict/u);
	({ workbench } = await reloadWorkbench());
	await workbench.quickaccess.runCommand('workbench.action.openSettingsJson');
	group = workbench.editors.groupAt(0);
	await group.editor.waitForEditorContents(content => {
		const settings = JSON.parse(content);
		return settings['editor.codeActionsOnSave']?.['source.organizeImports'] === 'explicit'
			&& settings['notebook.codeActionsOnSave']?.['notebook.source.fixAll'] === 'explicit';
	});
});

test('Preferred paste and drop commands reveal editable settings and persist their order', async ({ workbench }) => {
	const group = workbench.editors.groupAt(0);
	const tab = group.tabs.filter({ hasText: 'User Settings (JSON)' });
	const preferences = ['uri.path.relative', 'uri.path.absolute'];
	for (const [command, key] of [
		['workbench.action.configurePreferredPasteAction', 'editor.pasteAs.preferences'],
		['workbench.action.configurePreferredDropAction', 'editor.dropIntoEditor.preferences'],
	] as const) {
		await workbench.quickaccess.runCommand(command);
		await expect(tab).toHaveCount(1);
		await expect(tab.locator('..')).not.toHaveClass(/preview/u);
		await expect(group.editor.input).toBeFocused();
		await expect(group.content.locator('.stanza-editor-accessibility-status')).toContainText('2 characters selected');
		await pasteJson(group.editor.input, JSON.stringify(preferences));
		await group.editor.input.press('ControlOrMeta+S');
		await expect(tab.locator('..')).not.toHaveAttribute('data-state', /dirty|conflict/u);
		await group.editor.waitForEditorContents(content => content.includes(`"${key}"`) && content.includes('uri.path.relative'));
	}
	await workbench.page.reload();
	await workbench.waitForReady();
	await workbench.quickaccess.runCommand('workbench.action.openSettingsJson');
	await group.editor.waitForEditorContents(content => {
		const settings = JSON.parse(content);
		return ['editor.pasteAs.preferences', 'editor.dropIntoEditor.preferences'].every(key =>
			JSON.stringify(settings[key]) === JSON.stringify(preferences));
	});
});

test('Preferred paste and drop JSON completions use registered provider kinds', async ({ target, workbench }) => {
	test.skip(target.appServerMode !== 'required', 'Requires the product language declarations');
	const group = workbench.editors.groupAt(0);
	for (const [command, key] of [
		['workbench.action.configurePreferredPasteAction', 'editor.pasteAs.preferences'],
		['workbench.action.configurePreferredDropAction', 'editor.dropIntoEditor.preferences'],
	] as const) {
		await workbench.quickaccess.runCommand(command);
		await expect(group.editor.input).toBeFocused();
		await pasteJson(group.editor.input, '[""]');
		await group.editor.input.press('ArrowLeft');
		await group.editor.input.press('ArrowLeft');
		await group.editor.input.press('Control+Space');
		const options = group.content.locator('.stanza-editor-completion-option');
		const relative = options.filter({ hasText: 'uri.path.relative' });
		await expect(relative).toBeVisible();
		await expect(options.filter({ hasText: 'uri.path.absolute' })).toBeVisible();
		await relative.click();
		await group.editor.waitForEditorContents(content => JSON.parse(content)[key]?.[0] === 'uri.path.relative');
		await group.editor.input.press('ControlOrMeta+S');
		await expect(group.tabs.filter({ hasText: 'User Settings (JSON)' }).locator('..')).not.toHaveAttribute('data-state', /dirty|conflict/u);
	}
});

test('Settings JSON opens a pinned tab, reveals a value, saves immediately and persists Chinese labels', async ({ target, workbench, restartWorkbench, runningApplication }) => {
	const diagnostics = runningApplication.diagnostics;
	let page = workbench.page;
	await workbench.settingsEditor.openUserSettingsUI();
	const settings = page.getByRole('dialog', { name: 'Ash Settings' });
	if (target.kind === 'electron' && process.platform === 'darwin') {
		await workbench.settingsEditor.selectGroup('workbench');
		await workbench.settingsEditor.selectCategory('layout');
		await settings.locator('[data-configuration-key="window.menuStyle"]').getByRole('combobox').click();
		await page.getByRole('option', { name: 'Custom', exact: true }).click();
	}
	await workbench.settingsEditor.selectEditorCategory('editor-fonts');
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
	await workbench.settingsEditor.selectEditorCategory('editor-fonts');
	await settings.getByRole('searchbox').fill('@id:editor.fontSize');
	await expect(settings.getByRole('spinbutton', { name: 'Font size', exact: true })).toHaveValue('23');
	await settings.locator('.ash-modal-editor-close').click();
	await page.reload();
	await workbench.waitForReady();
	await expect(diagnostics.consoleErrors.filter(error => /Failed to update working-copy backup|InvalidStateError|database connection is closing/u.test(error))).toEqual([]);
	await workbench.settingsEditor.openUserSettingsUI();
	await workbench.settingsEditor.selectEditorCategory('editor-fonts');
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
	await expect(diagnostics.consoleErrors.filter(error => /Failed to update working-copy backup|InvalidStateError|database connection is closing/u.test(error))).toEqual([]);
});

for (const locale of ['en', 'zh-CN']) {
	test(`Settings reset removes explicit defaults and localizes action menus (${locale})`, async ({ workbench, restartWorkbench }) => {
		const chinese = locale === 'zh-CN';
		if (chinese) {
			await workbench.quickaccess.runCommand('workbench.action.configureLocale');
			const picker = workbench.page.getByRole('dialog', { name: 'Select Display Language' });
			await picker.getByRole('combobox').fill('简体中文');
			await picker.getByRole('combobox').press('Enter');
			({ workbench } = await restartWorkbench());
		}
		const page = workbench.page;
		const settings = page.getByRole('dialog', { name: chinese ? 'Ash 设置' : 'Ash Settings' });
		await workbench.settingsEditor.openUserSettingsUI();
		await workbench.settingsEditor.selectEditorCategory('editor-fonts');
		const fontDefault = Number(await settings.locator('[data-settings-item-id="editor.fontSize"]').getByRole('spinbutton').inputValue());
		await settings.locator('.ash-modal-editor-close').click();
		await workbench.quickaccess.runCommand('workbench.action.openSettingsJson');
		const group = workbench.editors.groupAt(0);
		await group.editor.input.press('ControlOrMeta+A');
		await pasteJson(group.editor.input, `{
	// Keep this comment and unrelated setting.
	"editor.fontSize": ${fontDefault},
	"workbench.colorCustomizations": {},
	"workbench.locale": ${JSON.stringify(locale)},
	"window.menuStyle": "custom",
	"extension.marker": 99,
}\n`);
		await group.editor.input.press('ControlOrMeta+S');
		await expect(group.tabs.filter({ hasText: chinese ? '用户设置（JSON）' : 'User Settings (JSON)' }).locator('..')).not.toHaveAttribute('data-state', /dirty|conflict/u);

		for (const key of ['editor.fontSize', 'workbench.colorCustomizations']) {
			await workbench.settingsEditor.openUserSettingsUI();
			if (key === 'editor.fontSize') {
				await workbench.settingsEditor.selectEditorCategory('editor-fonts');
			} else {
				await workbench.settingsEditor.selectGroup('workbench');
				await workbench.settingsEditor.selectCategory('appearance');
			}
			await settings.getByRole('searchbox').fill(`@id:${key}`);
			const row = settings.locator(`[data-settings-item-id="${key}"]`);
			const marker = row.locator('.ash-settings-configured-marker');
			await expect(row).toHaveClass(/is-configured/u);
			await expect(row).toHaveAccessibleDescription(chinese ? '已在本地用户设置中配置。' : 'Configured in local user settings.');
			await expect(marker).toBeVisible();
			await expect(marker).toHaveAttribute('aria-hidden', 'true');
			await expect(marker).not.toHaveAttribute('tabindex');
			const more = row.getByRole('button', { name: chinese ? /的更多操作$/u : /^More actions for /u });
			await more.focus();
			await more.press('Enter');
			await expect(page.getByRole('menuitem', { name: chinese ? '复制设置 ID' : 'Copy Setting ID', exact: true })).toBeVisible();
			const reset = page.getByRole('menuitem', { name: chinese ? '重置设置' : 'Reset Setting', exact: true });
			await expect(reset).toBeEnabled();
			await reset.focus();
			await reset.press('Enter');
			await expect(more).toBeFocused();
			await expect(row).not.toHaveClass(/is-configured/u);
			await expect(row).toHaveAccessibleDescription('');
			await expect(marker).toBeHidden();
			await more.press('Enter');
			await expect(reset).toBeDisabled();
			await page.keyboard.press('Escape');
			await settings.locator('.ash-modal-editor-close').click();
			await group.editor.waitForEditorContents(content => !content.includes(`"${key}"`) && content.includes('Keep this comment') && content.includes('"extension.marker": 99'));
		}

		await workbench.settingsEditor.openUserSettingsUI();
		await settings.getByRole('searchbox').fill('@id:editor.fontSize');
		const filter = settings.getByRole('button', { name: chinese ? '筛选设置' : 'Filter Settings', exact: true });
		await filter.focus();
		await filter.press('Enter');
		await expect(page.getByRole('menuitem', { name: chinese ? '设置 ID…' : 'Setting ID…', exact: true })).toBeVisible();
		const clear = page.getByRole('menuitem', { name: chinese ? '清除筛选条件' : 'Clear Filters', exact: true });
		await clear.focus();
		await clear.press('Enter');
		await expect(settings.getByRole('searchbox')).toBeFocused();
		await expect(settings.getByRole('searchbox')).toHaveValue('');
	});
}

test('Configured markers and modified filtering update after external persisted writes', async ({ application, workbench, runningApplication }, testInfo) => {
	const page = workbench.page;
	const workbenchUrl = page.url();
	await workbench.settingsEditor.openUserSettingsUI();
	await workbench.settingsEditor.selectEditorCategory('editor-fonts');
	const settings = workbench.settingsEditor.element;
	await settings.getByRole('searchbox').fill('@id:editor.fontSize');
	const row = settings.locator('[data-settings-item-id="editor.fontSize"]');
	const marker = row.locator('.ash-settings-configured-marker');
	const font = row.getByRole('spinbutton');
	const fontDefault = Number(await font.inputValue());
	let writer: Workbench | undefined;
	const saveExternal = async (source: string): Promise<void> => {
		if ('windows' in application) {
			await page.evaluate(async source => {
				const current = await globalThis.ashTestMainProcess.call<{ revision: number; }>('configuration', 'read');
				await globalThis.ashTestMainProcess.call('configuration', 'update', { expectedRevision: current.revision, document: { version: 1, source } });
			}, source);
		} else {
			if (!writer) {
				const writerPage = await page.context().newPage();
				writer = new Workbench(writerPage);
				await writerPage.goto(workbenchUrl);
				await writer.waitForReady();
				await writer.quickaccess.runCommand('workbench.action.openSettingsJson');
			}
			const group = writer.editors.groupAt(0);
			await group.editor.input.press('ControlOrMeta+A');
			await pasteJson(group.editor.input, source);
			await group.editor.input.press('ControlOrMeta+S');
			await expect(group.tabs.filter({ hasText: 'User Settings (JSON)' }).locator('..')).not.toHaveAttribute('data-state', /dirty|conflict/u);
		}
	};
	try {
		await expect(marker).toBeHidden();
		await settings.getByRole('searchbox').fill('@modified @id:editor.fontSize');
		await expect(row).toHaveCount(0);
		await saveExternal(JSON.stringify({ 'editor.fontSize': fontDefault }));
		await expect(row).toHaveCount(1);
		await expect(font).toHaveValue(String(fontDefault));
		await expect(row).toHaveClass(/is-configured/u);
		await expect(row).toHaveAccessibleDescription('Configured in local user settings.');
		await expect(marker).toBeVisible();
		for (const scheme of ['light', 'dark'] as const) {
			await workbench.setAppearance(application, scheme);
			await expect.poll(() => row.evaluate(element => {
				const description = element.querySelector('.ash-configuration-setting-description')!;
				const marker = element.querySelector('.ash-settings-configured-marker')!;
				return getComputedStyle(marker).backgroundColor === getComputedStyle(description).color;
			})).toBe(true);
		}
		await marker.hover();
		await expect(page.getByRole('tooltip')).toHaveText('Configured in local user settings.');
		await saveExternal(JSON.stringify({ '[typescript]': { 'editor.fontSize': fontDefault + 2 } }));
		await expect(row).toHaveCount(0);
		await expect(page.getByRole('tooltip')).toHaveCount(0);
		await settings.getByRole('searchbox').fill('@id:editor.fontSize');
		await expect(font).toHaveValue(String(fontDefault));
		await expect(row).not.toHaveClass(/is-configured/u);
		await expect(row).toHaveAccessibleDescription('');
		await expect(marker).toBeHidden();
		await expect(page.getByRole('tooltip')).toHaveCount(0);
		await settings.getByRole('searchbox').fill('@modified @id:editor.fontSize');
		await expect(row).toHaveCount(0);
		await saveExternal(JSON.stringify({ 'editor.fontSize': fontDefault }));
		await expect(row).toHaveCount(1);
		await expect(marker).toBeVisible();
		await marker.hover();
		await expect(page.getByRole('tooltip')).toBeVisible();
		await settings.locator('.ash-modal-editor-close').click();
		await expect(page.getByRole('tooltip')).toHaveCount(0);
	} finally {
		if (writer) {
			// Release the clean working copy before closing its IndexedDB-backed window services.
			await writer.quickaccess.runCommand('workbench.action.closeAllEditors');
			await expect(writer.editors.groupAt(0).tabs).toHaveCount(0);
			await writer.page.close();
		}
	}
	await testInfo.attach('external-modified-settings-diagnostics', { body: JSON.stringify(runningApplication.diagnostics), contentType: 'application/json' });
	expect(runningApplication.diagnostics.errors).toEqual([]);
});

test('Saving JSON token customization refreshes Markdown and the canonical profile settings', async ({ application, target, testWorkspace, workbench }) => {
	test.skip(target.appServerMode !== 'required', 'Requires the product grammar resources');
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

test('Settings JSON rejects invalid values and preserves dirty edits during a configuration conflict', async ({ application, workbench }) => {
	const page = workbench.page;
	await workbench.quickaccess.runCommand('workbench.action.openSettingsJson');
	const group = workbench.editors.groupAt(0);
	const tab = group.tabs.filter({ hasText: 'User Settings (JSON)' });
	await expect(group.editor.input).toBeFocused();
	await group.editor.input.press('ControlOrMeta+A');
	await expect(group.content.locator('.stanza-editor-accessibility-status')).toContainText('characters selected');
	await pasteJson(group.editor.input, '{ "editor.fontSize": "invalid" }');
	const invalid = await workbench.dialogs.expectMessage(application, 'Could not save file', () => group.editor.input.press('ControlOrMeta+S'));
	expect(`${invalid.message} ${invalid.detail}`).toContain('editor.fontSize');
	await expect(tab.locator('..')).toHaveAttribute('data-state', /dirty|conflict/u);
	await workbench.settingsEditor.openUserSettingsUI();
	await workbench.settingsEditor.element.getByRole('searchbox').fill('@modified @id:editor.fontSize');
	await expect(workbench.settingsEditor.element.locator('[data-settings-item-id="editor.fontSize"]')).toHaveCount(0);
	await workbench.settingsEditor.element.locator('.ash-modal-editor-close').click();
	await group.editor.waitForEditorFocus();
	await group.editor.input.press('ControlOrMeta+A');
	await expect(group.content.locator('.stanza-editor-accessibility-status')).toContainText('characters selected');
	await pasteJson(group.editor.input, '{ "editor.fontSize": 18 }');

	await workbench.settingsEditor.openUserSettingsUI();
	const settings = page.getByRole('dialog', { name: 'Ash Settings' });
	await workbench.settingsEditor.selectEditorCategory('editor-fonts');
	await settings.getByRole('searchbox').fill('@id:editor.fontSize');
	const font = settings.getByRole('spinbutton', { name: 'Font size', exact: true });
	await expect(font).toHaveValue(process.platform === 'darwin' ? '12' : '14');
	await font.fill('20');
	await font.press('Tab');
	await expect(settings.locator('[data-settings-item-id="editor.fontSize"] .ash-settings-indicators')).toBeHidden();
	await expect(settings.locator('[data-settings-item-id="editor.fontSize"] .ash-settings-configured-marker')).toBeVisible();
	await settings.getByRole('searchbox').fill('@modified @id:editor.fontSize');
	await expect(settings.locator('[data-settings-item-id="editor.fontSize"]')).toHaveCount(1);
	await settings.locator('.ash-modal-editor-close').click();
	await group.editor.waitForEditorFocus();
	const conflict = await workbench.dialogs.expectMessage(application, 'File changed on disk', () => group.editor.input.press('ControlOrMeta+S'));
	expect(`${conflict.message} ${conflict.detail}`).toContain('Your unsaved changes are still open');
	await expect(tab.locator('..')).toHaveAttribute('data-state', /dirty|conflict/u);
	await group.editor.waitForEditorContents(content => content.includes('18'));
});

async function workingCopyBackupContents(page: Page): Promise<string[]> {
	return page.evaluate(async () => {
		const database = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open('ash-working-copy-backups', 1);
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		try {
			return await new Promise<string[]>((resolve, reject) => {
				const request = database.transaction('backups', 'readonly').objectStore('backups').getAll();
				request.onsuccess = () => resolve(request.result.map((record: { content: string; }) => record.content));
				request.onerror = () => reject(request.error);
			});
		} finally { database.close(); }
	});
}

test('Electron backup shutdown failure resumes editing and a later close restores the new draft', async ({ target, application, workbench, reloadWorkbench, runningApplication }, testInfo) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'disabled');
	if (!('windows' in application)) throw new Error('Expected the isolated Electron application');
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+N');
	const group = workbench.editors.groupAt(0);
	await group.editor.input.focus();
	await group.editor.input.type('before failed close');
	const backupContents = () => workingCopyBackupContents(page);
	await expect.poll(backupContents).toContain('before failed close');
	await application.evaluate(({ dialog }) => {
		const state = globalThis as typeof globalThis & { backupCloseDialogs: string[]; restoreBackupCloseDialogs(): void; };
		const original = dialog.showMessageBox;
		state.backupCloseDialogs = [];
		dialog.showMessageBox = (async (...args: unknown[]) => {
			state.backupCloseDialogs.push((args.at(-1) as { message: string; }).message);
			return { response: 0, checkboxChecked: false };
		}) as typeof dialog.showMessageBox;
		state.restoreBackupCloseDialogs = () => { dialog.showMessageBox = original; };
	});
	await page.evaluate(() => {
		const original = IDBDatabase.prototype.transaction;
		const state = globalThis as typeof globalThis & { backupCloseFault: { calls: number; failedAt: number; fired: boolean; restore(): void; }; };
		state.backupCloseFault = { calls: 0, failedAt: 0, fired: false, restore: () => { IDBDatabase.prototype.transaction = original; } };
		IDBDatabase.prototype.transaction = function (this: IDBDatabase, ...args: Parameters<typeof original>): ReturnType<typeof original> {
			if (this.name === 'ash-working-copy-backups' && args[1] === 'readwrite') {
				// The first store is the before-shutdown check; fail the final joined drain.
				if (++state.backupCloseFault.calls === 2) {
					state.backupCloseFault.failedAt = state.backupCloseFault.calls;
					state.backupCloseFault.fired = true;
					throw new DOMException('Injected final backup shutdown failure', 'InvalidStateError');
				}
			}
			return original.apply(this, args);
		};
	});
	let restored = false;
	try {
		const window = await application.browserWindow(page);
		await window.evaluate(window => window.close());
		await expect.poll(() => page.evaluate(() => (globalThis as typeof globalThis & { backupCloseFault: { calls: number; fired: boolean; }; }).backupCloseFault.fired)).toBe(true);
		await expect.poll(() => application.evaluate(() => (globalThis as typeof globalThis & { backupCloseDialogs: string[]; }).backupCloseDialogs)).toEqual(['The window could not close because its state was not saved.']);
		await expect.poll(() => page.evaluate(() => document.body.inert)).toBe(false);
		expect(runningApplication.diagnostics.consoleErrors.filter(message => /Failed to save window state before closing/u.test(message))).toHaveLength(1);
		expect(runningApplication.diagnostics.consoleErrors.some(message => /shutdown participants failed/u.test(message))).toBe(true);
		const fault = await page.evaluate(() => {
			const state = (globalThis as typeof globalThis & { backupCloseFault: { calls: number; failedAt: number; fired: boolean; restore(): void; }; }).backupCloseFault;
			state.restore();
			return { calls: state.calls, failedAt: state.failedAt, fired: state.fired, inert: document.body.inert };
		});
		// Recovery can already have retried pending writes; the injected failure stays at the final join.
		expect(fault).toMatchObject({ failedAt: 2, fired: true, inert: false });
		expect(fault.calls).toBeGreaterThanOrEqual(fault.failedAt);
		await application.evaluate(() => (globalThis as typeof globalThis & { restoreBackupCloseDialogs(): void; }).restoreBackupCloseDialogs());
		restored = true;
		await group.editor.input.focus();
		await group.editor.input.press('ControlOrMeta+A');
		await group.editor.input.type('after failed close');
		await expect.poll(backupContents).toContain('after failed close');
		const errors = [...runningApplication.diagnostics.consoleErrors];
		({ workbench } = await reloadWorkbench());
		await expect(workbench.editors.groupAt(0).tabs.filter({ hasText: 'Untitled-1' })).toHaveCount(1);
		await expect(workbench.editors.groupAt(0).editor.lines).toHaveText(['after failed close']);
		const evidence = testInfo.outputPath('backup-shutdown-failure-retry.json');
		await writeFile(evidence, JSON.stringify({ fault, expectedFailure: errors, subsequentEditDurable: true, retryCloseAndRestore: true }));
		await testInfo.attach('backup-shutdown-failure-retry', { path: evidence, contentType: 'application/json' });
	} finally {
		if (!restored && !page.isClosed()) {
			await page.evaluate(() => (globalThis as typeof globalThis & { backupCloseFault: { restore(): void; }; }).backupCloseFault.restore());
			await application.evaluate(() => (globalThis as typeof globalThis & { restoreBackupCloseDialogs(): void; }).restoreBackupCloseDialogs());
		}
	}
});

test('Electron keeps a completed shutdown sealed after its close token expires and restores content after a new close', async ({ target, application, workbench, reloadWorkbench, runningApplication }, testInfo) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'disabled');
	if (!('windows' in application)) throw new Error('Expected the isolated Electron application');
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+N');
	const group = workbench.editors.groupAt(0);
	await group.editor.input.focus();
	await group.editor.input.type('committed draft before expired close');
	await expect.poll(() => workingCopyBackupContents(page)).toContain('committed draft before expired close');
	await application.evaluate(({ dialog }) => {
		const originalTimeout = globalThis.setTimeout;
		const originalDialog = dialog.showMessageBox;
		const state = { messages: [] as string[], expire: undefined as (() => void) | undefined, timer: undefined as ReturnType<typeof setTimeout> | undefined };
		(globalThis as typeof globalThis & { backupCloseDeadline: typeof state & { restore(): void; }; }).backupCloseDeadline = {
			...state,
			restore: () => { globalThis.setTimeout = originalTimeout; dialog.showMessageBox = originalDialog; if (state.timer) clearTimeout(state.timer); },
		};
		const capture = (globalThis as typeof globalThis & { backupCloseDeadline: typeof state; }).backupCloseDeadline;
		globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
			const timer = originalTimeout(...args);
			const [callback, delay, ...parameters] = args;
			if (delay === 30_000) {
				state.timer = timer;
				capture.expire = () => { clearTimeout(timer); callback(...parameters); };
			}
			return timer;
		}) as typeof setTimeout;
		dialog.showMessageBox = (async (...args: unknown[]) => {
			capture.messages.push((args.at(-1) as { message: string; }).message);
			return { response: 0, checkboxChecked: false };
		}) as typeof dialog.showMessageBox;
	});
	await page.evaluate(() => {
		const original = IDBDatabase.prototype.transaction;
		const state = { writes: 0, heldAt: 0, release: undefined as (() => void) | undefined, restore: () => { IDBDatabase.prototype.transaction = original; } };
		(globalThis as typeof globalThis & { backupCompletionGate: typeof state; }).backupCompletionGate = state;
		IDBDatabase.prototype.transaction = function (this: IDBDatabase, ...args: Parameters<typeof original>): ReturnType<typeof original> {
			const transaction = original.apply(this, args);
			if (this.name === 'ash-working-copy-backups' && args[1] === 'readwrite' && ++state.writes === 2) {
				// The real final transaction commits; delay only its completion notification until the main token expires.
				let completed: typeof transaction.oncomplete = null;
				Object.defineProperty(transaction, 'oncomplete', { configurable: true, get: () => completed, set: (handler: typeof completed) => { completed = handler; } });
				transaction.addEventListener('complete', event => {
					state.heldAt = state.writes;
					state.release = () => { Reflect.deleteProperty(transaction, 'oncomplete'); completed?.call(transaction, event); state.release = undefined; };
				}, { once: true });
			}
			return transaction;
		};
	});
	let restored = false;
	try {
		const window = await application.browserWindow(page);
		await window.evaluate(window => window.close());
		await expect.poll(() => page.evaluate(() => (globalThis as typeof globalThis & { backupCompletionGate: { heldAt: number; }; }).backupCompletionGate.heldAt)).toBe(2);
		await application.evaluate(() => {
			const deadline = (globalThis as typeof globalThis & { backupCloseDeadline: { expire?: () => void; }; }).backupCloseDeadline;
			if (!deadline.expire) throw new Error('Main close deadline was not captured');
			deadline.expire();
		});
		await expect.poll(() => application.evaluate(() => (globalThis as typeof globalThis & { backupCloseDeadline: { messages: string[]; }; }).backupCloseDeadline.messages)).toEqual(['The window did not respond to the close request.']);
		await page.evaluate(() => {
			const gate = (globalThis as typeof globalThis & { backupCompletionGate: { release?: () => void; restore(): void; }; }).backupCompletionGate;
			if (!gate.release) throw new Error('Final transaction notification was not held');
			gate.release();
			gate.restore();
		});
		await expect.poll(() => runningApplication.diagnostics.consoleErrors.filter(message => /Failed to complete window close request/u.test(message) && /Window close request is no longer active/u.test(message))).toHaveLength(1);
		await expect.poll(() => page.evaluate(() => document.body.inert)).toBe(true);
		expect(runningApplication.diagnostics.consoleErrors.filter(message => /Failed to save window state before closing/u.test(message))).toEqual([]);
		await expect(group.editor.lines).toHaveText(['committed draft before expired close']);
		const errors = [...runningApplication.diagnostics.consoleErrors];
		await application.evaluate(() => (globalThis as typeof globalThis & { backupCloseDeadline: { restore(): void; }; }).backupCloseDeadline.restore());
		restored = true;
		({ workbench } = await reloadWorkbench());
		await expect(workbench.editors.groupAt(0).tabs.filter({ hasText: 'Untitled-1' })).toHaveCount(1);
		await expect(workbench.editors.groupAt(0).editor.lines).toHaveText(['committed draft before expired close']);
		const evidence = testInfo.outputPath('backup-completion-expired-token-retry.json');
		await writeFile(evidence, JSON.stringify({ finalWriteHeldAt: 2, expectedFailure: errors, sealedAfterCommit: true, newCloseAndRestore: true }));
		await testInfo.attach('backup-completion-expired-token-retry', { path: evidence, contentType: 'application/json' });
	} finally {
		if (!restored && !page.isClosed()) {
			await page.evaluate(() => {
				const gate = (globalThis as typeof globalThis & { backupCompletionGate: { release?: () => void; restore(): void; }; }).backupCompletionGate;
				gate.release?.();
				gate.restore();
			});
			await application.evaluate(() => (globalThis as typeof globalThis & { backupCloseDeadline: { restore(): void; }; }).backupCloseDeadline.restore());
		}
	}
});
