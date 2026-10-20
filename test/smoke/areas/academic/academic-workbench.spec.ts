import { expect, test } from '../../../automation/test.js';
import { readFile } from 'node:fs/promises';

test('disconnected browser preserves and saves Academic source beside code', { tag: ['@browser-ui'] }, async ({ testWorkspace, workbench }) => {
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
	// The disconnected catalog deliberately contributes no custom editors.
	// Keep the source editable; connected smoke coverage exercises Academic's engine.
	await expect(group.content.locator('.stanza-structured-editor-pane')).toHaveCount(0);
	const input = group.editor.input;
	await group.editor.waitForEditorFocus();
	await input.press('ControlOrMeta+End');
	await input.press('Enter');
	await input.press('ControlOrMeta+S');
	await expect.poll(() => page.evaluate(async () => {
		const picker = window as Window & { showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>; };
		const folder = await picker.showDirectoryPicker!();
		return (await (await folder.getFileHandle('paper.ash-academic')).getFile()).text();
	})).toBe(paper + '\n');
	await explorer.getByRole('treeitem', { name: 'main.ts', exact: true }).dblclick();
	await expect(group.editor.element).toHaveAttribute('aria-label', 'main.ts');
	await group.editor.waitForEditorContents(contents => contents === 'const main = 1;');
	await group.tabs.filter({ hasText: 'paper.ash-academic' }).click();
	await group.editor.waitForEditorContents(contents => contents.startsWith(paper));
});

for (const retiredMode of ['academic', 'unregistered']) {
	test(`browser opens the fixed Workbench and Sessions from a ${retiredMode} mode link`, { tag: ['@browser-ui', '@browser-app-server'] }, async ({ target, workbench }) => {
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
