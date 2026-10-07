import { writeFile } from 'node:fs/promises';
import { expect, test } from '../../../automation/test.js';
import { Editor } from '../../../automation/editor.js';
import { QuickAccess } from '../../../automation/quickaccess.js';

test('Sessions Reopen Closed Editor reads its real file through the session provider', async ({ target, testWorkspace, workbench }) => {
	test.skip(target.appServerMode !== 'required', 'Requires Sessions with the real App Server session directory.');
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Code', exact: true }).click();
	const editors = page.locator('[data-part="editor"]');
	const explorer = page.locator('[data-part="auxiliarybar"]');
	const editor = new Editor(editors.locator('.stanza-editor-pane'));
	const commands = new QuickAccess(page);
	await explorer.getByRole('treeitem', { name: 'main.ts', exact: true }).dblclick();
	await editor.waitForEditorContents(text => text === 'const value = 1;\n');
	await expect(editor.input).toBeFocused();
	await commands.runCommand('workbench.action.closeActiveEditor');
	await expect(editors.getByRole('tab', { name: /main\.ts/u })).toHaveCount(0);
	await expect(commands.element).toHaveCount(0);
	await writeFile(testWorkspace.file, 'const sessionReopened = 42;\n');
	await commands.runCommand('workbench.action.reopenClosedEditor');
	await editor.waitForEditorContents(text => text === 'const sessionReopened = 42;\n');
	await expect(editors.getByRole('tab', { name: /main\.ts/u })).toHaveAttribute('aria-selected', 'true');
	await expect(editor.input).toBeFocused();
});
