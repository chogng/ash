import { readUserSettings, writeUserSettings } from '../../../automation/settings.js';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '../../../automation/test.js';

test('Theme Editor restores one unsaved draft in its auxiliary window after restart', { tag: ['@electron-ui'] }, async ({ workbench, reloadWorkbench }, testInfo) => {
	const mainTabs = workbench.page.getByRole('tablist', { name: 'Open editors', exact: true }).getByRole('tab');
	const originalTabCount = await mainTabs.count();
	const opened = workbench.page.context().waitForEvent('page');
	await workbench.quickaccess.runCommand('workbench.action.openThemeEditor');
	const popup = await opened;
	await popup.getByRole('searchbox', { name: 'Search colors', exact: true }).fill('editor.background');
	await popup.getByRole('textbox', { name: 'Hex color for editor.background', exact: true }).fill('#234567');
	await expect(popup.frameLocator('.ash-theme-editor-preview').locator('#app')).toHaveCSS('--ash-editor-background', '#234567');
	const label = await popup.getByRole('tablist', { name: 'Open editors', exact: true }).locator('.ash-tab-label .ash-icon-label-text').textContent();
	const { workbench: restored } = await reloadWorkbench();
	await expect.poll(() => restored.page.context().pages().length).toBe(2);
	const auxiliary = restored.page.context().pages().find(page => page !== restored.page)!;
	await expect(auxiliary.locator('.ash-theme-editor')).toHaveCount(1);
	await expect(auxiliary.getByRole('tablist', { name: 'Open editors', exact: true }).locator('.ash-tab-label .ash-icon-label-text')).toHaveText(label!);
	await expect(auxiliary.frameLocator('.ash-theme-editor-preview').locator('#app')).toHaveCSS('--ash-editor-background', '#234567');
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
		await expect(preview.getByRole('textbox', { name: 'Terminal input', exact: true })).toBeVisible();
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
	await navigation.getByRole('button', { name: 'Code', exact: true }).click();
	await expect(navigation.getByRole('button', { name: 'Code', exact: true })).toHaveAttribute('aria-current', 'page');
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
	await popup.getByRole('tablist', { name: 'Open editors', exact: true }).getByRole('button', { name: /^Close /u }).click();
	await expect(popup.locator('.ash-theme-editor-preview')).toHaveCount(0);
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
	await tab.focus();
	for (const scheme of ['dark', 'light'] as const) {
		await workbench.setAppearance(application, scheme);
		await expect(workbench.element).toHaveAttribute('data-color-theme', 'ash-' + scheme);
		await expect.poll(async () => (await tabIcon.evaluate(element => getComputedStyle(element).color)) === (await icon.evaluate(element => getComputedStyle(element).color))).toBe(true);
		await expect(tab).toBeFocused();
	}
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
		await expect.poll(() => workbench.element.evaluate(element => {
			const style = getComputedStyle(element);
			return {
				colorScheme: style.colorScheme,
				fontSize: style.getPropertyValue('--ash-fontSize-body1'),
				fontWeight: style.getPropertyValue('--ash-fontWeight-semiBold'),
				itemInset: style.getPropertyValue('--ash-tabList-itemContentInset'),
				oldFontSize: style.getPropertyValue('--ash-font-size-body1'),
				oldFontWeight: style.getPropertyValue('--ash-font-weight-semi-bold'),
			};
		})).toEqual({ colorScheme: scheme, fontSize: '13px', fontWeight: '600', itemInset: '6px', oldFontSize: '', oldFontWeight: '' });
	}
});

test('Explorer keeps selection distinct from hover and reflects keyboard focus', { tag: ['@electron-app-server'] }, async ({ application, target, workbench }) => {
	const page = workbench.page;
	const explorer = page.locator('.ash-explorer');
	const tree = explorer.getByRole('tree');
	const selected = explorer.locator('.ash-tree-row').filter({ hasText: 'main.ts' });
	const hovered = explorer.locator('.ash-tree-row:not(.selected):not(.focused)').first();
	await selected.click();
	for (const theme of [
		{ scheme: 'light', id: 'ash-light', active: 'rgb(232, 232, 232)', foreground: 'rgb(0, 0, 0)', inactive: 'rgb(228, 230, 241)', hover: 'rgb(242, 242, 242)' },
		{ scheme: 'dark', id: 'ash-dark', active: 'rgba(255, 255, 255, 0.13)', foreground: 'rgb(237, 237, 237)', inactive: 'rgb(44, 45, 46)', hover: 'rgba(255, 255, 255, 0.08)' },
	] as const) {
		await workbench.setAppearance(application, theme.scheme);
		await expect(workbench.element).toHaveAttribute('data-color-theme', theme.id);
		await tree.focus();
		await expect(selected).toHaveAttribute('aria-selected', 'true');
		await expect(selected).toHaveCSS('background-color', theme.active);
		await expect(selected).toHaveCSS('color', theme.foreground);
		await selected.hover();
		await expect(selected).toHaveCSS('background-color', theme.active);

		await page.keyboard.press('Tab');
		await expect(tree).not.toBeFocused();
		await expect(selected).toHaveCSS('background-color', theme.inactive);
		await expect(selected).toHaveAttribute('aria-selected', 'true');
		await selected.hover();
		await expect(selected).toHaveCSS('background-color', theme.inactive);

		await hovered.hover();
		await expect(hovered).toHaveCSS('background-color', theme.hover);
	}
});

test('Modern Activity Bar keeps selected styling above hover in high contrast', async ({ workbench }) => {
	const page = workbench.page;
	await workbench.openExplorer();
	const bar = page.locator('[data-part="activitybar"]');
	const selected = bar.locator('.ash-composite-bar-item.checked').first();
	const other = bar.getByRole('tab', { name: 'Search', exact: true });
	for (const theme of ['Ash Light', 'Ash High Contrast Dark', 'Ash High Contrast Light']) {
		await workbench.quickaccess.runCommand('workbench.action.selectTheme');
		const search = page.locator('.ash-quick-pick').getByRole('combobox');
		await search.fill(theme);
		await search.press('Enter');
		await expect(page.locator('.ash-quick-pick')).toHaveCount(0);
		await page.mouse.move(400, 180);
		const selectedStyle = await selected.evaluate(element => {
			const style = getComputedStyle(element, '::after');
			return { background: style.backgroundColor, outline: style.outlineStyle, color: style.outlineColor };
		});
		await selected.hover();
		await expect.poll(() => selected.evaluate(element => {
			const style = getComputedStyle(element, '::after');
			return { background: style.backgroundColor, outline: style.outlineStyle, color: style.outlineColor };
		})).toEqual(selectedStyle);
		if (theme.includes('High Contrast')) {
			expect(selectedStyle.outline).toBe('solid');
			await other.hover();
			await expect.poll(() => other.evaluate(element => getComputedStyle(element, '::after').outlineStyle)).toBe('dashed');
		}
	}
});

test.describe('Workbench shell colors', () => {
	test.use({ openWorkspace: false });

	test('Dark and light themes color the shell and Welcome together', async ({ application, workbench }) => {
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
		await expect(commandCenter).toHaveCSS('background-color', 'rgb(43, 43, 43)');
		await expect(commandCenter).toHaveCSS('color', 'rgb(204, 204, 204)');
		await expect(statusBar).toHaveCSS('color', 'rgb(204, 204, 204)');

		await workbench.setAppearance(application, 'light');
		await expect(workbench.element).toHaveAttribute('data-color-theme', 'ash-light');
		await expect(welcome).toHaveCSS('background-color', 'rgb(255, 255, 255)');
		await expect(titleBar).toHaveCSS('background-color', 'rgb(255, 255, 255)');
		await expect(activityBar).toHaveCSS('background-color', 'rgb(248, 248, 248)');
		await expect(selectedActivity).toHaveCSS('color', 'rgb(31, 31, 31)');
		await expect(statusBar).toHaveCSS('background-color', 'rgb(255, 255, 255)');
		await expect(commandCenter).toHaveCSS('background-color', 'rgb(246, 246, 246)');
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
		{ setting: 'editor.tokenColorCustomizations', key: 'textMateRules', value: [{ scope: 'variable.other.readwrite', settings: { foreground: '#654321', fontStyle: 'bold' } }] },
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
