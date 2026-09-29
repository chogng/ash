import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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
