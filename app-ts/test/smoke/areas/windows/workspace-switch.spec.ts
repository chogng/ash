import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '../../../automation/test.js';
import { parseWorkspace } from '../../../../src/ash/platform/workspace/common/workspace.js';

test('opening another folder waits for the permission choice past 30 seconds', async ({ target, testWorkspace, workbench }) => {
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
	await page.waitForTimeout(31_000);
	await expect(prompt).toBeVisible();
	await prompt.getByRole('button', { name: 'Open Read Only' }).click();
	expect(await opening).toBeUndefined();
	await expect.poll(async () => {
		const workspace = await page.evaluate(() => {
			const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string): Promise<unknown> } } }).ash.ipcRenderer;
			return ipc.invoke('ash:workspace:context:read');
		});
		return parseWorkspace(workspace).folders[0]?.uri.fsPath;
	}).toBe(nextFolder);
});
