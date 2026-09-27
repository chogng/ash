import { expect, test } from '../../../automation/test.js';

test('Empty chat keeps its input near the pane edges', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code' || target.appServerMode !== 'disabled', 'Uses the disconnected Chat shell.');
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const chat = page.locator('.ash-chat-view-pane .ash-chat:visible');
	await expect(chat).toHaveClass(/empty/u);
	const layout = await chat.evaluate(element => {
		const list = element.querySelector<HTMLElement>('.ash-chat-list-widget');
		const input = element.querySelector<HTMLElement>('.ash-chat-input-part');
		const composer = element.querySelector<HTMLElement>('.ash-chat-input-container');
		if (!list || !input || !composer) throw new Error('Chat layout is incomplete');
		const chatBounds = element.getBoundingClientRect();
		const composerBounds = composer.getBoundingClientRect();
		return {
			chatTop: chatBounds.top,
			listHeight: list.getBoundingClientRect().height,
			inputTop: input.getBoundingClientRect().top,
			composerTopInset: composerBounds.top - chatBounds.top,
			composerLeftInset: composerBounds.left - chatBounds.left,
			composerRightInset: chatBounds.right - composerBounds.right,
		};
	});
	expect(layout.listHeight).toBe(0);
	expect(layout.inputTop).toBeCloseTo(layout.chatTop, 0);
	expect(layout.composerTopInset).toBe(12);
	expect(layout.composerLeftInset).toBe(12);
	expect(layout.composerRightInset).toBe(12);
});

test('Chat input hides unused editor chrome and keeps its text evenly inset', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code' || target.appServerMode !== 'disabled', 'Uses the disconnected Chat shell.');
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const findOptions = page.locator('.ash-chat:visible .stanza-editor-find-options-widget');
	await expect(findOptions).toBeAttached();
	await expect(findOptions).toBeHidden();
	const editorChrome = await page.locator('.ash-chat:visible .ash-chat-input-editor').evaluate(editor => {
		const viewport = editor.querySelector<HTMLElement>('.stanza-editor');
		const placeholder = editor.querySelector<HTMLElement>('.stanza-editor-placeholder-text');
		const ruler = editor.querySelector<HTMLElement>('.decorationsOverviewRuler');
		const container = editor.closest<HTMLElement>('.ash-chat-input-container');
		const attachments = container?.querySelector<HTMLElement>('.ash-chat-input-attachments');
		if (!viewport || !placeholder || !ruler || !container || !attachments) throw new Error('Chat editor viewport is incomplete');
		const placeholderBounds = placeholder.getBoundingClientRect();
		const containerBounds = container.getBoundingClientRect();
		return {
			textInset: placeholderBounds.left - viewport.getBoundingClientRect().left,
			textTopInset: placeholderBounds.top - containerBounds.top,
			textLeftInset: placeholderBounds.left - containerBounds.left,
			attachmentsDisplay: getComputedStyle(attachments).display,
			rulerDisplay: getComputedStyle(ruler).display,
		};
	});
	expect(editorChrome.textInset).toBeLessThanOrEqual(4);
	expect(editorChrome.textTopInset).toBeCloseTo(editorChrome.textLeftInset, 0);
	expect(editorChrome.attachmentsDisplay).toBe('none');
	expect(editorChrome.rulerDisplay).toBe('none');
});

test('Chat input shows a round voice action when empty and a send arrow for text', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code' || target.appServerMode !== 'disabled', 'Uses the disconnected Chat shell.');
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const chat = page.locator('.ash-chat-view-pane .ash-chat:visible');
	const toolbar = chat.locator('.ash-chat-input-toolbars');
	await expect(toolbar.locator('[data-action-id="ash.chat.input.attachment"]')).toHaveCount(0);
	await expect(toolbar.locator('[data-action-id="ash.chat.input.mic"] button')).toHaveCount(1);
	const voiceButton = toolbar.locator('[data-action-id="ash.chat.input.voice"] button');
	await expect(voiceButton).toBeVisible();
	await expect(voiceButton.locator('[data-ash-icon-id="voice-mode"]')).toHaveCount(1);
	const shape = await voiceButton.evaluate(button => {
		const bounds = button.getBoundingClientRect();
		return { width: bounds.width, height: bounds.height, radius: getComputedStyle(button).borderRadius, background: getComputedStyle(button).backgroundColor };
	});
	expect(shape.width).toBe(shape.height);
	expect(shape.radius).toBe('50%');
	expect(shape.background).not.toBe('rgba(0, 0, 0, 0)');
	const input = chat.locator('.ash-chat-input-editor .stanza-editor-input');
	await input.focus();
	await page.keyboard.insertText('Hello');
	await expect(toolbar.locator('[data-action-id="ash.chat.input.voice"]')).toHaveCount(0);
	const sendButton = toolbar.locator('[data-action-id="ash.chat.input.send"] button');
	await expect(sendButton.locator('[data-ash-icon-id="arrow-up"]')).toHaveCount(1);
	await expect(sendButton).toHaveCSS('border-radius', '50%');
	await page.keyboard.press('ControlOrMeta+A');
	await page.keyboard.press('Backspace');
	await expect(toolbar.locator('[data-action-id="ash.chat.input.voice"] button')).toBeVisible();
});

test('Chat input resizes with wrapped text and retains keyboard focus', async ({ target, workbench }) => {
	test.skip(target.workbenchMode !== 'code' || target.appServerMode !== 'disabled', 'Uses the disconnected Chat shell.');
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
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
