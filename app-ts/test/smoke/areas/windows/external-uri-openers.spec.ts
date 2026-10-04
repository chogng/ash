import { expect, test } from '../../../automation/test.js';

test('External URL opener rules accept unregistered IDs and persist after reopening', async ({ workbench, reloadWorkbench }) => {
	const rules = { '*.example.test/docs/*': 'example.viewer', '*': 'default' };
	await workbench.quickaccess.runCommand('workbench.action.openSettingsJson');
	const group = workbench.editors.groupAt(0);
	const tab = group.tabs.filter({ hasText: 'User Settings (JSON)' });
	await expect(tab).toHaveCount(1);
	await expect(group.editor.input).toBeFocused();
	await group.editor.input.press('ControlOrMeta+A');
	await group.editor.input.evaluate((element, source) => {
		const clipboardData = new DataTransfer();
		clipboardData.setData('text/plain', source);
		element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
	}, JSON.stringify({ 'workbench.externalUriOpeners': rules }));
	await group.editor.waitForEditorContents(source => JSON.stringify(JSON.parse(source)['workbench.externalUriOpeners']) === JSON.stringify(rules));
	await workbench.quickaccess.runCommand('workbench.action.files.save');
	await expect(tab.locator('..')).not.toHaveAttribute('data-state', /dirty|conflict/u);
	const { workbench: restarted } = await reloadWorkbench();
	await restarted.quickaccess.runCommand('workbench.action.openSettingsJson');
	await restarted.editors.groupAt(0).editor.waitForEditorContents(source => JSON.stringify(JSON.parse(source)['workbench.externalUriOpeners']) === JSON.stringify(rules));
});
