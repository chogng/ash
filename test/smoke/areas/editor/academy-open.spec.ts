import { expect, test } from '../../../automation/test.js';
import { Editor } from '../../../automation/editor.js';
import { QuickAccess } from '../../../automation/quickaccess.js';

test('Connected Code edits text and Artifacts owns document authoring', { tag: ['@electron-app-server', '@browser-app-server'] }, async ({ target, workbench }) => {
	const explorer = workbench.page.locator('.ash-explorer');
	await explorer.getByRole('treeitem', { name: 'main.ts', exact: true }).dblclick();
	await workbench.editors.groupAt(0).editor.waitForEditorContents(contents => contents === 'const value = 1;\n');
	await workbench.quickaccess.open('>workbench.action.document.new');
	await expect(workbench.quickaccess.element.locator('.ash-quick-pick-row-description').getByText('workbench.action.document.new', { exact: true })).toHaveCount(0);
	await workbench.quickaccess.close();

	const page = await workbench.openAgentsWindow(target.kind);
	const quick = new QuickAccess(page);
	const artifacts = page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Artifacts', exact: true });
	await artifacts.click();
	await quick.open('>workbench.action.document.new');
	await expect(quick.element.locator('.ash-quick-pick-row-description').getByText('workbench.action.document.new', { exact: true })).toHaveCount(1);
	await quick.close();
	await quick.runCommand('sessions.creator.chooseDocsEditor');
	await quick.select('Markdown');
	await quick.runCommand('sessions.creator.chooseDocsEditor');
	await quick.select('New blank document');
	const document = new Editor(page.locator('[data-part="editor"]:not(.ash-sessions-chat-grid)'));
	await document.waitForEditorFocus();
	await document.waitForTypeInEditor('# Artifacts draft');
	await artifacts.click();
	await page.locator('.ash-artifacts-card.docs:not([data-artifact-example])').click();
	await document.waitForEditorContents(contents => contents === '# Artifacts draft');
});
