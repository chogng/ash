import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '../../../automation/test.js';

test('Seti extension fonts render in Explorer and editor tabs and can be switched off', async ({ application, target, workbench }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required', 'Requires extension resources from App Server');
	if (!('windows' in application)) { return; }
	const home = await application.evaluate(() => process.env.ASH_HOME!);
	await cp('../extensions/theme-seti', join(home, 'extensions', 'theme-seti'), { recursive: true });
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
		await workbench.page.emulateMedia({ colorScheme: scheme });
		await expect(workbench.element).toHaveAttribute('data-color-theme', 'ash-' + scheme);
		await expect.poll(async () => (await tabIcon.evaluate(element => getComputedStyle(element).color)) === (await icon.evaluate(element => getComputedStyle(element).color))).toBe(true);
		await expect(tab).toBeFocused();
	}
	for (const id of [null, 'vs-seti']) {
		await workbench.page.evaluate(async id => {
			const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string, args?: unknown): Promise<unknown> } } }).ash.ipcRenderer;
			const snapshot = await ipc.invoke('ash:configuration:read') as { revision: number; document: { source: string } };
			const values = JSON.parse(snapshot.document.source);
			values['workbench.iconTheme'] = id;
			await ipc.invoke('ash:configuration:update', { expectedRevision: snapshot.revision, document: { version: 1, source: JSON.stringify(values) } });
		}, id);
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

test('Workbench follows system color changes without reopening the window', async ({ workbench }) => {
	await workbench.page.emulateMedia({ colorScheme: 'dark' });
	await expect(workbench.element).toHaveAttribute('data-color-theme', 'ash-dark');
	await workbench.page.emulateMedia({ colorScheme: 'light' });
	await expect(workbench.element).toHaveAttribute('data-color-theme', 'ash-light');
	await expect.poll(() => workbench.element.evaluate(element => getComputedStyle(element).colorScheme)).toBe('light');
});

test('Explorer keeps selection distinct from hover and reflects keyboard focus', async ({ target, workbench }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required', 'Requires an App Server workspace');
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
		await page.emulateMedia({ colorScheme: theme.scheme });
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
	const bar = page.locator('[data-part="activitybar"]');
	const selected = bar.locator('.ash-composite-bar-item.checked').first();
	const other = bar.getByRole('tab', { name: 'Search', exact: true });
	for (const theme of ['Ash Light', 'Ash High Contrast Dark', 'Ash High Contrast Light']) {
		await page.getByRole('button', { name: 'Manage', exact: true }).click();
		await page.getByRole('menu').last().getByRole('menuitem', { name: 'Themes', exact: true }).hover();
		await page.getByRole('menu').last().getByRole('menuitem', { name: 'Color Theme', exact: true }).click();
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

	test('Dark and light themes color the shell and Welcome together', async ({ workbench }) => {
		const titleBar = workbench.element.locator('.ash-workbench-titlebar');
		const activityBar = workbench.element.locator('.ash-workbench-activitybar');
		const selectedActivity = activityBar.locator('.ash-composite-bar-item.checked').first();
		const statusBar = workbench.element.locator('.ash-workbench-statusbar');
		const commandCenter = titleBar.locator('.ash-titlebar-command-center-button');
		const welcome = workbench.editors.groupAt(0).welcome;

		await workbench.page.emulateMedia({ colorScheme: 'dark' });
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

		await workbench.page.emulateMedia({ colorScheme: 'light' });
		await expect(workbench.element).toHaveAttribute('data-color-theme', 'ash-light');
		await expect(welcome).toHaveCSS('background-color', 'rgb(255, 255, 255)');
		await expect(titleBar).toHaveCSS('background-color', 'rgb(255, 255, 255)');
		await expect(activityBar).toHaveCSS('background-color', 'rgb(248, 248, 248)');
		await expect(selectedActivity).toHaveCSS('color', 'rgb(31, 31, 31)');
		await expect(statusBar).toHaveCSS('background-color', 'rgb(255, 255, 255)');
		await expect(commandCenter).toHaveCSS('background-color', 'rgb(246, 246, 246)');
	});
});

test('Settings modal dims and restores Electron window controls', async ({ application, target, workbench }) => {
	test.skip(target.kind !== 'electron', 'Requires Electron window controls');
	if (!('windows' in application)) return;
	const hasOverlay = await application.evaluate(({ BrowserWindow }) => {
		if (process.platform === 'darwin') return false;
		const state = globalThis as unknown as { modalControlColors: { color?: string; symbolColor?: string }[] };
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
	await page.emulateMedia({ colorScheme: 'light' });
	await expect(workbench.element).toHaveAttribute('data-color-theme', 'ash-light');
	await page.keyboard.press('ControlOrMeta+Shift+P');
	await page.getByPlaceholder('Type the name of a command to run').fill('Ash Settings');
	await page.keyboard.press('Enter');
	await expect(page.getByRole('dialog', { name: 'Ash Settings' })).toBeVisible();
	await expect.poll(() => application.evaluate(() => {
		const colors = (globalThis as unknown as { modalControlColors: { color?: string; symbolColor?: string }[] }).modalControlColors.at(-1);
		return !!colors && colors.color !== '#ffffff' && colors.symbolColor !== '#424242';
	})).toBe(true);
	await page.getByRole('button', { name: 'Close Ash Settings' }).click();
	await expect(page.getByRole('dialog', { name: 'Ash Settings' })).toHaveCount(0);
	await expect.poll(() => application.evaluate(() => (globalThis as unknown as { modalControlColors: { color?: string; symbolColor?: string }[] }).modalControlColors.at(-1))).toEqual({ color: '#ffffff', symbolColor: '#424242' });
});

test('Desktop migrates a user theme through the file provider and applies its colors', async ({ application, target, workbench }) => {
	test.skip(target.kind !== 'electron', 'Requires the desktop profile file provider');
	if (!('windows' in application)) return;
	const hasOverlay = await application.evaluate(({ BrowserWindow }) => {
		const state = globalThis as unknown as { themeUpdates: { color?: string; symbolColor?: string }[] };
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
	await workbench.page.evaluate(async () => {
		const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string, args?: unknown): Promise<unknown> } } }).ash.ipcRenderer;
		const snapshot = await ipc.invoke('ash:configuration:read') as { revision: number; document: { source: string } };
		const values = JSON.parse(snapshot.document.source);
		values['workbench.colorTheme'] = 'test-migration';
		await ipc.invoke('ash:configuration:update', { expectedRevision: snapshot.revision, document: { version: 1, source: JSON.stringify(values) } });
	});
	await expect.poll(() => workbench.element.evaluate(element => getComputedStyle(element).getPropertyValue('--ash-editor-background').trim())).toBe('#123456');
	await writeFile(join(home, 'themes', 'test-migration.json'), JSON.stringify({
		name: 'Test Migration', type: 'dark',
		colors: { 'editor.background': '#304050', 'titleBar.background': '#18293a', 'titleBar.actionForeground': '#fedcba' },
	}));
	await expect.poll(() => workbench.element.evaluate(element => getComputedStyle(element).getPropertyValue('--ash-editor-background').trim())).toBe('#304050');
	if (hasOverlay) {
		await expect.poll(() => application.evaluate(() => (globalThis as unknown as { themeUpdates: { color?: string; symbolColor?: string }[] }).themeUpdates.at(-1))).toEqual({ color: '#18293a', symbolColor: '#fedcba' });
	}
});
