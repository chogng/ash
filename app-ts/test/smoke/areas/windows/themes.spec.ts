import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '../../../automation/test.js';

test('Seti extension fonts render in Explorer and file icons can be switched off', async ({ application, target, workbench }) => {
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
	for (const id of [null, 'vs-seti']) {
		await workbench.page.evaluate(async id => {
			const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string, args?: unknown): Promise<unknown> } } }).ash.ipcRenderer;
			const snapshot = await ipc.invoke('ash:configuration:read') as { revision: number; document: { source: string } };
			const values = JSON.parse(snapshot.document.source);
			values['workbench.iconTheme'] = id;
			await ipc.invoke('ash:configuration:update', { expectedRevision: snapshot.revision, document: { version: 1, source: JSON.stringify(values) } });
		}, id);
		await expect(icon).toHaveCount(id === null ? 0 : 1);
	}
});

test('Workbench follows system color changes without reopening the window', async ({ workbench }) => {
	await workbench.page.emulateMedia({ colorScheme: 'dark' });
	await expect(workbench.element).toHaveAttribute('data-color-theme', 'ash-dark');
	await workbench.page.emulateMedia({ colorScheme: 'light' });
	await expect(workbench.element).toHaveAttribute('data-color-theme', 'ash-light');
	await expect.poll(() => workbench.element.evaluate(element => getComputedStyle(element).colorScheme)).toBe('light');
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
	if (hasOverlay) {
		await expect.poll(() => application.evaluate(() => (globalThis as unknown as { themeUpdates: { color?: string; symbolColor?: string }[] }).themeUpdates.at(-1))).toEqual({ color: '#18293a', symbolColor: '#fedcba' });
	}
});
