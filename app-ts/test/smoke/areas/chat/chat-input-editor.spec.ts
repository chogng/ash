import { expect, test } from '../../../automation/test.js';

test('Chat input resizes with wrapped text and retains keyboard focus', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code' || target.appServerMode !== 'disabled', 'Uses the disconnected Chat shell.');
	const page = workbench.page;
	await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	const host = page.locator('.ash-chat-input-editor-host');
	const editor = host.locator('.ash-chat-input-editor');
	const input = editor.locator('.stanza-editor-input');
	await expect(editor).toBeVisible();
	await expect(editor.locator('.stanza-editor-completion')).toHaveCount(1);
	await host.evaluate(element => element.style.width = '180px');
	await input.focus();
	await page.keyboard.insertText('word '.repeat(80));
	await expect(editor).toHaveCSS('height', '320px');
	await expect(input).toBeFocused();

	await host.evaluate(element => element.style.width = '1000px');
	await expect(editor).toHaveCSS('height', '106px');
	await expect(input).toBeFocused();

	await host.evaluate(element => element.style.width = '180px');
	await expect(editor).toHaveCSS('height', '320px');
	await page.keyboard.press('ControlOrMeta+A');
	await page.keyboard.press('Backspace');
	await expect(editor).toHaveCSS('height', '106px');
	await expect(input).toBeFocused();
});

test('Chat input explicitly opens slash suggestions from the keyboard', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code' || target.appServerMode !== 'disabled', 'Uses the disconnected Chat shell.');
	const page = workbench.page;
	await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	const editor = page.locator('.ash-chat-input-editor');
	const input = editor.locator('.stanza-editor-input');
	await input.focus();
	await page.keyboard.insertText('/history argument');
	await page.keyboard.press('Escape');
	await page.keyboard.press('Home');
	for (let index = 0; index < 3; index++) await page.keyboard.press('ArrowRight');
	await page.keyboard.press('Control+Space');
	await expect(editor.locator('.stanza-editor-completion-label')).toHaveText(['/history', '/config']);
	await expect(input).toBeFocused();
});

test('Chat input returns to the empty message state when a slash command is deleted', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code' || target.appServerMode !== 'disabled', 'Uses the disconnected Chat shell.');
	const page = workbench.page;
	await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	const editor = page.locator('.ash-chat-input-editor');
	const input = editor.locator('.stanza-editor-input');
	await input.focus();
	await page.keyboard.insertText('/x');
	await expect(editor.locator('.stanza-editor-completion.visible')).toHaveCount(0);
	await page.keyboard.press('Backspace');
	await expect(editor.locator('.stanza-editor-line-text')).toHaveText('/');
	await page.keyboard.press('Backspace');
	await expect(editor.locator('.stanza-editor-completion.visible')).toHaveCount(0);
	await expect(editor.locator('.stanza-editor-placeholder-text')).toBeVisible();
	await expect(input).toBeFocused();
});

test('Chat input suggests and completes a command with a missing character', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code' || target.appServerMode !== 'disabled', 'Uses the disconnected Chat shell.');
	const page = workbench.page;
	await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	const editor = page.locator('.ash-chat-input-editor');
	const input = editor.locator('.stanza-editor-input');
	await input.focus();
	await page.keyboard.insertText('/');
	await expect(editor.locator('.stanza-editor-completion-label')).toHaveCount(7);
	await page.keyboard.type('cofig');

	await expect(editor.locator('.stanza-editor-completion-label')).toHaveText(['/config']);
	await expect(editor.locator('.stanza-editor-completion-option.focused')).toHaveCount(0);
	await expect(editor.locator('.stanza-editor-completion-option')).toHaveAttribute('aria-selected', 'false');
	await expect(editor.locator('.stanza-editor-completion-label strong')).toHaveText(['c', 'o', 'f', 'i', 'g']);
	await expect(editor.locator('.stanza-editor-line-text')).toHaveText('/cofig');
	await page.keyboard.press('ArrowDown');
	await page.keyboard.press('Enter');
	await expect(editor.locator('.stanza-editor-line-text')).toHaveText('/config');
});

test('Chat input matches slash command descriptions without selecting a command', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code' || target.appServerMode !== 'disabled', 'Uses the disconnected Chat shell.');
	const page = workbench.page;
	await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	const editor = page.locator('.ash-chat-input-editor');
	const input = editor.locator('.stanza-editor-input');
	await input.focus();
	await page.keyboard.insertText('/');
	await page.keyboard.type('settings');
	await expect(editor.locator('.stanza-editor-completion-label')).toHaveText(['/config']);
	await expect(editor.locator('.stanza-editor-completion-option.focused')).toHaveCount(0);
	await expect(editor.locator('.stanza-editor-completion-option')).toHaveAttribute('aria-selected', 'false');
	await expect(editor.locator('.stanza-editor-completion-detail strong')).toHaveText([...'settings']);
});
