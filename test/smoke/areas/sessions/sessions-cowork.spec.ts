import { expect, test } from '../../../automation/test.js';
import { Editor } from '../../../automation/editor.js';

test('Cowork shares Chat input operations with model settings on the right and no mode picker', async ({
	target,
	workbench,
}) => {
	const page = await workbench.openAgentsWindow(target.kind);
	const composer = page.locator('.ash-sessions-cowork-input');
	const card = composer.locator('.ash-chat-input-container');
	const editor = new Editor(card);
	const actions = card.getByRole('toolbar', { name: 'Chat input actions', exact: true });
	const model = actions.locator('.ash-chat-input-model-action');
	await expect(card).toBeVisible();
	await expect(card.locator('.stanza-editor-placeholder-text:visible')).toHaveCount(0);
	await expect(composer.locator('[data-action-id="ash.chat.input.mode"]')).toHaveCount(0);
	await expect(composer.getByRole('button', { name: /^Permissions:/u })).toHaveCount(0);
	await expect(card.locator('[data-action-id="ash.chat.input.model"]')).toHaveCount(1);
	await expect(actions.locator('[data-action-id="ash.chat.input.attach"] button')).toHaveAccessibleName(
		'Add context',
	);
	await expect(actions.locator('[data-action-id="ash.chat.input.voice"] button')).toBeDisabled();
	await expect(model).toBeVisible();
	await model.focus();
	await page.keyboard.press('ArrowDown');
	const picker = page.getByRole('dialog', { name: 'Choose a chat model', exact: true });
	await expect(picker).toBeVisible();
	if (target.appServerMode === 'required') {
		const automatic = picker.getByRole('switch', { name: 'Auto', exact: true });
		if (await automatic.isChecked()) {
			await automatic.press('Space');
		}
		const search = picker.getByRole('combobox');
		await search.fill('GPT-6.1 Sol');
		await expect(picker.getByRole('menuitemradio')).toHaveCount(1);
		const selectedModelName = await picker.getByRole('menuitemradio').locator('.ash-icon-label-text').innerText();
		await search.press('Enter');
		await expect(model).toHaveText(selectedModelName);
	}
	await page.keyboard.press('Escape');
	await expect(picker).toBeHidden();
	await expect(model).toBeFocused();
	await editor.input.focus();
	await page.keyboard.insertText('Prepare a presentation');
	await expect(actions.locator('[data-action-id="ash.chat.input.send"] button')).toBeEnabled();
	await expect(model).toBeVisible();
	await page.keyboard.press('Alt+F1');
	const help = page.locator('.ash-accessible-view-content');
	await expect(help).toHaveValue(/Enter sends; Shift\+Enter inserts a line/u);
	await page.keyboard.press('Escape');
	await editor.waitForEditorFocus();
});

test('Cowork shared input toolbar and help use the Chinese display language', async ({
	target,
	workbench,
	restartWorkbench,
}) => {
	await workbench.quickaccess.runCommand('workbench.action.configureLocale');
	const language = workbench.page.getByRole('dialog', { name: 'Select Display Language' }).getByRole('combobox');
	await language.fill('简体中文');
	await language.press('Enter');
	const restarted = await restartWorkbench();
	const page = await restarted.workbench.openAgentsWindow(target.kind);
	const composer = page.locator('.ash-sessions-cowork-input');
	await expect(composer.getByRole('toolbar', { name: '聊天输入操作', exact: true })).toBeVisible();
	const editor = new Editor(composer);
	await editor.waitForEditorFocus();
	await page.keyboard.insertText('中文输入帮助');
	const send = composer.locator('[data-action-id="ash.chat.input.send"] button');
	await send.focus();
	await page.keyboard.press('Alt+F1');
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/模型、模型选项、听写和发送位于右侧/u);
	await page.keyboard.press('Escape');
	await editor.waitForEditorFocus();
});

test('Cowork and Code retain separate editors while transferring the selected draft and attachments', async ({
	application,
	target,
	workbench,
}) => {
	let page = await workbench.openAgentsWindow(target.kind);
	const navigation = page.locator('.ash-sessions-activity-content');
	const conversation = page.locator('[data-part="sessions"]');
	await expect(conversation.locator('.ash-cowork')).toBeVisible();
	await expect(conversation.locator('.ash-chat')).toHaveCount(0);
	const editor = new Editor(conversation);
	await editor.waitForEditorFocus();
	await page.keyboard.insertText('Prepare a presentation');
	const coworkInput = await editor.input.elementHandle();
	const composer = conversation.locator('.ash-sessions-cowork-input');
	await composer
		.locator('input[type="file"]')
		.setInputFiles({ name: 'brief.txt', mimeType: 'text/plain', buffer: Buffer.from('Presentation brief') });
	await expect(composer.locator('.ash-chat-code-reference')).toHaveText('brief.txt');
	const identity = await conversation.locator('.ash-cowork').getAttribute('data-untitled-session-id');
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
	await expect(conversation.locator('.ash-chat')).toBeVisible();
	await expect(conversation.locator('.ash-cowork')).toHaveCount(0);
	await editor.waitForEditorContents(text => text === 'Prepare a presentation brief.txt ');
	await expect(conversation.locator('.ash-chat')).toHaveAttribute('data-untitled-session-id', identity!);
	expect(await editor.input.evaluate((input, previous) => input === previous, coworkInput)).toBe(false);
	await editor.input.focus();
	// References are atomic message text; replace only the prompt and retain its file.
	await page.keyboard.press('ControlOrMeta+A');
	await page.keyboard.press('ArrowLeft');
	for (const _ of 'Prepare a presentation') await page.keyboard.press('Shift+ArrowRight');
	await page.keyboard.insertText('Updated presentation brief');
	await navigation.getByRole('button', { name: 'Chat', exact: true }).click();
	await expect(conversation.locator('.ash-cowork')).toBeVisible();
	await editor.waitForEditorContents(text => text === 'Updated presentation brief brief.txt ');
	await expect(composer.locator('.ash-chat-code-reference')).toHaveText('brief.txt');
	expect(await editor.input.evaluate((input, previous) => input === previous, coworkInput)).toBe(true);
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
	await navigation.getByRole('button', { name: 'Collab', exact: true }).click();
	await expect(conversation.locator('.ash-cowork')).toBeVisible();
	await expect(page.locator('[data-part="sidebar"] [data-view-container-id="ash.collaboration"]')).toBeVisible();
	await navigation.getByRole('button', { name: 'Chat', exact: true }).click();
	await editor.input.focus();
	await page.keyboard.press('Alt+F1');
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/attach files|attachments/i);
	await page.keyboard.press('Escape');
	await editor.waitForEditorFocus();
	await coworkInput?.dispose();
	page = await workbench.reopenAgentsWindow(application, page);
	await expect(page.locator('[data-part="sessions"] .ash-cowork')).toBeVisible();
	await new Editor(page.locator('[data-part="sessions"]')).waitForEditorContents(
		text => text === 'Updated presentation brief brief.txt ',
	);
	await expect(page.locator('.ash-sessions-cowork-input .ash-chat-code-reference')).toHaveText('brief.txt');
});
