import { readUserSettings, writeUserSettings } from '../../../automation/settings.js';
import { expect, test } from '../../../automation/test.js';

test('Empty chat anchors its input to the bottom pane edge', async ({ workbench }) => {
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const chat = page.locator('.ash-chat-view-pane .ash-chat:visible');
	await expect(chat).toHaveClass(/empty/u);
	await expect(chat.locator('.ash-chat-model-preparation')).toHaveCount(0);
	const layout = await chat.evaluate(element => {
		const list = element.querySelector<HTMLElement>('.ash-chat-list-widget');
		const input = element.querySelector<HTMLElement>('.ash-chat-input-part');
		const composer = element.querySelector<HTMLElement>('.ash-chat-input-container');
		const toolbar = element.querySelector<HTMLElement>('.ash-chat-input-toolbars');
		const editor = element.querySelector<HTMLElement>('.ash-chat-input-editor');
		const action = element.querySelector<HTMLElement>('.ash-chat-input-mode-action');
		if (!list || !input || !composer || !toolbar || !editor || !action) throw new Error('Chat layout is incomplete');
		const chatBounds = element.getBoundingClientRect();
		const inputBounds = input.getBoundingClientRect();
		const composerBounds = composer.getBoundingClientRect();
		const editorBounds = editor.getBoundingClientRect();
		const toolbarBounds = toolbar.getBoundingClientRect();
		return {
			listHeight: list.getBoundingClientRect().height,
			inputBottomInset: chatBounds.bottom - inputBounds.bottom,
			composerTopInset: composerBounds.top - inputBounds.top,
			composerBottomInset: inputBounds.bottom - composerBounds.bottom,
			composerLeftInset: composerBounds.left - inputBounds.left,
			composerRightInset: inputBounds.right - composerBounds.right,
			composerHeight: composerBounds.height,
			editorTopInset: editorBounds.top - composerBounds.top,
			editorLeftInset: editorBounds.left - composerBounds.left,
			editorRightInset: composerBounds.right - editorBounds.right,
			toolbarLeftInset: toolbarBounds.left - composerBounds.left,
			toolbarRightInset: composerBounds.right - toolbarBounds.right,
			toolbarHeight: toolbar.getBoundingClientRect().height,
			actionHeight: action.getBoundingClientRect().height,
			actionBottomInset: composerBounds.bottom - action.getBoundingClientRect().bottom,
		};
	});
	expect(layout).toEqual({
		listHeight: 0,
		inputBottomInset: 0,
		composerTopInset: 4,
		composerBottomInset: 4,
		composerLeftInset: 12,
		composerRightInset: 12,
		composerHeight: 84,
		editorTopInset: 9,
		editorLeftInset: 9,
		editorRightInset: 9,
		toolbarLeftInset: 9,
		toolbarRightInset: 9,
		toolbarHeight: 22,
		actionHeight: 22,
		actionBottomInset: 9,
	});
});

test('Chat can switch from Plan back to Agent without selecting a different Agent', { tag: ['@browser-ui', '@electron-ui'] }, async ({ target, workbench }) => {
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const picker = page.locator('.ash-chat-view-pane .ash-chat:visible [data-action-id="ash.chat.input.mode"] button');
	await picker.press('ArrowDown');
	let menu = page.locator('.ash-chat-input-mode-menu');
	await menu.getByRole('menuitemradio', { name: 'Plan', exact: true }).click();
	await expect(picker).toHaveText('Plan');
	await picker.press('ArrowDown');
	menu = page.locator('.ash-chat-input-mode-menu');
	await expect(menu.getByRole('menuitemradio', { name: 'Plan', exact: true })).toHaveAttribute('aria-checked', 'true');
	await expect(menu.getByRole('menuitemradio', { name: 'Plan', exact: true })).toBeFocused();
	const agent = menu.getByRole('menuitemradio', { name: 'Agent', exact: true });
	await expect(agent).toBeEnabled();
	await agent.click();
	await expect(picker).toHaveText('Agent');
	await picker.press('ArrowDown');
	await expect(menu.getByRole('menuitemradio', { name: 'Agent', exact: true })).toHaveAttribute('aria-checked', 'true');
	await expect(menu.getByRole('menuitemradio', { name: 'Agent', exact: true })).toBeFocused();
	await menu.press('Escape');
	await expect(picker).toBeFocused();
});

test('Chat mode picker exposes all five modes with one checked selection', { tag: ['@browser-ui', '@electron-ui'] }, async ({ target, workbench }) => {
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const picker = page.locator('.ash-chat-view-pane .ash-chat:visible [data-action-id="ash.chat.input.mode"] button');
	for (const name of ['Agent', 'Plan', 'Debug', 'Multitask', 'Ask']) {
		await picker.press('ArrowDown');
		const menu = page.locator('.ash-chat-input-mode-menu');
		await menu.getByRole('menuitemradio', { name, exact: true }).click();
		await expect(picker).toHaveText(name);
		await picker.press('ArrowDown');
		await expect(menu.getByRole('menuitemradio', { name, exact: true })).toHaveAttribute('aria-checked', 'true');
		await expect(menu.getByRole('menuitemradio', { name, exact: true })).toBeFocused();
		// Agent choices are a separate radio group; the five mode actions have exactly one choice.
		await expect(menu.getByRole('menuitemradio', { name: /^(Agent|Plan|Debug|Multitask|Ask)$/ }).and(menu.locator('[aria-checked="true"]'))).toHaveCount(1);
		await menu.press('Escape');
		await expect(picker).toBeFocused();
	}
});

test('Chat mode picker keyboard help returns focus to its selected action', async ({ workbench }) => {
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const picker = page.locator('.ash-chat-view-pane .ash-chat:visible [data-action-id="ash.chat.input.mode"] button');
	await picker.press('ArrowDown');
	const widget = page.locator('.ash-action-widget.ash-chat-input-mode-menu');
	const agent = widget.getByRole('menuitemradio', { name: 'Agent', exact: true });
	await expect(agent).toBeFocused();
	await expect(agent).toHaveAttribute('aria-checked', 'true');
	await agent.press('Alt+F1');
	const help = page.getByRole('dialog', { name: 'Accessibility Help', exact: true });
	await expect(help).toBeVisible();
	await expect(help.getByRole('textbox')).toHaveValue(/Use Up and Down Arrow to move between available actions/);
	await help.press('Escape');
	await expect(help).toHaveCount(0);
	await expect(agent).toBeFocused();
	await agent.press('ArrowDown');
	await expect(widget.getByRole('menuitemradio', { name: 'Plan', exact: true })).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(widget).toHaveCount(0);
	await expect(picker).toBeFocused();
});

test('Desktop Chat guides a missing local model to Dictation settings without opening the microphone', { tag: ['@electron-app-server'] }, async ({ target, workbench }) => {
	const page = workbench.page;
	const original = await (async () => {
		return (await readUserSettings(page)).content;
	})();
	await (async () => {
		const snapshot = await readUserSettings(page);
		const settings = JSON.parse(snapshot.content) as Record<string, unknown>;
		settings['dictation.backend'] = 'local';
		settings['dictation.model'] = 'ash-playwright-missing-model';
		await writeUserSettings(page, JSON.stringify(settings), snapshot.revision);
	})();
	try {
		if (!await page.locator('.ash-chat-view-pane').isVisible()) {
			await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
		}
		const chat = page.locator('.ash-chat-view-pane .ash-chat:visible');
		const composer = chat.locator('.ash-chat-input-container');
		await expect(chat.locator('.ash-chat-model-preparation')).toHaveCount(0);
		await expect(composer).toHaveCSS('height', '84px');
		const input = chat.locator('.ash-chat-input-editor .stanza-editor-input');
		await input.focus();
		await page.keyboard.insertText('Keep this draft');
		const button = chat.locator('[data-action-id="workbench.action.chat.toggleSpeechToText"] button');
		await expect(button).toBeEnabled();
		await expect(button).toHaveAttribute('aria-label', 'Dictate message');
		await button.focus();
		await page.keyboard.press('Enter');
		const voice = page.getByRole('dialog', { name: 'Ash Settings' });
		await expect(voice.getByRole('grid', { name: 'Local dictation models' })).toBeVisible();
		await expect(chat.locator('.ash-chat-model-preparation')).toHaveCount(0);
		await expect(chat.locator('.stanza-editor-line-text')).toHaveText('Keep this draft');
		await expect(button).not.toHaveAttribute('aria-pressed', 'true');
		await expect(voice.getByRole('row').filter({ hasText: 'ash-playwright-missing-model' })).toBeVisible();
		const microphone = voice.getByRole('combobox', { name: 'Microphone', exact: true });
		const language = voice.getByRole('combobox', { name: 'Transcription language', exact: true });
		await expect(microphone).toBeEnabled();
		await expect(language).toBeDisabled();
		await microphone.click();
		await page.getByRole('option', { name: 'System default microphone', exact: true }).click();
		await voice.locator('[data-configuration-key="dictation.backend"]').getByRole('combobox').click();
		await page.getByRole('option', { name: 'Cloud', exact: true }).click();
		await expect(language).toBeEnabled();
		await language.focus();
		await page.keyboard.press('Home');
		await page.keyboard.press('Enter');
		await voice.locator('.ash-modal-editor-close').click();
		await expect(page.locator('.ash-chat-view-pane .ash-chat:visible .ash-chat-status')).not.toContainText('Could not read dictation model package');
		await expect(button).not.toHaveAttribute('aria-pressed', 'true');
		await expect(chat.locator('.ash-chat-model-preparation')).toHaveCount(0);
		await expect(composer).toHaveCSS('height', '84px');
		await expect(chat.locator('.stanza-editor-line-text')).toHaveText('Keep this draft');
		await button.focus();
		await workbench.quickaccess.runCommand('workbench.action.chat.dictation.showIntroduction');
		const introduction = page.getByRole('region', { name: 'Dictation introduction', exact: true });
		await expect(introduction).toBeVisible();
		await expect(introduction.getByRole('combobox', { name: 'Microphone', exact: true })).toBeEnabled();
		await introduction.getByRole('button', { name: 'Done', exact: true }).focus();
		await page.keyboard.press('Escape');
		await expect(introduction).toHaveCount(0);
	} finally {
		await (async source => {
			const snapshot = await readUserSettings(page);
			await writeUserSettings(page, source, snapshot.revision);
		})(original);
	}
});

test('Chat input grows upward with wrapped text and retains keyboard focus', { tag: ['@browser-ui', '@electron-ui'] }, async ({ target, workbench }) => {
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const host = page.locator('.ash-chat-input-editor-host');
	const editor = host.locator('.ash-chat-input-editor');
	const input = editor.locator('.stanza-editor-input');
	await expect(editor).toBeVisible();
	await expect(editor.locator('.stanza-editor-completion')).toHaveCount(1);
	const composer = page.locator('.ash-chat-view-pane .ash-chat:visible .ash-chat-input-container');
	const initialBounds = await composer.boundingBox();
	expect(initialBounds).not.toBeNull();
	await host.evaluate(element => element.style.width = '180px');
	await input.focus();
	await page.keyboard.insertText('word '.repeat(80));
	await expect(editor).toHaveCSS('height', '314px');
	await expect(input).toBeFocused();
	const expandedBounds = await composer.boundingBox();
	expect(expandedBounds).not.toBeNull();
	expect(expandedBounds!.y).toBeLessThan(initialBounds!.y);
	expect(expandedBounds!.y + expandedBounds!.height).toBeCloseTo(initialBounds!.y + initialBounds!.height, 0);

	await host.evaluate(element => element.style.width = '1000px');
	await expect.poll(() => editor.evaluate(element => element.getBoundingClientRect().height)).toBeLessThan(314);
	await expect(input).toBeFocused();

	await host.evaluate(element => element.style.width = '180px');
	await expect(editor).toHaveCSS('height', '314px');
	await page.keyboard.press('ControlOrMeta+A');
	await page.keyboard.press('Backspace');
	await expect(editor).toHaveCSS('height', '40px');
	await expect(input).toBeFocused();
	const restoredBounds = await composer.boundingBox();
	expect(restoredBounds).toEqual(initialBounds);
});

test('Chat input explicitly opens slash suggestions from the keyboard', { tag: ['@browser-ui', '@electron-ui'] }, async ({ target, workbench }) => {
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const editor = page.locator('.ash-chat-input-editor');
	const input = editor.locator('.stanza-editor-input');
	await input.focus();
	await page.keyboard.insertText('/history argument');
	await page.keyboard.press('Escape');
	await page.keyboard.press('Home');
	for (let index = 0; index < 3; index++) await page.keyboard.press('ArrowRight');
	await page.keyboard.press('Control+Space');
	await expect(editor.locator('.stanza-editor-completion-label').getByText('/history', { exact: true })).toBeVisible();
	await expect(editor.locator('.stanza-editor-completion-label').getByText('/config', { exact: true })).toBeVisible();
	await expect(input).toBeFocused();
});

test('Chat input returns to the empty message state when a slash command is deleted', { tag: ['@browser-ui', '@electron-ui'] }, async ({ target, workbench }) => {
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
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

test('Chat input suggests and completes a command with a missing character', { tag: ['@browser-ui', '@electron-ui'] }, async ({ target, workbench }) => {
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const editor = page.locator('.ash-chat-input-editor');
	const input = editor.locator('.stanza-editor-input');
	await input.focus();
	await page.keyboard.insertText('/');
	await expect(editor.locator('.stanza-editor-completion-label').getByText('/config', { exact: true })).toBeVisible();
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

test('Chat input matches slash command descriptions without selecting a command', { tag: ['@browser-ui', '@electron-ui'] }, async ({ target, workbench }) => {
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
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
