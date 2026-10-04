import { expect, test } from '../../../automation/test.js';

test('External URL opener rules accept unregistered IDs and persist across restart', async ({ workbench, restartWorkbench }) => {
	const rules = { '*.example.test/docs/*': 'example.viewer', '*': 'default' };
	await workbench.quickaccess.runCommand('workbench.action.openSettingsJson');
	const group = workbench.editors.groupAt(0);
	const tab = group.tabs.filter({ hasText: 'User Settings (JSON)' });
	await expect(tab).toHaveCount(1);
	await expect(group.editor.input).toBeFocused();
	await group.editor.input.press('ControlOrMeta+A');
	await workbench.page.keyboard.insertText(JSON.stringify({ 'workbench.externalUriOpeners': rules }));
	await group.editor.input.press('ControlOrMeta+S');
	await expect(tab.locator('..')).not.toHaveAttribute('data-state', /dirty|conflict/u);
	await group.editor.waitForEditorContents(source => JSON.stringify(JSON.parse(source)['workbench.externalUriOpeners']) === JSON.stringify(rules));
	const restarted = await restartWorkbench();
	await restarted.quickaccess.runCommand('workbench.action.openSettingsJson');
	await restarted.editors.groupAt(0).editor.waitForEditorContents(source => JSON.stringify(JSON.parse(source)['workbench.externalUriOpeners']) === JSON.stringify(rules));
});
