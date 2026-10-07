import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '../../../automation/test.js';

const source = 'function zebra() {\n  function nested() { return 1; }\n  return nested();\n}\nfunction alpha() { return 2; }\n';

test.describe('Explorer empty views', () => {
	test.use({ openWorkspace: false });
	test('Explorer keeps Outline and Timeline collapsed in an empty window and restores accessible focus', async ({ target, workbench }) => {
		test.skip(target.kind === 'browser' && target.appServerMode === 'required', 'The connected Web fixture always opens a workspace; browser-ui covers the empty window.');
		const page = workbench.page;
		await workbench.openExplorer();
		const empty = page.locator('[data-view-id="ash.emptyExplorer"]');
		await expect(empty.locator('.ash-pane-view-header')).toBeVisible();
		for (const [id, title, message] of [['outline', 'Outline', 'The active editor cannot provide outline information.'], ['timeline', 'Timeline', 'Select a file to view its timeline.']] as const) {
			const view = page.locator(`[data-view-id="${id}"]`);
			const header = view.locator('.ash-pane-view-header').getByRole('button', { name: title, exact: true });
			await expect(header).toHaveAttribute('aria-expanded', 'false');
			await header.click();
			const status = view.getByRole('status');
			await expect(status).toHaveText(message);
			await status.focus();
			await status.press('Alt+F1');
			const help = page.getByRole('dialog', { name: 'Accessibility Help', exact: true });
			await expect(help.getByRole('textbox')).toHaveValue(new RegExp(`^${title}\\nUse the arrow keys`));
			await page.keyboard.press('Escape');
			await expect(status).toBeFocused();
			await status.press('Alt+F2');
			const accessible = page.getByRole('dialog', { name: 'Accessible View', exact: true });
			await expect(accessible.getByRole('textbox')).toHaveValue(new RegExp(message.replaceAll('.', '\\.')));
			await page.keyboard.press('Escape');
			await expect(status).toBeFocused();
			await header.click();
		}
	});

	test('Explorer initializes Outline and Timeline in Chinese after restart', async ({ workbench, restartWorkbench, restartMessage }) => {
		let page = workbench.page;
		await page.keyboard.press('ControlOrMeta+,');
		const settings = page.locator('.ash-settings-editor');
		await settings.locator('[data-settings-category-id="general"]').click();
		const language = settings.getByRole('combobox', { name: 'Interface language', exact: true });
		await language.focus();
		await language.press('Enter');
		await page.keyboard.press('ArrowDown');
		await page.keyboard.press('Enter');
		await expect.poll(restartMessage).toBe('Restart Ash to use 简体中文?');
		({ workbench } = await restartWorkbench());
		page = workbench.page;
		const explorer = page.getByRole('tab', { name: '资源管理器', exact: true });
		if (await explorer.getAttribute('aria-selected') !== 'true' || !await page.locator('[data-part="sidebar"]').isVisible()) await explorer.click();
		for (const [id, title, message] of [['outline', '大纲', '当前编辑器无法提供大纲信息。'], ['timeline', '时间线', '选择文件以查看时间线。']] as const) {
			const view = page.locator(`[data-view-id="${id}"]`);
			await view.locator('.ash-pane-view-header').getByRole('button', { name: title, exact: true }).click();
			const status = view.getByRole('status');
			await expect(status).toHaveText(message);
			await status.focus();
			await status.press('Alt+F1');
			await expect(page.getByRole('dialog', { name: '无障碍帮助', exact: true }).getByRole('textbox')).toHaveValue(new RegExp(`^${title}\\n使用方向键`));
			await page.keyboard.press('Escape');
			await expect(status).toBeFocused();
		}
	});

});

test.beforeEach(async ({ target, testWorkspace }) => {
	if (target.appServerMode === 'required') {
		await writeFile(join(testWorkspace.directory, 'main.ts'), source);
		await writeFile(join(testWorkspace.directory, 'other.ts'), 'const other = 0;');
	}
});

test('Outline shows real nested symbols, filters, sorts, and navigates the editor', async ({ target, application, workbench }) => {
	test.skip(target.appServerMode !== 'required', 'Document symbols require the language backend.');
	const page = workbench.page;
	await page.locator('.ash-explorer').getByRole('treeitem', { name: 'main.ts', exact: true }).dblclick();
	await page.locator('[data-view-id="outline"] .ash-pane-view-header-button').click();
	const view = page.locator('[data-view-id="outline"]');
	const tree = view.getByRole('tree');
	await expect(view.locator('.ash-outline-label')).toHaveText(['zebra', 'nested', 'alpha']);
	await tree.focus();
	await tree.press('ControlOrMeta+f');
	const find = tree.getByRole('searchbox', { name: 'Find in Tree' });
	await find.fill('nested');
	await expect(view.locator('.ash-outline-label')).toHaveText(['zebra', 'nested']);
	await find.press('Escape');
	await expect(tree).toBeFocused();
	await expect(view.locator('.ash-outline-label')).toHaveText(['zebra', 'nested', 'alpha']);
	const actions = view.getByRole('button', { name: 'More Actions', exact: true });
	await workbench.menus.select(application, () => actions.click(), ['Sort by Name']);
	await expect(view.locator('.ash-outline-label')).toHaveText(['alpha', 'zebra', 'nested']);
	await view.getByRole('treeitem', { name: 'alpha', exact: true }).click();
	await tree.press('Enter');
	await expect(workbench.editors.groupAt(0).editor.input).toBeFocused();
	await expect(workbench.editors.groupAt(0).editor.element.getByText('Line 5, column 15, 5 characters selected', { exact: true })).toHaveText('Line 5, column 15, 5 characters selected');
	// Replacing the document must refresh the retained outline rather than the editor pane.
	await page.keyboard.press('ControlOrMeta+a');
	await page.keyboard.insertText('function replacement() { return 3; }');
	await expect(view.locator('.ash-outline-label')).toHaveText(['replacement']);
});

test('Timeline records saves, compares a snapshot, and follows the selected file', async ({ target, application, workbench, reloadWorkbench }) => {
	test.skip(target.kind === 'electron' && target.appServerMode !== 'required', 'Workspace files require App Server on desktop.');
	const page = workbench.page;
	if (target.kind === 'browser' && target.appServerMode === 'disabled') {
		await page.evaluate(async () => {
			const root = await navigator.storage.getDirectory();
			const folder = await root.getDirectoryHandle(`timeline-${crypto.randomUUID()}`, { create: true });
			for (const [name, text] of [['main.ts', 'const initial = 0;'], ['other.ts', 'const other = 0;']] as const) {
				const writer = await (await folder.getFileHandle(name, { create: true })).createWritable();
				await writer.write(text);
				await writer.close();
			}
			Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: async () => folder });
		});
		await workbench.editors.groupAt(0).welcome.getByRole('button', { name: 'Open folder', exact: true }).click();
	}
	await page.locator('.ash-explorer').getByRole('treeitem', { name: 'main.ts', exact: true }).dblclick();
	await page.locator('[data-view-id="timeline"] .ash-pane-view-header-button').click();
	const timeline = page.locator('[data-view-id="timeline"]');
	const editor = workbench.editors.groupAt(0).editor;
	for (const [index, text] of ['const first = 1;', 'const second = 2;'].entries()) {
		await editor.waitForEditorFocus();
		await page.keyboard.press('ControlOrMeta+a');
		await page.keyboard.insertText(text);
		await page.keyboard.press('ControlOrMeta+s');
		await expect(timeline.getByRole('treeitem')).toHaveCount(index + 1);
	}
	await timeline.getByRole('tree').focus();
	await timeline.getByRole('tree').press('ArrowDown');
	await expect(page.getByRole('region', { name: 'Diff editor: Original and Modified', exact: true })).toHaveCount(0);
	await timeline.getByRole('treeitem').last().dblclick();
	const diff = workbench.editors.groupAt(0).content.getByRole('region', { name: 'Diff editor: Original and Modified', exact: true });
	await expect(diff).toBeVisible();
	await expect(diff).toContainText('const first = 1;');
	await expect(diff).toContainText('const second = 2;');
	await expect(timeline.locator('.ash-timeline-resource')).toHaveText('main.ts');
	const other = page.locator('.ash-explorer').getByRole('treeitem', { name: 'other.ts', exact: true });
	await other.dblclick();
	await expect(timeline.locator('.ash-timeline-resource')).toHaveText('other.ts');
	await expect(timeline.getByRole('treeitem')).toHaveCount(0);
	await workbench.editors.groupAt(0).element.getByRole('tab', { name: 'main.ts', exact: true }).click();
	await expect(timeline.getByRole('treeitem')).toHaveCount(2);
	const actions = timeline.getByRole('button', { name: 'More Actions', exact: true });
	await workbench.menus.select(application, () => actions.click(), ['Pin Current File']);
	await other.dblclick();
	await expect(timeline.locator('.ash-timeline-resource')).toHaveText('main.ts');
	await expect(timeline.getByRole('treeitem')).toHaveCount(2);
	await workbench.menus.select(application, () => actions.click(), ['Local History']);
	await expect(timeline.getByRole('treeitem')).toHaveCount(0);
	await expect(timeline.getByRole('status')).toHaveText('No timeline information was provided.');
	({ application, workbench } = await reloadWorkbench());
	await workbench.openExplorer();
	await workbench.page.locator('.ash-explorer').getByRole('treeitem', { name: 'main.ts', exact: true }).dblclick();
	const restored = workbench.page.locator('[data-view-id="timeline"]');
	const header = restored.locator('.ash-pane-view-header-button');
	if (await header.getAttribute('aria-expanded') !== 'true') await header.click();
	await expect(restored.getByRole('treeitem')).toHaveCount(0);
	await expect(restored.getByRole('status')).toHaveText('No timeline information was provided.');
	await workbench.menus.select(application, () => restored.getByRole('button', { name: 'More Actions', exact: true }).click(), ['Local History']);
	await expect(restored.getByRole('treeitem')).toHaveCount(2);
});
