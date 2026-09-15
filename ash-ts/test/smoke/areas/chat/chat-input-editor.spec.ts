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
