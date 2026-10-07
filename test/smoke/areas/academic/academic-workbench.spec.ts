import { expect, test } from '../../../automation/test.js';
import { readFile } from 'node:fs/promises';

test('Academic is a document contribution in the Code Workbench', async ({ workbench }) => {
	await expect(workbench.page.locator("[data-action-id='ash.academic.open-sessions']")).toHaveCount(0);
});

test('browser opens and saves Academic beside code without changing Workbench', async ({ target, testWorkspace, workbench }) => {
	test.skip(target.kind !== 'browser' || target.appServerMode !== 'disabled', 'This scenario uses browser workspace files');
	const paper = await readFile(testWorkspace.academicFile, 'utf8');
	const page = workbench.page;
	await page.evaluate(async ({ paper }) => {
		const root = await navigator.storage.getDirectory();
		const folder = await root.getDirectoryHandle(`academic-${crypto.randomUUID()}`, { create: true });
		for (const [name, content] of [['paper.ash-academic', paper], ['main.ts', 'const main = 1;']] as const) {
			const file = await folder.getFileHandle(name, { create: true });
			const writer = await file.createWritable();
			await writer.write(content);
			await writer.close();
		}
		Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: async () => folder });
	}, { paper });
	await workbench.editors.groupAt(0).welcome.getByRole('button', { name: 'Open folder', exact: true }).click();
	const explorer = page.locator('.ash-explorer');
	await explorer.getByRole('treeitem', { name: 'paper.ash-academic', exact: true }).dblclick();
	const group = workbench.editors.groupAt(0);
	const input = group.content.locator('textarea.stanza-document-text-input').first();
	await input.fill('Browser paper');
	await input.press('ControlOrMeta+S');
	await expect.poll(() => page.evaluate(async () => {
		const picker = window as Window & { showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>; };
		const folder = await picker.showDirectoryPicker!();
		return (await (await folder.getFileHandle('paper.ash-academic')).getFile()).text();
	})).toContain('Browser paper');
	await explorer.getByRole('treeitem', { name: 'main.ts', exact: true }).dblclick();
	await expect(group.content.locator('.stanza-editor')).toBeVisible();
	await group.tabs.filter({ hasText: 'paper.ash-academic' }).click();
	await expect(group.content.locator('textarea.stanza-document-text-input').first()).toHaveValue('Browser paper');
});

for (const retiredMode of ['academic', 'unregistered']) {
	test(`browser opens the fixed Workbench and Sessions from a ${retiredMode} mode link`, async ({ target, workbench }) => {
		test.skip(target.kind !== 'browser', 'This scenario enters through a browser URL.');
		const url = new URL(workbench.page.url());
		url.searchParams.set('ash-workbench-mode', retiredMode);
		await workbench.page.goto(url.href);
		await workbench.waitForReady();
		await expect(workbench.page).toHaveTitle(/Ash Code/u);
		const sessions = await workbench.openAgentsWindow('browser');
		expect(new URL(sessions.url()).pathname).toMatch(/sessions\/sessions\.html$/u);
		await expect(sessions.locator('.ash-sessions-window')).toBeVisible();
	});
}
