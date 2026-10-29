import { expect, test } from '../../../automation/test.js';

test('Default folding provider preferences retain language overrides after reopening', async ({ workbench, reloadWorkbench }) => {
	const settings = {
		'editor.defaultFoldingRangeProvider': 'unavailable.folding.provider',
		'[typescript]': { 'editor.defaultFoldingRangeProvider': null },
	};
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
	}, JSON.stringify(settings));
	await group.editor.waitForEditorContents(source => JSON.stringify(JSON.parse(source)) === JSON.stringify(settings));
	await workbench.quickaccess.runCommand('workbench.action.files.save');
	await expect(tab.locator('..')).not.toHaveAttribute('data-state', /dirty|conflict/u);
	const { workbench: reopened } = await reloadWorkbench();
	await reopened.quickaccess.runCommand('workbench.action.openSettingsJson');
	await reopened.editors.groupAt(0).editor.waitForEditorContents(source => JSON.stringify(JSON.parse(source)) === JSON.stringify(settings));
});
