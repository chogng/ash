import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '../../../automation/test.js';
import { Editor } from '../../../automation/editor.js';
import { QuickAccess } from '../../../automation/quickaccess.js';

test('Docs comment focus keeps the outer window layout fixed', { tag: ['@electron-ui', '@electron-app-server'] }, async ({ target, workbench }, testInfo) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await new QuickAccess(page).runCommand('workbench.action.document.new');
	const docs = page.locator('.ash-docs-workspace:visible');
	const body = docs.getByRole('textbox', { name: 'Document body', exact: true });
	await body.click();
	await page.keyboard.insertText('Layout reference');
	await body.press('ControlOrMeta+a');
	const before = await docs.boundingBox();
	await page.evaluate(() => {
		const shifts: number[][] = [];
		(window as unknown as { layoutScrollShifts: number[][]; }).layoutScrollShifts = shifts;
		document.addEventListener('scroll', event => {
			const target = event.target;
			if (target instanceof HTMLElement && target.matches('.ash-grid, .ash-workbench-editor') && (target.scrollLeft || target.scrollTop))
				shifts.push([target.scrollLeft, target.scrollTop]);
		}, true);
	});
	await docs.getByRole('toolbar', { name: 'Selection formatting', exact: true }).getByRole('button', { name: 'Add comment', exact: true }).click();
	const comments = docs.getByRole('complementary', { name: 'Comments', exact: true });
	const popup = docs.getByRole('dialog', { name: 'Add comment', exact: true });
	const floatingInput = popup.getByRole('textbox', { name: 'Comment text', exact: true });
	await expect(floatingInput).toBeFocused();
	await expect(comments).toBeHidden();
	expect(await docs.boundingBox()).toEqual(before);
	await page.screenshot({ path: testInfo.outputPath('docs-floating-comment.png') });
	await floatingInput.fill('Review layout');
	await floatingInput.press('Enter');
	await expect(popup).toBeHidden();
	const input = comments.getByRole('textbox', { name: 'Comment text', exact: true });
	await expect(comments.locator('.ash-docs-comment-body')).toHaveText('Review layout');
	await input.fill('Unsent reply');
	await input.press('Escape');
	await expect(comments).toBeHidden();
	await docs.locator(':scope > .ash-artifact-toolbar').getByRole('button', { name: 'Comments', exact: true }).click();
	await expect(input).toHaveValue('Unsent reply');
	await comments.getByRole('button', { name: 'Resolve thread', exact: true }).click();
	await expect(comments.getByRole('button', { name: 'New comment', exact: true })).toBeFocused();
	expect(await docs.boundingBox()).toEqual(before);
	expect(await page.locator('.ash-grid, .ash-workbench-editor').evaluateAll(elements =>
		elements.filter(element => element.scrollLeft || element.scrollTop).map(element => [element.className, element.scrollLeft, element.scrollTop]),
	)).toEqual([]);
	expect(await page.evaluate(() => (window as unknown as { layoutScrollShifts: number[][]; }).layoutScrollShifts)).toEqual([]);
});

test('Docs opens the selection comment composer in Simplified Chinese', { tag: ['@electron-ui'] }, async ({ target, workbench, restartWorkbench }) => {
	await workbench.quickaccess.runCommand('workbench.action.configureLocale');
	const language = workbench.page.getByRole('dialog', { name: 'Select Display Language' }).getByRole('combobox');
	await language.fill('简体中文');
	await language.press('Enter');
	({ workbench } = await restartWorkbench());
	const page = await workbench.openAgentsWindow(target.kind);
	await new QuickAccess(page).runCommand('workbench.action.document.new');
	const doc = page.locator('.ash-docs-workspace:visible');
	const body = doc.getByRole('textbox', { name: '文档正文', exact: true });
	await body.click();
	await page.keyboard.insertText('文档选区');
	await body.press('ControlOrMeta+a');
	await doc.getByRole('toolbar', { name: '选区格式', exact: true }).getByRole('button', { name: '添加评论', exact: true }).click();
	const popup = doc.getByRole('dialog', { name: '添加评论', exact: true });
	const input = popup.getByRole('textbox', { name: '评论内容', exact: true });
	await expect(input).toBeFocused();
	await expect(input).toHaveAttribute('placeholder', '撰写评论…');
	await input.press('Escape');
	await expect(body).toBeFocused();
});

for (const locale of ['en', 'zh-CN'] as const) {
	test(`Artifacts Docs opens the built-in editor and keeps Markdown drafts (${locale})`, { tag: locale === 'en' ? ['@electron-ui', '@browser-ui', '@electron-app-server'] : ['@electron-ui'] }, async ({ target, workbench, application, testWorkspace, restartWorkbench }, testInfo) => {
		if (locale === 'zh-CN') {
			await workbench.quickaccess.runCommand('workbench.action.configureLocale');
			const input = workbench.page.getByRole('dialog', { name: 'Select Display Language' }).getByRole('combobox');
			await input.fill('简体中文');
			await input.press('Enter');
			({ workbench } = await restartWorkbench());
		}
		await workbench.quickaccess.open('>workbench.action.document.new');
		await expect(workbench.quickaccess.element.locator('.ash-quick-pick-row-description').getByText('workbench.action.document.new', { exact: true })).toHaveCount(0);
		await workbench.quickaccess.close();
		const page = await workbench.openAgentsWindow(target.kind);
		await page.setViewportSize({ width: 1440, height: 860 });
		const quick = new QuickAccess(page);
		await quick.open('>workbench.action.document.new');
		await expect(quick.element.locator('.ash-quick-pick-row-description').getByText('workbench.action.document.new', { exact: true })).toHaveCount(1);
		await quick.close();
		const navigation = page.locator('.ash-sessions-activity-content');
		await navigation.getByRole('button', { name: 'Artifacts', exact: true }).click();
		await expect(navigation.locator('[data-action-id="sessions.open.artifacts"] .ash-icon')).toHaveAttribute('data-ash-icon-id', 'artifacts');
		await quick.runCommand('workbench.action.document.new');
		const docs = page.locator('.ash-code-page-group .ash-docs-workspace:visible');
		const header = page.locator('[data-part="titlebar"] .ash-sessions-titlebar-editor-page');
		const toolbar = header.getByRole('toolbar', { name: locale === 'en' ? 'Docs actions' : 'Docs 操作' });
		await expect(toolbar).toBeVisible();
		const editorFrame = page.locator('.ash-workbench-part-frame.ash-sessions-editor-frame-divider');
		const titlebarFrame = page.locator('.ash-workbench-part-frame.ash-sessions-titlebar-frame-divider');
		await expect(page.locator('[data-part="sessions"]')).toBeVisible();
		await expect(editorFrame).toBeVisible();
		await expect.poll(() => editorFrame.evaluate(frame => {
			const edge = getComputedStyle(frame, '::after');
			return { width: edge.borderLeftWidth, style: edge.borderLeftStyle, pointerEvents: edge.pointerEvents };
		})).toEqual({ width: '1px', style: 'solid', pointerEvents: 'none' });
		await expect(titlebarFrame).toBeVisible();
		const editorBounds = (await editorFrame.boundingBox())!;
		await expect.poll(() => titlebarFrame.evaluate(frame => {
			const bounds = frame.getBoundingClientRect();
			const edge = getComputedStyle(frame, '::after');
			return { x: bounds.left + parseFloat(edge.left), bottom: bounds.bottom - parseFloat(edge.bottom), width: edge.borderLeftWidth };
		})).toEqual({ x: editorBounds.x, bottom: editorBounds.y, width: '1px' });
		await expect(header.getByRole('heading')).toHaveText(locale === 'en' ? 'Untitled.md' : '未命名.md');
		await expect.poll(async () => (await header.boundingBox())!.x).toBeCloseTo(editorBounds.x, 0);
		await expect(page.locator('[data-part="auxiliarybar"]')).toBeHidden();
		await expect(docs.locator(':scope > :first-child')).toHaveClass('ash-docs-workspace-body');
		await page.screenshot({ path: testInfo.outputPath(`docs-editor-${locale}.png`) });
		await expect(docs.getByRole('textbox', { name: locale === 'en' ? 'Document body' : '文档正文', exact: true })).toHaveAttribute('data-arkdown-engine', 'wasm');
		const viewport = page.viewportSize();
		if (target.kind === 'browser' && viewport) {
			await page.setViewportSize({ width: 900, height: viewport.height });
			await expect(toolbar).toBeInViewport();
			expect(await header.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
			await page.setViewportSize(viewport);
		}
		await toolbar.getByRole('button', { name: locale === 'en' ? 'Close artifact' : '关闭作品区域' }).press('Enter');
		await expect(page.locator('[data-part="sessions"]')).toBeVisible();
		await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Artifacts', exact: true }).press('Enter');
		await expect(page.locator('.ash-artifacts-home')).toBeVisible();
		await expect(editorFrame).toHaveCount(0);
		await expect(titlebarFrame).toHaveCount(0);
		const chooseEditor = () => quick.runCommand('sessions.docs.chooseEditor');
		await chooseEditor();
		await expect(quick.items).toHaveCount(3);
		await expect(quick.items.first().locator('.ash-quick-pick-row-content')).toHaveClass(/picked/);
		await quick.select(locale === 'en' ? 'Markdown source' : 'Markdown 源码');
		await chooseEditor();
		await expect(quick.items.filter({ hasText: 'Markdown' }).last().locator('.ash-quick-pick-row-content')).toHaveClass(/picked/);
		await quick.select(locale === 'en' ? 'New blank document' : '新建空白文档');
		const markdownPane = page.locator('.ash-code-page-group [data-docs-format="markdown"]:visible');
		await expect(toolbar).toBeVisible();
		await expect(markdownPane.locator('.minimap, .line-numbers')).toHaveCount(0);
		await expect(page.locator('[data-part="sessions"]')).toBeVisible();
		const markdown = new Editor(markdownPane);
		await markdown.waitForEditorFocus();
		await markdown.waitForTypeInEditor('# Retained Docs draft');
		await navigation.getByRole('button', { name: 'Artifacts', exact: true }).click();
		await chooseEditor();
		await quick.select(locale === 'en' ? 'Document' : '文档');
		await chooseEditor();
		await expect(quick.items.first().locator('.ash-quick-pick-row-content')).toHaveClass(/picked/);
		await quick.input.press('Escape');
		await expect(page.locator('[data-artifact-resource]')).toHaveCount(0);
		const draft = locale === 'en' ? 'Untitled document' : '未命名文档';
		await page.locator('.ash-artifacts-card.docs .ash-button-content').getByText(draft, { exact: true }).click();
		await markdown.waitForEditorContents(text => text === '# Retained Docs draft');
		if (locale === 'en' && target.appServerMode === 'required' && 'windows' in application) {
			const workspace = await realpath(testWorkspace.directory);
			const copy = join(workspace, 'exported-docs.md');
			await application.evaluate(({ dialog }, filePath) => {
				dialog.showSaveDialog = async () => ({ canceled: false, filePath });
			}, copy);
			const draftTitle = await header.getByRole('heading').textContent();
			await toolbar.getByRole('button', { name: 'Export', exact: true }).press('Enter');
			await page.getByRole('menuitem', { name: 'Markdown file (.md)', exact: true }).click();
			await expect.poll(() => readFile(copy, 'utf8').catch(() => '')).toBe('# Retained Docs draft');
			await expect(header.getByRole('heading')).toHaveText(draftTitle!);
			const output = join(workspace, 'retained-docs.md');
			await application.evaluate(({ dialog }, filePath) => {
				dialog.showSaveDialog = async () => ({ canceled: false, filePath });
			}, output);
			await toolbar.getByRole('button', { name: 'Save document', exact: true }).press('Enter');
			await expect.poll(() => readFile(output, 'utf8').catch(() => '')).toBe('# Retained Docs draft');
			await expect(header.getByRole('heading', { name: 'retained-docs.md', exact: true })).toBeVisible();
		}
		await page.screenshot({ path: testInfo.outputPath(`docs-markdown-${locale}.png`) });
		await chooseEditor();
		await quick.select(locale === 'en' ? 'New blank document' : '新建空白文档');
		const rich = page.locator('.ash-docs-workspace:visible .stanza-arkdown-prose').first();
		await expect(rich).toBeEditable();
		await rich.fill('Built-in Docs draft');
		await expect(rich).toHaveText('Built-in Docs draft');
		if (locale === 'zh-CN') {
			await navigation.getByRole('button', { name: 'Artifacts', exact: true }).click();
			const cards = page.locator('.ash-new-artifact');
			await expect(cards.locator('.ash-new-artifact-button')).toHaveText(['文档', '幻灯片', '设计', '电子表格', '白板', '数据', '动效']);
			const motion = cards.getByRole('button', { name: '动效', exact: true });
			await motion.press('Alt+F1');
			await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/打开新的聊天草稿/u);
			await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/返回创建它的对话/u);
			await page.keyboard.press('Escape');
			await expect(motion).toBeFocused();
			await motion.press('Enter');
			await expect(page.locator('.ash-chat-input-artifact-pill:visible')).toHaveText('Ash 动效');
			await expect(page.locator('[data-part="editor"]')).toBeHidden();
			await expect(page.locator('[data-part="sessions"]')).toBeVisible();
		}
	});
}

test('Docs exports DOCX, PDF and Markdown files from its title menu', { tag: ['@browser-ui'] }, async ({ target, workbench }, testInfo) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await new QuickAccess(page).runCommand('workbench.action.document.new');
	const docs = page.locator('.ash-docs-workspace:visible');
	const body = docs.getByRole('textbox', { name: 'Document body', exact: true });
	await body.click();
	await page.keyboard.insertText('Export sample 中文');
	const toolbar = page.locator('[data-part="titlebar"] .ash-sessions-titlebar-editor-page').getByRole('toolbar', { name: 'Docs actions', exact: true });
	const exports = toolbar.getByRole('button', { name: 'Export', exact: true });
	await exports.click();
	const names = ['Word document (.docx)', 'PDF document (.pdf)', 'Markdown file (.md)'];
	for (const name of names) await expect(page.getByRole('menuitem', { name, exact: true })).toBeVisible();
	await page.keyboard.press('Escape');
	for (const [index, extension] of ['docx', 'pdf', 'md'].entries()) {
		await exports.focus(); await exports.press('Enter');
		const item = page.getByRole('menuitem', { name: names[index], exact: true });
		await item.focus();
		const downloading = page.waitForEvent('download');
		await item.press('Enter');
		const download = await downloading;
		expect(download.suggestedFilename()).toMatch(new RegExp(`\\.${extension}$`));
		const bytes = await readFile((await download.path())!);
		if (extension === 'docx') expect(bytes.subarray(0, 2).toString()).toBe('PK');
		else if (extension === 'pdf') expect(bytes.subarray(0, 8).toString()).toBe('%PDF-1.4');
		else expect(bytes.toString()).toContain('Export sample 中文');
		await expect(body).toHaveText('Export sample 中文');
	}
	await exports.click();
	await page.screenshot({ path: testInfo.outputPath('docs-export-menu.png') });
	await page.keyboard.press('Escape');
});
