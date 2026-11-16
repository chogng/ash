import { readFile } from 'node:fs/promises';
import { expect, test } from '../../../automation/test.js';
import { Workbench } from '../../../automation/workbench.js';

test.use({ electronArgs: ['--agents-window'], useDefaultLanguageServer: false });

test('aspdf saves an undo after a renderer crash', { tag: ['@electron-app-server'] }, async ({ application, workbench, testWorkspace }) => {
	if (!('windows' in application)) throw new Error('This scenario requires Electron');
	let page = workbench.page;
	const path = testWorkspace.pdfFile;
	const original = await readFile(path);
	const getBackup = () => page.evaluate(async (): Promise<{ edits: unknown[]; savedEdits: unknown[]; } | undefined> => {
		const database = await new Promise<IDBDatabase>((resolve, reject) => {
			const opening = indexedDB.open('ash-working-copy-backups', 1);
			opening.onsuccess = () => resolve(opening.result);
			opening.onerror = () => reject(opening.error);
		});
		try {
			const rows = await new Promise<Array<{ content: string; }>>((resolve, reject) => {
				const reading = database.transaction('backups', 'readonly').objectStore('backups').index('workspaceId').getAll('sessions-pdf');
				reading.onsuccess = () => resolve(reading.result);
				reading.onerror = () => reject(reading.error);
			});
			return rows[0] && JSON.parse(rows[0].content);
		} finally { database.close(); }
	});
	const pdf = () => page.locator('.ash-sessions-pdf-preview:visible');
	const annotations = () => pdf().locator('.ash-sessions-pdf-annotation');
	const save = () => pdf().getByRole('button', { name: 'Save PDF', exact: true });
	const openPdf = async (workbench: Workbench): Promise<void> => {
		const dialog = await application.evaluateHandle(({ dialog }) => dialog.showOpenDialog);
		try {
			await application.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, path);
			await workbench.quickaccess.runCommand('workbench.action.files.openFile');
			await expect(pdf()).toBeVisible();
		} finally {
			await application.evaluate(({ dialog }, original) => { dialog.showOpenDialog = original; }, dialog);
			await dialog.dispose();
		}
	};

	await openPdf(workbench);
	await pdf().getByRole('textbox', { name: 'Annotation text', exact: true }).fill('Save before interruption');
	await pdf().getByRole('button', { name: 'Add note', exact: true }).click();
	await expect(annotations()).toHaveCount(1);
	await save().click();
	await expect.poll(async () => (await readFile(path)).equals(original)).toBe(false);
	await expect(save()).toBeDisabled();
	const annotated = await readFile(path);

	await pdf().getByRole('button', { name: 'Undo', exact: true }).click();
	await expect(annotations()).toHaveCount(0);
	await expect(save()).toBeEnabled();
	await expect.poll(getBackup).toMatchObject({ edits: [], savedEdits: [{ edit: { kind: 'note', contents: 'Save before interruption' } }] });
	expect((await readFile(path)).equals(annotated)).toBe(true);

	const window = await application.browserWindow(page);
	const recoveryDialog = await application.evaluateHandle(({ dialog }) => {
		const original = dialog.showMessageBox;
		dialog.showMessageBox = async (...args: unknown[]) => {
			const options = args.at(-1) as Electron.MessageBoxOptions;
			if (options.message === 'The window closed unexpectedly.') {
				return { response: options.buttons!.indexOf('Reopen'), checkboxChecked: false };
			}
			return Reflect.apply(original, dialog, args);
		};
		return original;
	});
	try {
		const crashed = page.waitForEvent('crash');
		const replacement = application.waitForEvent('window');
		await window.evaluate(window => window.webContents.forcefullyCrashRenderer());
		await crashed;
		page = await replacement;
	} finally {
		await window.dispose();
		await application.evaluate(({ dialog }, original) => { dialog.showMessageBox = original; }, recoveryDialog);
		await recoveryDialog.dispose();
	}
	await expect(page.locator('.ash-tab-label[aria-label="paper.pdf, unsaved changes"]')).toBeAttached();
	await openPdf(new Workbench(page));
	await expect(save()).toBeEnabled();
	await expect(annotations()).toHaveCount(0);
	expect(await getBackup()).toBeDefined();
	expect((await readFile(path)).equals(annotated)).toBe(true);

	await pdf().locator('.ash-sessions-pdf-page').press('ControlOrMeta+S');
	await expect(save()).toBeDisabled();
	await expect.poll(getBackup).toBeUndefined();
	expect((await readFile(path)).equals(original)).toBe(true);
});
