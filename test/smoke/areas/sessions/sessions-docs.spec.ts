import { expect, test } from '../../../automation/test.js';
import { Editor } from '../../../automation/editor.js';
import { QuickAccess } from '../../../automation/quickaccess.js';

for (const locale of ['en', 'zh-CN'] as const) {
	test(
		`Artifacts Docs remembers the selected editor and keeps Markdown drafts (${locale})`,
		{ tag: ['@electron-ui'] },
		async ({ target, workbench, restartWorkbench }, testInfo) => {
			if (locale === 'zh-CN') {
				await workbench.quickaccess.runCommand('workbench.action.configureLocale');
				const input = workbench.page
					.getByRole('dialog', { name: 'Select Display Language' })
					.getByRole('combobox');
				await input.fill('简体中文');
				await input.press('Enter');
				({ workbench } = await restartWorkbench());
			}
			const page = await workbench.openAgentsWindow(target.kind);
			const navigation = page.locator('.ash-sessions-activity-content');
			await navigation.getByRole('button', { name: 'Artifacts', exact: true }).click();
			await expect(navigation.locator('[data-action-id="sessions.open.creator"] .ash-icon')).toHaveAttribute(
				'data-ash-icon-id',
				'artifacts',
			);
			const choose = page.getByRole('button', {
				name: locale === 'en' ? 'Choose Docs editor' : '选择 Docs 编辑器',
				exact: true,
			});
			await choose.click();
			const quick = new QuickAccess(page);
			await expect(quick.items).toHaveCount(4);
			await quick.select('Markdown');
			await choose.click();
			await expect(
				quick.items.filter({ hasText: 'Markdown' }).last().locator('.ash-quick-pick-row-content'),
			).toHaveClass(/picked/);
			await quick.input.press('Escape');
			await page
				.locator('.ash-creator-home')
				.getByRole('button', { name: locale === 'en' ? 'Docs' : '文档', exact: true })
				.click();
			const markdown = new Editor(page.locator('[data-part="editor"]:not(.ash-sessions-chat-grid)'));
			await markdown.waitForEditorFocus();
			await markdown.waitForTypeInEditor('# Retained Docs draft');
			await expect(
				page.locator('.ash-notification-message').filter({ hasText: 'Recommended for Docs' }),
			).toHaveCount(0);
			await navigation.getByRole('button', { name: 'Artifacts', exact: true }).click();
			await choose.click();
			await quick.select(locale === 'en' ? 'Automatic' : '自动');
			await choose.click();
			await expect(quick.items.first().locator('.ash-quick-pick-row-content')).toHaveClass(/picked/);
			await quick.input.press('Escape');
			await page.locator('.ash-artifacts-card.docs').click();
			await markdown.waitForEditorContents(text => text === '# Retained Docs draft');
			await page.screenshot({ path: testInfo.outputPath(`docs-markdown-${locale}.png`) });
		},
	);
}
