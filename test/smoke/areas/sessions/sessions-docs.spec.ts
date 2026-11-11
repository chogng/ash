import { expect, test } from '../../../automation/test.js';
import { Editor } from '../../../automation/editor.js';
import { QuickAccess } from '../../../automation/quickaccess.js';

for (const locale of ['en', 'zh-CN'] as const) {
	test(`Artifacts Docs remembers the selected editor and keeps Markdown drafts (${locale})`, { tag: ['@electron-ui'] }, async ({ target, workbench, restartWorkbench }, testInfo) => {
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
		const quick = new QuickAccess(page);
		await quick.open('>workbench.action.document.new');
		await expect(quick.element.locator('.ash-quick-pick-row-description').getByText('workbench.action.document.new', { exact: true })).toHaveCount(1);
		await quick.close();
		const navigation = page.locator('.ash-sessions-activity-content');
		await navigation.getByRole('button', { name: 'Artifacts', exact: true }).click();
		await expect(navigation.locator('[data-action-id="sessions.open.creator"] .ash-icon')).toHaveAttribute('data-ash-icon-id', 'artifacts');
		const chooseEditor = () => quick.runCommand('sessions.creator.chooseDocsEditor');
		await chooseEditor();
		await expect(quick.items).toHaveCount(5);
		await quick.select('Markdown');
		await chooseEditor();
		await expect(quick.items.filter({ hasText: 'Markdown' }).last().locator('.ash-quick-pick-row-content')).toHaveClass(/picked/);
		await quick.select(locale === 'en' ? 'New blank document' : '新建空白文档');
		const markdown = new Editor(page.locator('[data-part="editor"]:not(.ash-sessions-chat-grid)'));
		await markdown.waitForEditorFocus();
		await markdown.waitForTypeInEditor('# Retained Docs draft');
		await expect(page.locator('.ash-notification-message').filter({ hasText: 'Recommended for Docs' })).toHaveCount(0);
		await navigation.getByRole('button', { name: 'Artifacts', exact: true }).click();
		await chooseEditor();
		await quick.select(locale === 'en' ? 'Automatic' : '自动');
		await chooseEditor();
		await expect(quick.items.first().locator('.ash-quick-pick-row-content')).toHaveClass(/picked/);
		await quick.input.press('Escape');
		await page.locator('.ash-artifacts-card.docs:not([data-artifact-example])').click();
		await markdown.waitForEditorContents(text => text === '# Retained Docs draft');
		await page.screenshot({ path: testInfo.outputPath(`docs-markdown-${locale}.png`) });
		if (locale === 'zh-CN') {
			await navigation.getByRole('button', { name: 'Artifacts', exact: true }).click();
			const cards = page.locator('.ash-creator-modes');
			await expect(cards.locator('.ash-artifacts-create')).toHaveText(['文档', '幻灯片', '设计', '电子表格', '白板', '数据', '动效']);
			await cards.getByRole('button', { name: '动效', exact: true }).press('Enter');
			await expect(page.locator('.ash-chat-input-artifact-pill:visible')).toHaveText('Ash 动效');
			await expect(page.locator('.stanza-editor-placeholder-text:visible')).toHaveText('你想让什么动起来？');
			await page.getByRole('button', { name: '移除 Ash 动效', exact: true }).press('Enter');
			await expect(page.locator('.ash-chat-input-artifact-pill:visible')).toHaveCount(0);
		}
	});
}
