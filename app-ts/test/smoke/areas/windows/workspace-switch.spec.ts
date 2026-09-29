import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ElectronApplication } from '@playwright/test';
import type { BrowserWindow, MessageBoxOptions } from 'electron';
import { expect, test } from '../../../automation/test.js';
import { parseWorkspace } from '../../../../src/ash/platform/workspace/common/workspace.js';

test('repeated folder opens wait for the permission choice past 30 seconds', async ({ target, testWorkspace, workbench }) => {
	test.setTimeout(75_000);
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required' || target.workbenchMode !== 'code', 'This scenario requires the Code desktop and App Server');
	const nextFolder = join(testWorkspace.directory, 'next-folder');
	await mkdir(nextFolder);
	const page = workbench.page;
	const initial = await page.evaluate(() => {
		const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string): Promise<unknown> } } }).ash.ipcRenderer;
		return ipc.invoke('ash:workspace:context:read');
	});
	expect(parseWorkspace(initial).folders[0]?.uri.fsPath).toBe(testWorkspace.directory);

	const opening = page.evaluate(folder => {
		const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string, value: unknown): Promise<void> } } }).ash.ipcRenderer;
		return ipc.invoke('ash:native-host:open-workspace', folder);
	}, nextFolder).then(() => undefined, error => String(error));
	const prompt = page.getByRole('dialog', { name: 'Ash' });
	await expect(prompt).toBeVisible();
	const repeatedOpening = page.evaluate(folder => {
		const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string, value: unknown): Promise<void> } } }).ash.ipcRenderer;
		return ipc.invoke('ash:native-host:open-workspace', folder);
	}, nextFolder).then(() => undefined, error => String(error));
	await page.waitForTimeout(31_000);
	await expect(prompt).toBeVisible();
	await prompt.getByRole('button', { name: 'Open Read Only' }).click();
	expect(await Promise.all([opening, repeatedOpening])).toEqual([undefined, undefined]);
	await expect.poll(async () => {
		const workspace = await page.evaluate(() => {
			const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string): Promise<unknown> } } }).ash.ipcRenderer;
			return ipc.invoke('ash:workspace:context:read');
		});
		return parseWorkspace(workspace).folders[0]?.uri.fsPath;
	}).toBe(nextFolder);
});

test('opening a folder displays its files in Explorer', async ({ target, testWorkspace, workbench }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required' || target.workbenchMode !== 'code', 'This scenario requires the Code desktop and App Server');
	const nextFolder = join(testWorkspace.directory, 'visible-folder');
	await mkdir(nextFolder);
	await writeFile(join(nextFolder, 'visible.txt'), 'visible');
	await mkdir(join(nextFolder, 'inner'));
	await writeFile(join(nextFolder, 'inner', 'nested.txt'), 'nested');
	const page = workbench.page;
	const opening = page.evaluate(folder => {
		const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string, value: unknown): Promise<void> } } }).ash.ipcRenderer;
		return ipc.invoke('ash:native-host:open-workspace', folder);
	}, nextFolder);
	const prompt = page.getByRole('dialog', { name: 'Ash' });
	await expect(prompt).toBeVisible();
	await prompt.getByRole('button', { name: 'Open Read Only' }).click();
	await opening;
	const file = page.locator('.ash-explorer .ash-tree-row').filter({ hasText: 'visible.txt' });
	await expect(file).toHaveCount(1);
	const fileRow = await file.elementHandle();
	const folder = page.locator('.ash-explorer').getByRole('treeitem', { name: 'inner', exact: true });
	await folder.click();
	await expect(page.locator('.ash-explorer .ash-tree-row').filter({ hasText: 'nested.txt' })).toHaveCount(1);
	await expect(folder).toHaveAttribute('aria-expanded', 'true');
	await folder.click();
	await expect(folder).toHaveAttribute('aria-expanded', 'false');
	await expect(page.locator('.ash-explorer .ash-tree-row').filter({ hasText: 'nested.txt' })).toHaveCount(0);
	expect(await fileRow?.evaluate(row => row.isConnected)).toBe(true);
});

test('Explorer file context menu includes file actions for the clicked row', async ({ target, application, workbench }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required' || target.workbenchMode !== 'code', 'This scenario requires the Code desktop and App Server');
	const electron = application as ElectronApplication;
	await electron.evaluate(({ Menu }) => {
		const originalPopup = Menu.prototype.popup;
		const state = globalThis as typeof globalThis & { ashExplorerMenuTest?: { labels: string[]; restore: () => void } };
		state.ashExplorerMenuTest = {
			labels: [],
			restore: () => { Menu.prototype.popup = originalPopup; },
		};
		Menu.prototype.popup = function(options) {
			state.ashExplorerMenuTest!.labels = this.items.map(item => item.label);
			options?.callback?.();
		};
	});
	try {
		const file = workbench.page.locator('.ash-explorer .ash-tree-row').filter({ hasText: 'main.ts' });
		await file.click({ button: 'right' });
		await expect.poll(() => electron.evaluate(() => (globalThis as typeof globalThis & { ashExplorerMenuTest?: { labels: string[] } }).ashExplorerMenuTest?.labels)).toEqual(expect.arrayContaining([
			'Open to the Side',
			'Copy Path',
			'Copy Relative Path',
			'Rename',
			'Delete Permanently',
		]));
		const labels = await electron.evaluate(() => (globalThis as typeof globalThis & { ashExplorerMenuTest?: { labels: string[] } }).ashExplorerMenuTest?.labels ?? []);
		expect(labels).not.toContain('New File...');
		expect(labels).not.toContain('New Folder...');
		expect(labels).not.toContain('Download File...');
	} finally {
		await electron.evaluate(({ Menu }) => {
			(globalThis as typeof globalThis & { ashExplorerMenuTest?: { restore: () => void } }).ashExplorerMenuTest?.restore();
		});
	}
});

test('Explorer opens the focused file context menu from the keyboard', async ({ target, application, workbench }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required' || target.workbenchMode !== 'code', 'This scenario requires the Code desktop and App Server');
	const electron = application as ElectronApplication;
	await electron.evaluate(({ Menu }) => {
		const originalPopup = Menu.prototype.popup;
		const state = globalThis as typeof globalThis & { ashExplorerKeyboardMenuTest?: { labels: string[]; restore: () => void } };
		state.ashExplorerKeyboardMenuTest = {
			labels: [],
			restore: () => { Menu.prototype.popup = originalPopup; },
		};
		Menu.prototype.popup = function(options) {
			state.ashExplorerKeyboardMenuTest!.labels = this.items.map(item => item.label);
			options?.callback?.();
		};
	});
	try {
		const file = workbench.page.locator('.ash-explorer .ash-tree-row').filter({ hasText: 'main.ts' });
		await file.click();
		await workbench.page.keyboard.press('Shift+F10');
		await expect.poll(() => electron.evaluate(() => (globalThis as typeof globalThis & { ashExplorerKeyboardMenuTest?: { labels: string[] } }).ashExplorerKeyboardMenuTest?.labels)).toContain('Rename');
	} finally {
		await electron.evaluate(({ Menu }) => {
			(globalThis as typeof globalThis & { ashExplorerKeyboardMenuTest?: { restore: () => void } }).ashExplorerKeyboardMenuTest?.restore();
		});
	}
});

test('Explorer file shortcuts target the selected file', async ({ target, application, workbench }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required' || target.workbenchMode !== 'code', 'This scenario requires the Code desktop and App Server');
	const electron = application as ElectronApplication;
	await electron.evaluate(({ dialog }) => {
		const original = dialog.showMessageBox.bind(dialog);
		const state = globalThis as typeof globalThis & { ashExplorerDeleteDialogTest?: { message?: string; restore: () => void } };
		state.ashExplorerDeleteDialogTest = { restore: () => { dialog.showMessageBox = original; } };
		dialog.showMessageBox = (async (...args: [MessageBoxOptions] | [BrowserWindow, MessageBoxOptions]) => {
			const options = args.length === 1 ? args[0] : args[1];
			state.ashExplorerDeleteDialogTest!.message = options.message;
			return { response: 1, checkboxChecked: false };
		}) as typeof dialog.showMessageBox;
	});
	try {
		const page = workbench.page;
		await page.locator('.ash-explorer .ash-tree-row').filter({ hasText: 'main.ts' }).click();
		await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Alt+Backspace' : 'Shift+Delete');
		await expect.poll(() => electron.evaluate(() => (globalThis as typeof globalThis & { ashExplorerDeleteDialogTest?: { message?: string } }).ashExplorerDeleteDialogTest?.message)).toBe('Permanently delete main.ts?');
		await page.keyboard.press(process.platform === 'darwin' ? 'Enter' : 'F2');
		const input = page.locator('.ash-quick-pick-input input');
		await expect(input).toBeVisible();
		await expect(input).toHaveValue('main.ts');
		await input.press('Escape');
	} finally {
		await electron.evaluate(({ dialog }) => {
			(globalThis as typeof globalThis & { ashExplorerDeleteDialogTest?: { restore: () => void } }).ashExplorerDeleteDialogTest?.restore();
		});
	}
});

test('Explorer creates a child folder from a folder context menu', async ({ target, application, testWorkspace, workbench }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required' || target.workbenchMode !== 'code', 'This scenario requires the Code desktop and App Server');
	const parent = join(testWorkspace.directory, 'menu-parent');
	await mkdir(parent);
	const electron = application as ElectronApplication;
	await electron.evaluate(({ Menu }) => {
		const originalPopup = Menu.prototype.popup;
		const state = globalThis as typeof globalThis & { ashExplorerFolderTest?: { restore: () => void } };
		state.ashExplorerFolderTest = { restore: () => { Menu.prototype.popup = originalPopup; } };
		Menu.prototype.popup = function(options) {
			const folder = this.items.find(item => item.label === 'New Folder...');
			const select = folder?.click as (() => void) | undefined;
			select?.();
			options?.callback?.();
		};
	});
	try {
		const folder = workbench.page.locator('.ash-explorer .ash-tree-row').filter({ hasText: 'menu-parent' });
		await expect(folder).toHaveCount(1);
		await folder.click({ button: 'right' });
		const input = workbench.page.locator('.ash-quick-pick-input input');
		await expect(input).toBeVisible();
		await input.fill('created-from-menu');
		await input.press('Enter');
		await expect.poll(async () => stat(join(parent, 'created-from-menu')).then(metadata => metadata.isDirectory(), () => false)).toBe(true);
		await folder.click();
		await expect(workbench.page.locator('.ash-explorer .ash-tree-row').filter({ hasText: 'created-from-menu' })).toHaveCount(1);
	} finally {
		await electron.evaluate(({ Menu }) => {
			(globalThis as typeof globalThis & { ashExplorerFolderTest?: { restore: () => void } }).ashExplorerFolderTest?.restore();
		});
	}
});

test('Explorer expands and collapses a refreshed folder without replacing sibling rows', async ({ target, testWorkspace, workbench }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required' || target.workbenchMode !== 'code', 'This scenario requires the Code desktop and App Server');
	const page = workbench.page;
	const explorer = page.locator('.ash-explorer');
	const sibling = explorer.locator('.ash-tree-row').filter({ hasText: 'main.ts' });
	await expect(sibling).toHaveCount(1);
	const siblingRow = await sibling.elementHandle();
	const folderPath = join(testWorkspace.directory, 'expandable');
	await mkdir(folderPath);
	await writeFile(join(folderPath, 'nested.txt'), 'nested');
	const folder = explorer.getByRole('treeitem', { name: 'expandable', exact: true });
	await expect(folder).toHaveCount(1);
	await folder.click();
	const nested = explorer.locator('.ash-tree-row').filter({ hasText: 'nested.txt' });
	await expect(folder).toHaveAttribute('aria-expanded', 'true');
	await expect(nested).toHaveCount(1);
	await folder.click();
	await expect(folder).toHaveAttribute('aria-expanded', 'false');
	await expect(nested).toHaveCount(0);
	await folder.click();
	await expect(folder).toHaveAttribute('aria-expanded', 'true');
	await expect(nested).toHaveCount(1);
	await folder.locator('.ash-tree-contents').click({ clickCount: 2 });
	await expect(folder).toHaveAttribute('aria-expanded', 'true');
	await expect(nested).toHaveCount(1);
	expect(await siblingRow?.evaluate(row => row.isConnected)).toBe(true);
});
