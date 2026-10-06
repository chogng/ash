import { expect, test } from '../../../automation/test.js';
import { Editor } from '../../../automation/editor.js';

test('Cowork separates model settings from input actions and omits prompt, Agent and permission controls', async ({ target, workbench }) => {
	const page = await workbench.openAgentsWindow(target.kind);
	const composer = page.locator('.ash-sessions-cowork-input');
	const card = composer.locator('.ash-cowork-input-container');
	const editor = new Editor(card);
	const actions = card.locator('.ash-cowork-input-toolbars');
	const settings = composer.getByRole('toolbar', { name: 'Model and thinking effort', exact: true });
	const model = settings.locator('[data-action-id="ash.chat.input.model"] button');
	await expect(card).toBeVisible();
	await expect(card.locator('.stanza-editor-placeholder-text:visible')).toHaveCount(0);
	await expect(composer.locator('[data-action-id="ash.chat.input.mode"]')).toHaveCount(0);
	await expect(composer.getByRole('button', { name: /^Permissions:/u })).toHaveCount(0);
	await expect(card.locator('[data-action-id="ash.chat.input.model"]')).toHaveCount(0);
	await expect(actions.locator('[data-action-id="ash.chat.input.attach"] button')).toHaveAccessibleName('Attach files');
	await expect(actions.locator('[data-action-id="ash.chat.input.voice"] button')).toBeDisabled();
	await expect(model).toBeVisible();
	for (const width of [680, 280]) {
		await composer.evaluate((element, width) => { element.style.width = `${width}px`; }, width);
		await expect.poll(() => composer.evaluate(element => {
			const card = element.querySelector('.ash-cowork-input-container')!.getBoundingClientRect();
			const settings = element.querySelector('.ash-cowork-input-settings')!.getBoundingClientRect();
			const attach = element.querySelector('[data-action-id="ash.chat.input.attach"]')!.getBoundingClientRect();
			const mic = element.querySelector('[data-action-id="ash.chat.input.mic"]')!.getBoundingClientRect();
			const voice = element.querySelector('[data-action-id="ash.chat.input.voice"]')!.getBoundingClientRect();
			return {
				settingsBelowCard: settings.top >= card.bottom,
				settingsInsideComposer: settings.right <= element.getBoundingClientRect().right + 1,
				attachmentAtLeft: attach.right < card.left + card.width / 2,
				microphoneAtRight: mic.left > card.left + card.width / 2,
				voiceBesideMicrophone: voice.left >= mic.right && voice.right < card.right,
			};
		})).toEqual({ settingsBelowCard: true, settingsInsideComposer: true, attachmentAtLeft: true, microphoneAtRight: true, voiceBesideMicrophone: true });
	}
	await composer.evaluate(element => { element.style.removeProperty('width'); });
	await model.focus();
	await page.keyboard.press('ArrowDown');
	const picker = page.getByRole('dialog', { name: 'Choose a chat model', exact: true });
	await expect(picker).toBeVisible();
	if (target.appServerMode === 'required') {
		const automatic = picker.getByRole('switch', { name: 'Auto', exact: true });
		if (await automatic.isChecked()) { await automatic.press('Space'); }
		const search = picker.getByRole('combobox');
		await search.fill('GPT-6.1 Sol');
		await expect(picker.getByRole('option')).toHaveCount(1);
		const selectedModelName = await picker.getByRole('option').locator('.ash-quick-pick-row-label').innerText();
		await search.press('Enter');
		await expect(model).toHaveText(selectedModelName);
		const effort = settings.locator('[data-action-id="ash.chat.input.effort"] button');
		await effort.press('ArrowDown');
		const effortMenu = page.getByRole('menu', { name: 'Thinking Level', exact: true });
		await effortMenu.getByRole('menuitemradio', { name: 'High', exact: true }).click();
		await expect(effortMenu).toBeHidden();
		await expect(effort).toHaveText('High');
		await expect(effort).toBeFocused();
		await expect(card.locator('[data-action-id="ash.chat.input.effort"]')).toHaveCount(0);
		await model.press('ArrowDown');
		await expect(picker).toBeVisible();
	}
	await page.keyboard.press('Escape');
	await expect(picker).toBeHidden();
	await expect(model).toBeFocused();
	await editor.input.focus();
	await page.keyboard.insertText('Prepare a presentation');
	await expect(actions.locator('[data-action-id="ash.chat.input.send"] button')).toBeEnabled();
	await expect(settings).toBeVisible();
	await page.keyboard.press('Alt+F1');
	const help = page.locator('.ash-accessible-view-content');
	await expect(help).toHaveValue(/Model and thinking effort are below the card/u);
	await expect(help).not.toHaveValue(/reach attachments, Agent|Permissions menu/u);
	await page.keyboard.press('Escape');
	await editor.waitForEditorFocus();
});

test('Cowork model toolbar and input help use the Chinese display language', async ({ target, workbench, restartWorkbench }) => {
	await workbench.quickaccess.runCommand('workbench.action.configureLocale');
	const language = workbench.page.getByRole('dialog', { name: 'Select Display Language' }).getByRole('combobox');
	await language.fill('简体中文');
	await language.press('Enter');
	const restarted = await restartWorkbench();
	const page = await restarted.workbench.openAgentsWindow(target.kind);
	const composer = page.locator('.ash-sessions-cowork-input');
	await expect(composer.getByRole('toolbar', { name: '模型和思考强度', exact: true })).toBeVisible();
	await new Editor(composer).input.focus();
	await page.keyboard.press('Alt+F1');
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/模型和思考强度位于卡片下方/u);
	await page.keyboard.press('Escape');
});

test('Cowork and Code retain separate editors while transferring the selected draft and attachments', async ({ application, target, workbench }) => {
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
	await composer.locator('input[type="file"]').setInputFiles({ name: 'brief.txt', mimeType: 'text/plain', buffer: Buffer.from('Presentation brief') });
	await expect(composer.getByRole('button', { name: 'Remove brief.txt', exact: true })).toBeVisible();
	const identity = await conversation.locator('.ash-cowork').getAttribute('data-untitled-session-id');
	await navigation.getByRole('button', { name: 'Code', exact: true }).click();
	await expect(conversation.locator('.ash-chat')).toBeVisible();
	await expect(conversation.locator('.ash-cowork')).toHaveCount(0);
	await editor.waitForEditorContents(text => text === 'Prepare a presentation');
	await expect(conversation.locator('.ash-chat')).toHaveAttribute('data-untitled-session-id', identity!);
	expect(await editor.input.evaluate((input, previous) => input === previous, coworkInput)).toBe(false);
	await editor.input.focus();
	await page.keyboard.press('ControlOrMeta+A');
	await page.keyboard.insertText('Updated presentation brief');
	await navigation.getByRole('button', { name: 'Chat', exact: true }).click();
	await expect(conversation.locator('.ash-cowork')).toBeVisible();
	await editor.waitForEditorContents(text => text === 'Updated presentation brief');
	await expect(composer.getByRole('button', { name: 'Remove brief.txt', exact: true })).toBeVisible();
	expect(await editor.input.evaluate((input, previous) => input === previous, coworkInput)).toBe(true);
	await navigation.getByRole('button', { name: 'Collaboration', exact: true }).click();
	await expect(conversation.locator('.ash-cowork')).toBeVisible();
	await expect(page.locator('.ash-teams-panel')).toBeVisible();
	await navigation.getByRole('button', { name: 'Chat', exact: true }).click();
	await editor.input.focus();
	await page.keyboard.press('Alt+F1');
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/attach files|attachments/i);
	await page.keyboard.press('Escape');
	await editor.waitForEditorFocus();
	await coworkInput?.dispose();
	page = await workbench.reopenAgentsWindow(application, page);
	await expect(page.locator('[data-part="sessions"] .ash-cowork')).toBeVisible();
	await new Editor(page.locator('[data-part="sessions"]')).waitForEditorContents(text => text === 'Updated presentation brief');
	await expect(page.locator('.ash-sessions-cowork-input').getByRole('button', { name: 'Remove brief.txt', exact: true })).toBeVisible();
});
