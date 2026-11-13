import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '../../../automation/test.js';
import { Editor } from '../../../automation/editor.js';
import { QuickAccess } from '../../../automation/quickaccess.js';

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
		await expect(navigation.locator('[data-action-id="sessions.open.creator"] .ash-icon')).toHaveAttribute('data-ash-icon-id', 'artifacts');
		await page.locator('[data-artifact-example="docs"]').press('Enter');
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
		await expect(header.getByRole('heading')).toHaveText(locale === 'en' ? 'Docs example' : '文档范例');
		await expect.poll(async () => (await header.boundingBox())!.x).toBeCloseTo(editorBounds.x, 0);
		await expect(docs.locator('.stanza-document-heading').first()).toBeVisible();
		await expect(docs.locator('.stanza-document-paragraph').first()).toContainText(locale === 'en' ? 'guide the public release.' : /公开发布/u);
		await expect(docs.locator('table')).toBeVisible();
		const checks = docs.getByRole('checkbox');
		await expect(checks).toHaveCount(3);
		await expect(checks.first()).toBeChecked();
		await expect(checks.first()).toBeDisabled();
		await expect(page.locator('[data-part="auxiliarybar"]')).toBeHidden();
		await expect(docs.locator(':scope > :first-child')).toHaveClass('ash-docs-workspace-body');
		await page.screenshot({ path: testInfo.outputPath(`docs-example-${locale}.png`) });
		const tools = toolbar.getByRole('button', { name: locale === 'en' ? 'Document tools' : '文档工具' });
		await tools.press('Enter');
		const dock = page.locator('[data-part="auxiliarybar"] .ash-docs-workspace-controls');
		await expect(dock).toBeVisible();
		await expect(dock.getByRole('navigation', { name: 'Document outline' })).toBeVisible();
		expect(await dock.evaluate(element => element.closest('[data-part="editor"]') !== null)).toBe(true);
		await tools.press('Enter');
		await expect(dock).toBeHidden();
		const viewport = page.viewportSize();
		if (target.kind === 'browser' && viewport) {
			await page.setViewportSize({ width: 900, height: viewport.height });
			await expect(toolbar).toBeInViewport();
			expect(await header.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
			await page.setViewportSize(viewport);
		}
		await toolbar.getByRole('button', { name: locale === 'en' ? 'Back to Artifacts' : '返回 Artifacts' }).press('Enter');
		await expect(page.locator('[data-artifact-example="docs"]')).toBeVisible();
		await expect(editorFrame).toHaveCount(0);
		await expect(titlebarFrame).toHaveCount(0);
		const chooseEditor = () => quick.runCommand('sessions.creator.chooseDocsEditor');
		await chooseEditor();
		await expect(quick.items).toHaveCount(3);
		await expect(quick.items.first().locator('.ash-quick-pick-row-content')).toHaveClass(/picked/);
		await quick.select('Markdown');
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
		await quick.select(locale === 'en' ? 'Rich document' : '富文档');
		await chooseEditor();
		await expect(quick.items.first().locator('.ash-quick-pick-row-content')).toHaveClass(/picked/);
		await quick.input.press('Escape');
		await page.locator('.ash-artifacts-card.docs:not([data-artifact-example])').click();
		await markdown.waitForEditorContents(text => text === '# Retained Docs draft');
		if (locale === 'en' && target.appServerMode === 'required' && 'windows' in application) {
			const output = join(await realpath(testWorkspace.directory), 'retained-docs.md');
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
		const rich = page.locator('.ash-docs-workspace:visible .stanza-document-rich-text-input').first();
		await expect(rich).toBeEditable();
		await rich.fill('Built-in Docs draft');
		await expect(rich).toHaveText('Built-in Docs draft');
		if (locale === 'zh-CN') {
			await navigation.getByRole('button', { name: 'Artifacts', exact: true }).click();
			const cards = page.locator('.ash-creator-modes');
			await expect(cards.locator('.ash-artifacts-create')).toHaveText(['文档', '幻灯片', '设计', '电子表格', '白板', '数据', '动效']);
			const motion = cards.getByRole('button', { name: '动效', exact: true });
			await motion.press('Alt+F1');
			await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/打开新的聊天草稿/u);
			await page.keyboard.press('Escape');
			await expect(motion).toBeFocused();
			await motion.press('Enter');
			await expect(page.locator('.ash-chat-input-artifact-pill:visible')).toHaveText('Ash 动效');
			await expect(page.locator('[data-part="editor"]')).toBeHidden();
			await expect(page.locator('[data-part="sessions"]')).toBeVisible();
		}
	});
}
