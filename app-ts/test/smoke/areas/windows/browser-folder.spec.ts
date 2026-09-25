import { expect, test } from '../../../automation/test.js';

test.use({ openWorkspace: false });

test('browser opens an authorized local folder and saves its files', async ({ target, workbench }) => {
	test.skip(target.kind !== 'browser' || target.workbenchMode !== 'code' || target.appServerMode !== 'disabled', 'This scenario requires the standalone Code browser');
	const page = workbench.page;
	const folderName = await page.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		const name = `ash-browser-%中-${crypto.randomUUID()}`;
		const folder = await root.getDirectoryHandle(name, { create: true });
		const file = await folder.getFileHandle('hello %中.txt', { create: true });
		const writable = await file.createWritable();
		await writable.write('first value');
		await writable.close();
		Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: async () => folder });
		return name;
	});
	await page.getByRole('button', { name: 'Application menu' }).click();
	await page.getByRole('menu').first().getByRole('menuitem', { name: 'File' }).click();
	await expect(page.getByRole('menu').last().getByRole('menuitem', { name: 'Open Folder...' })).toHaveCount(1);
	await page.keyboard.press('Escape');
	await page.keyboard.press('Escape');

	const showSidebar = page.getByRole('button', { name: 'Show Primary Side Bar', exact: true });
	if (await showSidebar.isVisible()) await showSidebar.click();
	await page.getByRole('button', { name: 'Open Folder', exact: true }).click();
	const explorer = page.locator('.ash-explorer');
	const fileRow = explorer.locator('.ash-tree-row').filter({ hasText: 'hello %中.txt' });
	await expect(fileRow).toHaveCount(1);
	if (await showSidebar.isVisible()) await showSidebar.click();
	await expect(explorer).toBeVisible();
	await expect(fileRow).toBeVisible();
	await fileRow.click();
	const input = workbench.editors.groupAt(0).content.locator('.stanza-editor-input');
	await expect(input).toBeAttached();
	await input.focus();
	await input.press('Control+A');
	await input.type('second value');
	await input.press('Control+S');
	await expect.poll(() => page.evaluate(async name => {
		const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle(name);
		return (await (await folder.getFileHandle('hello %中.txt')).getFile()).text();
	}, folderName)).toBe('second value');
	await page.getByRole('button', { name: 'Application menu' }).click();
	await page.getByRole('menu').first().getByRole('menuitem', { name: 'File' }).click();
	await expect(page.getByRole('menu').last().getByRole('menuitem', { name: 'Open Folder...' })).toHaveCount(1);
});
