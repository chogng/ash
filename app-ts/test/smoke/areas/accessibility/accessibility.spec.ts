import { expect, test } from '../../../automation/test.js';

test('editor accessibility help resolves shortcuts, traps focus and returns to the text', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'Requires the Code product');
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+N');
	const editor = workbench.editors.groupAt(0).editor;
	await editor.waitForEditorFocus();
	await editor.waitForTypeInEditor('Keep this text unchanged.');
	await page.keyboard.press('Alt+F1');
	const help = page.getByRole('dialog', { name: 'Accessibility Help', exact: true });
	const text = help.getByRole('textbox', { name: 'Accessibility Help', exact: true });
	await expect(text).toBeFocused();
	await expect(text).toHaveValue(/editable text editor[\s\S]*opens Find[\s\S]*Escape closes/u);
	await expect(text).not.toHaveValue(/<keybinding:/u);
	await expect(text).toHaveAttribute('readonly', '');
	await page.keyboard.press('Tab');
	await expect(help.getByRole('button', { name: 'Close', exact: true })).toBeFocused();
	await page.keyboard.press('Tab');
	await expect(text).toBeFocused();
	await page.keyboard.press('Control+Alt+h');
	await page.keyboard.press('Escape');
	await expect(help).toHaveCount(0);
	await expect(editor.input).toBeFocused();
	await editor.waitForEditorContents(contents => contents === 'Keep this text unchanged.');
});

test('screen reader mode has a working status action and can be disabled from its notification', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'Requires the Code product');
	const page = workbench.page;
	await workbench.quickaccess.runCommand('editor.action.toggleScreenReaderAccessibilityMode');
	const status = page.getByRole('button', { name: 'Screen Reader Optimized', exact: true });
	await expect(status).toBeVisible();
	await status.focus();
	await page.keyboard.press('Enter');
	const toast = page.locator('.ash-notification-host .ash-notification').filter({ hasText: 'Choose how Ash enables screen reader optimization.' });
	await expect(toast).toBeVisible();
	await toast.getByRole('button', { name: 'Disable', exact: true }).click();
	await expect(status).toHaveCount(0);
	await expect(toast).toHaveCount(0);
});

test('accessible view help returns to the reading position before returning to notifications', async ({ workbench }) => {
	const page = workbench.page;
	await workbench.quickaccess.runCommand('showEditorScreenReaderNotification');
	await workbench.quickaccess.runCommand('notifications.showList');
	await page.keyboard.press('Alt+F2');
	const view = page.getByRole('dialog', { name: 'Accessible View', exact: true });
	const text = view.getByRole('textbox', { name: 'Accessible View', exact: true });
	await expect(text).toBeFocused();
	await expect(text).toHaveValue(/Choose how Ash enables screen reader optimization/u);
	await text.press('Home');
	await text.press('ArrowRight');
	const selection = await text.evaluate(element => ({ start: (element as HTMLTextAreaElement).selectionStart, end: (element as HTMLTextAreaElement).selectionEnd }));
	await page.keyboard.press('Alt+F1');
	const help = page.getByRole('dialog', { name: 'Accessibility Help', exact: true });
	await expect(help.getByRole('textbox')).toHaveValue(/Escape returns to the content/u);
	await page.keyboard.press('Escape');
	await expect(help).toHaveCount(0);
	await expect(text).toBeFocused();
	expect(await text.evaluate(element => ({ start: (element as HTMLTextAreaElement).selectionStart, end: (element as HTMLTextAreaElement).selectionEnd }))).toEqual(selection);
	await page.keyboard.press('Escape');
	await expect(view).toHaveCount(0);
	await expect(page.getByRole('region', { name: 'Notification Center', exact: true })).toBeVisible();
});

test('editor accessibility help and screen reader status use the selected Chinese language', async ({ target, workbench, restartWorkbench }) => {
	test.skip(target.workbenchMode !== 'code', 'Requires the Code product');
	await workbench.quickaccess.runCommand('workbench.action.configureLocale');
	const picker = workbench.page.getByRole('dialog', { name: 'Select Display Language' });
	await picker.getByRole('combobox').fill('简体中文');
	await picker.getByRole('combobox').press('Enter');
	({ workbench } = await restartWorkbench());
	const page = workbench.page;
	await workbench.quickaccess.runCommand('editor.action.toggleScreenReaderAccessibilityMode');
	await expect(page.getByRole('button', { name: '屏幕阅读器优化已启用', exact: true })).toBeVisible();
	await page.keyboard.press('ControlOrMeta+N');
	await workbench.editors.groupAt(0).editor.waitForEditorFocus();
	await page.keyboard.press('Alt+F1');
	const help = page.getByRole('dialog', { name: '无障碍帮助', exact: true });
	await expect(help.getByRole('textbox')).toHaveValue(/当前是可编辑的文本编辑器[\s\S]*已启用屏幕阅读器优化/u);
	await expect(help.getByRole('textbox')).not.toHaveValue(/<keybinding:/u);
	await page.keyboard.press('Escape');
	await expect(workbench.editors.groupAt(0).editor.input).toBeFocused();
});

test('unfocused view dimming follows keyboard focus and preserves the focused high contrast part', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'Requires the Code product');
	const page = workbench.page;
	await workbench.quickaccess.runCommand('workbench.action.openSettingsJson');
	const settings = workbench.editors.groupAt(0).editor;
	await settings.waitForEditorFocus();
	await settings.input.press('ControlOrMeta+A');
	await settings.input.evaluate(element => {
		const clipboardData = new DataTransfer();
		clipboardData.setData('text/plain', JSON.stringify({ 'accessibility.dimUnfocused.enabled': true, 'accessibility.dimUnfocused.opacity': 0.4 }));
		element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
	});
	await settings.waitForEditorContents(contents => JSON.parse(contents)['accessibility.dimUnfocused.enabled'] === true);
	await page.keyboard.press('ControlOrMeta+s');
	await expect(page.locator('.ash-workbench').first()).toHaveClass(/ash-dim-unfocused/u);
	await page.keyboard.press('ControlOrMeta+N');
	const editor = workbench.editors.groupAt(0).editor;
	await editor.waitForEditorFocus();
	const showSidebar = page.getByRole('button', { name: 'Show Primary Side Bar', exact: true });
	if (await showSidebar.isVisible()) {
		await showSidebar.click();
	}
	const sidebar = page.locator('.ash-workbench-sidebar');
	const editorContent = page.locator('.ash-workbench-editor > .ash-workbench-part-content');
	const sidebarContent = sidebar.locator(':scope > .ash-workbench-part-content');
	await editor.input.focus();
	await expect(editorContent).toHaveCSS('opacity', '1');
	await expect(sidebarContent).toHaveCSS('opacity', '0.4');
	await page.getByRole('tab', { name: /^Search(?:,|$)/u }).click();
	await sidebar.getByRole('textbox', { name: 'Search workspace', exact: true }).focus();
	await expect(sidebarContent).toHaveCSS('opacity', '1');
	await expect(editorContent).toHaveCSS('opacity', '0.4');
	await workbench.quickaccess.runCommand('workbench.action.selectTheme');
	const theme = page.locator('.ash-quick-pick').getByRole('combobox');
	await theme.fill('Ash High Contrast Dark');
	await theme.press('Enter');
	await editor.input.focus();
	await expect(editorContent).toHaveCSS('opacity', '1');
	await expect(sidebarContent).toHaveCSS('opacity', '0.4');
});
