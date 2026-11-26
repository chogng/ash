import { readFile, writeFile } from 'node:fs/promises';
import { expect, test } from '../../../automation/test.js';
import { Workbench } from '../../../automation/workbench.js';

test.use({ electronArgs: ['--agents-window'], electronUserSettings: { 'sessions.pdf.scrollMode': 'paged' }, useDefaultLanguageServer: false });

test('aspdf saves an undo after a renderer crash', { tag: ['@electron-app-server'] }, async ({ application, workbench, testWorkspace }, testInfo) => {
	if (!('windows' in application)) throw new Error('This scenario requires Electron');
	let page = workbench.page;
	const path = testWorkspace.pdfFile;
	const fixture = await readFile(path, 'utf8');
	expect(fixture).toContain('[0 0 300 144]');
	// Keep replacement lengths equal so the synthetic PDF's xref offsets remain valid.
	const original = Buffer.from(fixture.replace('[0 0 300 144]', '[0 0 300 900]').replace('72 72 Td', '8 800 Td'));
	await writeFile(path, original);
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
	const controls = () => page.locator('.ash-editor-group').filter({ has: pdf() }).locator('.ash-editor-group-header > .ash-editor-pane-toolbar-host > .ash-sessions-pdf-controls');
	const annotations = () => pdf().locator('.ash-sessions-pdf-annotation');
	const save = () => controls().getByRole('button', { name: 'Save changes', exact: true });
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
	const reader = pdf().locator('.ash-sessions-pdf-page');
	const viewport = reader.locator('> .ash-scrollbar-viewport');
	const sheet = pdf().locator('.ash-sessions-pdf-stage');
	const isCentered = async (): Promise<boolean> => {
		const frame = (await viewport.boundingBox())!;
		const pageBounds = (await sheet.boundingBox())!;
		return Math.abs(pageBounds.x + pageBounds.width / 2 - frame.x - frame.width / 2) < 1
			&& Math.abs(pageBounds.y + pageBounds.height / 2 - frame.y - frame.height / 2) < 1
			&& pageBounds.height <= frame.height - 23;
	};
	await expect.poll(isCentered).toBe(true);
	await testInfo.attach('pdf-centered-desktop', { body: await page.screenshot(), contentType: 'image/png' });
	const toolbarTop = (await controls().boundingBox())!.y;
	await controls().getByRole('button', { name: 'Fit width', exact: true }).click();
	const zoomWindow = await application.browserWindow(page);
	try {
		const hostZoom = await zoomWindow.evaluate(window => window.webContents.getZoomFactor());
		const before = (await sheet.boundingBox())!;
		const frame = (await viewport.boundingBox())!;
		const anchor = { x: frame.x + frame.width * 0.6, y: frame.y + frame.height * 0.3 };
		const point = { x: (anchor.x - before.x) / before.width, y: (anchor.y - before.y) / before.height };
		await page.mouse.move(anchor.x, anchor.y);
		const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
		await page.keyboard.down(modifier);
		try { await page.mouse.wheel(0, -120); } finally { await page.keyboard.up(modifier); }
		await expect.poll(async () => (await sheet.boundingBox())!.width).toBeGreaterThan(before.width);
		const enlarged = (await sheet.boundingBox())!;
		expect(Math.abs(enlarged.x + enlarged.width * point.x - anchor.x)).toBeLessThan(1.5);
		expect(Math.abs(enlarged.y + enlarged.height * point.y - anchor.y)).toBeLessThan(1.5);
		await controls().getByRole('button', { name: 'Fit page', exact: true }).focus();
		await page.keyboard.press('ControlOrMeta+0');
		await expect.poll(async () => (await sheet.boundingBox())!.width).toBeCloseTo(400, 1);
		await reader.press('ControlOrMeta+=');
		await expect.poll(async () => (await sheet.boundingBox())!.width).toBeGreaterThan(400);
		await reader.press('ControlOrMeta+-');
		await expect.poll(async () => (await sheet.boundingBox())!.width).toBeCloseTo(400, 1);
		expect(await zoomWindow.evaluate(window => window.webContents.getZoomFactor())).toBe(hostZoom);
	} finally { await zoomWindow.dispose(); }

	await reader.hover(); await page.mouse.wheel(0, 480);
	await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
	expect((await controls().boundingBox())!.y).toBe(toolbarTop);
	await reader.press('End');
	await expect.poll(() => viewport.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(1);
	await controls().getByRole('button', { name: 'Fit page', exact: true }).click();
	await expect.poll(isCentered).toBe(true);
	await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBe(0);

	const annotationToolbar = controls().getByRole('toolbar', { name: 'PDF annotations', exact: true });
	await expect(annotationToolbar.getByRole('button')).toHaveCount(5);
	await controls().getByRole('button', { name: 'PDF comments', exact: true }).click();
	await pdf().getByRole('textbox', { name: 'Annotation text', exact: true }).fill('Save before interruption');
	await annotationToolbar.getByRole('button', { name: 'Add note', exact: true }).click();
	await expect(annotations()).toHaveCount(1);
	await save().click();
	await expect.poll(async () => (await readFile(path)).equals(original)).toBe(false);
	await expect(save()).toBeDisabled();
	const annotated = await readFile(path);
	await expect(controls().locator('.ash-sessions-pdf-page-number')).toHaveValue('1');
	await expect(controls().locator('.ash-sessions-pdf-pagination')).toHaveText('/1');
	for (const button of await controls().getByRole('button').all()) { await expect(button.locator('.ash-button-label')).toBeHidden(); }
	await testInfo.attach('pdf-toolbar-desktop', { body: await page.screenshot(), contentType: 'image/png' });

	await pdf().locator('.ash-sessions-pdf-page').press('ControlOrMeta+z');
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
