import { expect, test } from '../../../automation/test.js';
import { readFile } from 'node:fs/promises';

test('disconnected browser preserves and saves Academy source beside code', { tag: ['@browser-ui'] }, async ({ testWorkspace, workbench }) => {
	const paper = await readFile(testWorkspace.academyFile, 'utf8');
	const page = workbench.page;
	await page.evaluate(async ({ paper }) => {
		const root = await navigator.storage.getDirectory();
		const folder = await root.getDirectoryHandle(`academy-${crypto.randomUUID()}`, { create: true });
		for (const [name, content] of [['paper.ash-academy', paper], ['main.ts', 'const main = 1;']] as const) {
			const file = await folder.getFileHandle(name, { create: true });
			const writer = await file.createWritable();
			await writer.write(content);
			await writer.close();
		}
		Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: async () => folder });
	}, { paper });
	await workbench.editors.groupAt(0).welcome.getByRole('button', { name: 'Open folder', exact: true }).click();
	const explorer = page.locator('.ash-explorer');
	await explorer.getByRole('treeitem', { name: 'paper.ash-academy', exact: true }).dblclick();
	const group = workbench.editors.groupAt(0);
	// The disconnected catalog deliberately contributes no custom editors.
	// Keep the source editable; connected smoke coverage exercises Academy's engine.
	await expect(group.content.locator('.stanza-structured-editor-pane')).toHaveCount(0);
	const input = group.editor.input;
	await group.editor.waitForEditorFocus();
	await input.press('ControlOrMeta+End');
	await input.press('Enter');
	await input.press('ControlOrMeta+S');
	await expect.poll(() => page.evaluate(async () => {
		const picker = window as Window & { showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>; };
		const folder = await picker.showDirectoryPicker!();
		return (await (await folder.getFileHandle('paper.ash-academy')).getFile()).text();
	})).toBe(paper + '\n');
	await explorer.getByRole('treeitem', { name: 'main.ts', exact: true }).dblclick();
	await expect(group.editor.element).toHaveAttribute('aria-label', 'main.ts');
	await group.editor.waitForEditorContents(contents => contents === 'const main = 1;');
	await group.tabs.filter({ hasText: 'paper.ash-academy' }).click();
	await group.editor.waitForEditorContents(contents => contents.startsWith(paper));
});
