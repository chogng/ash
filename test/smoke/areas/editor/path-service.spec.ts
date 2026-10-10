import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '../../../automation/test.js';
import { Menus } from '../../../automation/menus.js';

test('file name validation keeps keyboard focus and preserves the created and renamed basename', async ({ application, target, testWorkspace, workbench }) => {
	test.skip(target.kind === 'electron' && target.appServerMode !== 'required', 'Creating disk files requires the App Server.');
	const page = workbench.page;
	const browserFiles = target.kind === 'browser' && target.appServerMode === 'disabled';
	let folderName: string | undefined;
	if (browserFiles) {
		folderName = await page.evaluate(async () => {
			const name = `path-service-${crypto.randomUUID()}`;
			const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle(name, { create: true });
			Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: async () => folder });
			return name;
		});
		await workbench.editors.groupAt(0).welcome.getByRole('button', { name: 'Open folder', exact: true }).click();
		await expect(page.locator('.ash-explorer-title').getByRole('button', { name: folderName, exact: true })).toBeVisible();
		await workbench.waitForReady();
	}
	const name = browserFiles || process.platform === 'win32' ? 'created.txt' : 'part\\name.txt';
	await workbench.quickaccess.runCommand('explorer.newFile');
	const input = page.getByRole('textbox', { name: 'New File Name', exact: true });
	await expect(input).toBeFocused();
	await input.fill('../escape');
	await input.press('Enter');
	await expect(input).toHaveAttribute('aria-invalid', 'true');
	await expect(input).toBeFocused();
	await expect(page.getByText('Enter a valid file name for the target file system.', { exact: true })).toBeVisible();
	await input.fill(name);
	await input.press('Enter');
	const explorer = page.locator('.ash-explorer');
	const file = explorer.getByRole('treeitem', { name, exact: true });
	await expect(file).toBeVisible();
	await new Menus(page).select(application, () => file.click({ button: 'right' }), ['Rename']);
	const rename = page.getByRole('textbox', { name: 'Rename', exact: true });
	await expect(rename).toHaveValue(name);
	const renamed = `renamed-${name}`;
	await rename.fill(renamed);
	await rename.press('Enter');
	await expect(explorer.getByRole('treeitem', { name: renamed, exact: true })).toBeVisible();
	await expect(file).toHaveCount(0);
	if (browserFiles) {
		expect(await page.evaluate(async ({ folderName, renamed }) => {
			const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle(folderName!);
			return (await (await folder.getFileHandle(renamed)).getFile()).text();
		}, { folderName, renamed })).toBe('');
	} else {
		expect(await readFile(join(testWorkspace.directory, renamed), 'utf8')).toBe('');
	}
});

test('server folder selection preserves a POSIX backslash through workspace authorization', async ({ target, workbench }) => {
	test.skip(target.kind !== 'browser' || target.appServerMode !== 'required' || process.platform === 'win32', 'Requires a browser connected to a POSIX App Server.');
	const page = workbench.page;
	const root = await page.evaluate(() => {
		const workspace = globalThis.ashWebWorkbenchHost!.workspace!;
		if (!('uri' in workspace)) throw new Error('Expected a folder workspace');
		return workspace.uri.path;
	});
	const folderName = 'part\\folder';
	const selected = join(root, folderName);
	await mkdir(selected);
	await writeFile(join(selected, 'selected.txt'), 'selected folder\n');
	await workbench.quickaccess.runCommand('workbench.action.files.openFolder');
	const picker = page.getByRole('dialog', { name: 'Choose a server folder', exact: true });
	await picker.getByText(folderName, { exact: true }).click();
	await picker.getByText('Select this folder', { exact: true }).click();
	await page.getByRole('dialog', { name: 'Authorize Server Folder', exact: true }).getByRole('button', { name: 'Open Folder', exact: true }).click();
	await page.waitForFunction(expected => {
		const workspace = globalThis.ashWebWorkbenchHost?.workspace;
		return workspace && 'uri' in workspace && workspace.uri.path === expected;
	}, selected);
	await workbench.waitForReady();
	expect(await page.evaluate(async () => {
		const host = globalThis.ashWebWorkbenchHost!;
		return (await host.api.fs.readFile({ dirId: host.workspace!.id, path: 'selected.txt' })).content;
	})).toBe('selected folder\n');
});
