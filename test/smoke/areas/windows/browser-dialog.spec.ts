import { expect, test } from '../../../automation/test.js';
import type { Page } from '@playwright/test';
import type { ISandboxGlobals } from '../../../../src/ash/base/parts/sandbox/electron-browser/sandboxTypes.js';
import { NATIVE_HOST_PICK_FILE_CHANNEL, NATIVE_HOST_SAVE_FILE_CHANNEL } from '../../../../src/ash/platform/native/common/nativeHost.js';
import { nativeHostIpcRoutes, type INativeHostMainService } from '../../../../src/ash/platform/native/electron-main/nativeHostIpc.js';
import { Workbench } from '../../../automation/workbench.js';

test.use({ openWorkspace: false });

test('desktop Workbench and Agents install the complete Host contract and target developer tools at their own window', async ({ target, application, workbench }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'disabled');
	if (!('windows' in application)) { throw new Error('Expected Electron windows'); }
	const agentsPage = await workbench.openAgentsWindow('electron');
	const routes = nativeHostIpcRoutes({} as INativeHostMainService).map(route => {
		try { route.validate(null); }
		catch (error) { return { channel: route.channel, validationError: (error as Error).message }; }
		throw new Error(`Host route ${route.channel} unexpectedly accepts null`);
	});
	for (const page of [workbench.page, agentsPage]) {
		const validation = await page.evaluate(async routes => {
			const host = (globalThis as unknown as { ash: ISandboxGlobals; }).ash;
			return Promise.all(routes.map(async ({ channel, validationError }) => {
				try { await host.ipcRenderer.invoke(channel, null); return { channel, validated: false }; }
				catch (error) { return { channel, validated: String(error).includes(validationError) }; }
			}));
		}, routes);
		expect(validation, page.url()).toEqual(routes.map(({ channel }) => ({ channel, validated: true })));
		const owner = await application.browserWindow(page);
		const other = await application.browserWindow(page === workbench.page ? agentsPage : workbench.page);
		try {
			await page.bringToFront();
			await new Workbench(page).quickaccess.runCommand('workbench.action.toggleDevTools');
			await expect.poll(() => owner.evaluate(window => window.webContents.isDevToolsOpened())).toBe(true);
			expect(await other.evaluate(window => window.webContents.isDevToolsOpened())).toBe(false);
		} finally {
			await owner.evaluate(window => window.webContents.closeDevTools());
		}
	}
});

test('browser keeps its save confirmation in the workbench', async ({ target, workbench }) => {
	test.skip(target.kind !== 'browser', 'This scenario requires the Code browser');
	const page = workbench.page;
	await workbench.quickaccess.runCommand('workbench.action.files.newUntitledFile');
	const input = workbench.editors.groupAt(0).content.locator('.stanza-editor-input');
	await expect(input).toBeVisible();
	await input.focus();
	await input.type('unsaved draft');
	await workbench.quickaccess.runCommand('workbench.action.closeActiveEditor');
	const dialog = page.getByRole('dialog', { name: 'Save Changes' });
	await expect(dialog).toBeVisible();
	await dialog.getByRole('button', { name: "Don't Save" }).click();
	await expect(dialog).toHaveCount(0);
	await workbench.quickaccess.runCommand('workbench.action.reopenClosedEditor');
	await expect(workbench.editors.groupAt(0).tabs.filter({ hasText: 'Untitled-1' })).toHaveCount(0);
});

test('desktop dirty editor sends its choices through the owning window dialog', async ({ target, application, workbench }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'disabled');
	const page = workbench.page;
	await workbench.quickaccess.runCommand('workbench.action.files.newUntitledFile');
	const input = workbench.editors.groupAt(0).content.locator('.stanza-editor-input');
	await input.focus();
	await input.type('unsaved draft');
	const message = await workbench.dialogs.confirm(application, 'Save Changes', "Don't Save", () => workbench.quickaccess.runCommand('workbench.action.closeActiveEditor'));
	expect(message.buttons).toEqual(['Save', "Don't Save", 'Cancel']);
	await expect(input).toHaveCount(0);
});

test('desktop file dialog bridge preserves shared options and complete results in its owning window', async ({ target, application, workbench, testWorkspace }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'disabled');
	if (!('windows' in application)) return;
	const originals = await application.evaluateHandle(({ dialog }) => ({ open: dialog.showOpenDialog, save: dialog.showSaveDialog }));
	try {
		await application.evaluate(({ dialog }, path) => {
			const calls: unknown[] = [];
			(globalThis as unknown as { fileDialogCalls: unknown[]; }).fileDialogCalls = calls;
			dialog.showOpenDialog = (async (window: Electron.BaseWindow, options: Electron.OpenDialogOptions) => {
				calls.push({ windowId: (window as Electron.BrowserWindow).id, options });
				return { canceled: false, filePaths: [path], bookmarks: ['opened-bookmark'] };
			}) as typeof dialog.showOpenDialog;
			dialog.showSaveDialog = (async (window: Electron.BaseWindow, options: Electron.SaveDialogOptions) => {
				calls.push({ windowId: (window as Electron.BrowserWindow).id, options });
				return { canceled: true, filePath: '', bookmark: 'cancelled-bookmark' };
			}) as typeof dialog.showSaveDialog;
		}, testWorkspace.file);
		const open = { title: 'Import', filters: [{ name: 'TypeScript', extensions: ['ts'] }], properties: ['openFile', 'multiSelections', 'showHiddenFiles'], securityScopedBookmarks: true };
		const save = { title: 'Export', defaultPath: testWorkspace.file, nameFieldLabel: 'Name', showsTagField: false, properties: ['showOverwriteConfirmation'], securityScopedBookmarks: true };
		const result = await workbench.page.evaluate(async ({ openChannel, saveChannel, open, save }) => {
			const host = (globalThis as unknown as { ash: ISandboxGlobals; }).ash;
			return [await host.ipcRenderer.invoke(openChannel, open), await host.ipcRenderer.invoke(saveChannel, save)];
		}, { openChannel: NATIVE_HOST_PICK_FILE_CHANNEL, saveChannel: NATIVE_HOST_SAVE_FILE_CHANNEL, open, save });
		expect(result).toEqual([{ canceled: false, filePaths: [testWorkspace.file], bookmarks: ['opened-bookmark'] }, { canceled: true, filePath: '', bookmark: 'cancelled-bookmark' }]);
		const owner = await application.browserWindow(workbench.page);
		const windowId = await owner.evaluate(window => window.id);
		expect(await application.evaluate(() => (globalThis as unknown as { fileDialogCalls: unknown[]; }).fileDialogCalls)).toEqual([{ windowId, options: open }, { windowId, options: save }]);
	} finally {
		await application.evaluate(({ dialog }, originals) => { dialog.showOpenDialog = originals.open; dialog.showSaveDialog = originals.save; }, originals);
		await originals.dispose();
	}
});

test('browser Save As writes an untitled editor to the selected folder', async ({ target, workbench }) => {
	test.skip(target.kind !== 'browser' || target.appServerMode !== 'disabled', 'This scenario requires the standalone Code browser');
	const page = workbench.page;
	const folderName = await page.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		const name = `ash-dialog-save-${crypto.randomUUID()}`;
		const folder = await root.getDirectoryHandle(name, { create: true });
		Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: async () => folder });
		return name;
	});
	await workbench.quickaccess.runCommand('workbench.action.files.newUntitledFile');
	const firstGroup = workbench.editors.groupAt(0);
	const input = firstGroup.editor.input;
	await firstGroup.editor.waitForEditorFocus();
	await firstGroup.editor.waitForTypeInEditor('saved through the file dialog');
	await expect.poll(() => hasWorkingCopyBackup(page, 'saved through the file dialog')).toBe(true);
	await workbench.quickaccess.runCommand('workbench.action.splitEditorHorizontal');
	await expect(workbench.editors.groupAt(1).tabs.filter({ hasText: 'Untitled-1' })).toHaveCount(1);
	await input.press('Control+S');
	const dialog = page.getByRole('dialog', { name: 'Save File' });
	await expect(dialog).toBeVisible();
	await dialog.getByRole('textbox', { name: 'File name, field 1' }).fill('draft.txt');
	await dialog.getByRole('button', { name: 'OK' }).click();
	await expect(dialog).toHaveCount(0);
	for (const index of [0, 1]) {
		await expect(workbench.editors.groupAt(index).tabs.filter({ hasText: 'draft.txt' })).toHaveCount(1);
		await expect(workbench.editors.groupAt(index).tabs.filter({ hasText: 'Untitled-1' })).toHaveCount(0);
	}
	await expect.poll(() => page.evaluate(async name => {
		const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle(name);
		return (await (await folder.getFileHandle('draft.txt')).getFile()).text();
	}, folderName)).toBe('saved through the file dialog');
	await expect.poll(() => hasWorkingCopyBackup(page, 'saved through the file dialog')).toBe(false);
	await firstGroup.tabs.filter({ hasText: 'draft.txt' }).click();
	await workbench.quickaccess.runCommand('workbench.action.files.newUntitledFile');
	await expect(firstGroup.tabs.filter({ hasText: 'Untitled-' })).toHaveAttribute('aria-selected', 'true');
	await firstGroup.editor.waitForEditorFocus();
	await firstGroup.editor.waitForTypeInEditor('replacement draft');
	await firstGroup.editor.input.press('Control+S');
	const secondDialog = page.getByRole('dialog', { name: 'Save File' });
	await secondDialog.getByRole('textbox', { name: 'File name, field 1' }).fill('draft.txt');
	await secondDialog.getByRole('button', { name: 'OK' }).click();
	const replacement = page.getByRole('dialog', { name: 'Confirm' });
	await expect(replacement).toContainText('Replace the existing file draft.txt?');
	await replacement.getByRole('button', { name: 'Cancel' }).click();
	await expect.poll(() => page.evaluate(async name => {
		const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle(name);
		return (await (await folder.getFileHandle('draft.txt')).getFile()).text();
	}, folderName)).toBe('saved through the file dialog');
});

async function hasWorkingCopyBackup(page: Page, content: string): Promise<boolean> {
	return page.evaluate(async expectedContent => {
		const database = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open('ash-working-copy-backups', 1);
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error ?? new Error('Could not read working-copy backups'));
		});
		try {
			const records = await new Promise<Array<{ readonly content?: string; }>>((resolve, reject) => {
				const request = database.transaction('backups', 'readonly').objectStore('backups').getAll();
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error ?? new Error('Could not read working-copy backups'));
			});
			return records.some(record => record.content === expectedContent);
		} finally {
			database.close();
		}
	}, content);
}

test('browser Open File selects multiple files from the current workspace', async ({ target, workbench }) => {
	test.skip(target.kind !== 'browser' || target.appServerMode !== 'disabled', 'This scenario requires the standalone Code browser');
	const page = workbench.page;
	await page.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		const folder = await root.getDirectoryHandle(`ash-dialog-open-${crypto.randomUUID()}`, { create: true });
		const file = await folder.getFileHandle('paper.md', { create: true });
		const writable = await file.createWritable();
		await writable.write('opened through the file dialog');
		await writable.close();
		const second = await folder.getFileHandle('second.md', { create: true });
		const secondWritable = await second.createWritable();
		await secondWritable.write('second file through the dialog');
		await secondWritable.close();
		Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: async () => folder });
	});
	await workbench.quickaccess.runCommand('workbench.action.files.openFolderViaWorkspace');
	await expect(page.locator('.ash-explorer').getByRole('treeitem', { name: 'paper.md', exact: true })).toBeVisible();
	await workbench.quickaccess.runCommand('workbench.action.files.openFile');
	const picker = page.locator('.ash-quick-pick');
	await expect(picker.locator('.ash-quick-pick-row-label', { hasText: 'paper.md' })).toBeVisible();
	await picker.locator('.ash-quick-pick-row-label', { hasText: 'Select paper.md' }).click();
	await picker.locator('.ash-quick-pick-row-label', { hasText: 'Select second.md' }).click();
	await picker.locator('.ash-quick-pick-row-label', { hasText: 'Done (2)' }).click();
	await expect(workbench.editors.groupAt(0).tabs).toContainText(['paper.md', 'second.md']);
	await workbench.editors.groupAt(0).tabs.filter({ hasText: 'second.md' }).click();
	await expect(page.getByRole('tabpanel', { name: 'second.md' }).locator('.stanza-editor-line-text').first()).toHaveText('second file through the dialog');
});
